#!/usr/bin/env bun
/**
 * Scheduled enrichment runner — processes files in $CHIBRAIN/_inbox/ by
 * invoking Claude Code with a signal-detector prompt and MCP gbrain tools.
 *
 * This is the agent-write half of the read-enrich-write loop:
 *   pullers drop signals (email, calendar, meetings) into _inbox/
 *   →  this script wakes Claude up on a schedule
 *   →  Claude reads each file, detects entities, updates wiki pages, archives
 *   →  watch re-ingests every change; brain stays fresh
 *
 * State: the filesystem is the state. A file in _inbox/ = unprocessed.
 * Claude moves it to _archive/ when done. Re-runs pick up whatever's left.
 *
 * Quiet hours: controlled by ~/.gbrain/enrichment-schedule.yaml. Outside
 * the allowed window, the script exits immediately so launchd can fire
 * frequently without generating noise.
 *
 * Usage:
 *   bun run scripts/enrichment/process-inbox.ts                # uses $CHIBRAIN
 *   bun run scripts/enrichment/process-inbox.ts /path/to/vault
 *   bun run scripts/enrichment/process-inbox.ts --dry-run     # print plan, don't invoke
 *   bun run scripts/enrichment/process-inbox.ts --force       # ignore quiet hours
 */

import { readdir, stat, readFile, appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';

const STATE_DIR = join(homedir(), '.gbrain');
const LOG_FILE = join(STATE_DIR, 'enrichment.jsonl');
const SCHEDULE_FILE = join(STATE_DIR, 'enrichment-schedule.yaml');

interface Schedule {
  allowedHours: [number, number] | null;   // [start, end) in local 24h. e.g. [9, 18]. null = always on.
  maxFilesPerRun: number;                    // cap to avoid big bursts. 0 = unlimited.
  agentCommand: string[];                    // e.g. ["claude", "--print"]
}

const DEFAULT_SCHEDULE: Schedule = {
  allowedHours: [8, 20],
  maxFilesPerRun: 20,
  agentCommand: ['claude', '--print'],
};

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const force = argv.includes('--force');
  const vault = argv.find(a => !a.startsWith('--')) ?? process.env.CHIBRAIN;

  if (!vault) {
    console.error('process-inbox: set $CHIBRAIN or pass vault path.');
    process.exit(1);
  }
  if (!existsSync(vault)) {
    console.error(`process-inbox: vault not a directory: ${vault}`);
    process.exit(1);
  }

  const schedule = await loadSchedule();

  if (!force && schedule.allowedHours) {
    const [start, end] = schedule.allowedHours;
    const hour = new Date().getHours();
    const inWindow = start <= end ? (hour >= start && hour < end) : (hour >= start || hour < end);
    if (!inWindow) {
      console.error(`process-inbox: outside allowed hours ${start}:00–${end}:00 (current ${hour}:00). Skipping.`);
      process.exit(0);
    }
  }

  const inbox = join(vault, '_inbox');
  if (!existsSync(inbox)) {
    console.error(`process-inbox: no _inbox/ directory at ${inbox}`);
    process.exit(0);
  }

  const files = await walkInbox(inbox);
  if (files.length === 0) {
    console.error('process-inbox: inbox empty, nothing to do');
    process.exit(0);
  }

  const batch = schedule.maxFilesPerRun > 0 ? files.slice(0, schedule.maxFilesPerRun) : files;
  console.error(
    `process-inbox: ${batch.length}/${files.length} file(s) ${dryRun ? '(dry-run)' : 'to process'}`,
  );

  if (dryRun) {
    for (const f of batch) console.error(`  ${relative(vault, f)}`);
    process.exit(0);
  }

  await mkdir(STATE_DIR, { recursive: true });

  let succeeded = 0;
  let failed = 0;
  for (const file of batch) {
    const rel = relative(vault, file);
    const startedAt = Date.now();
    try {
      const result = await runAgent(schedule.agentCommand, buildPrompt(vault, file, rel));
      await logEntry({
        ts: new Date().toISOString(),
        path: file,
        status: 'success',
        duration_ms: Date.now() - startedAt,
        output: truncate(result, 500),
      });
      console.error(`  ✓ ${rel}`);
      succeeded++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await logEntry({
        ts: new Date().toISOString(),
        path: file,
        status: 'error',
        duration_ms: Date.now() - startedAt,
        error: truncate(msg, 500),
      });
      console.error(`  ✗ ${rel} — ${msg.split('\n')[0]}`);
      failed++;
    }
  }

  console.error(`process-inbox: done. ${succeeded} succeeded, ${failed} failed, ${files.length - batch.length} queued for next run.`);
}

async function walkInbox(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    const entries = await readdir(dir);
    for (const name of entries) {
      if (name.startsWith('.')) continue;
      if (name === '_archive') continue;
      const full = join(dir, name);
      const s = await stat(full);
      if (s.isDirectory()) await walk(full);
      else if (name.endsWith('.md')) out.push(full);
    }
  }
  await walk(root);
  // Oldest first (stable processing order)
  const withMtime = await Promise.all(out.map(async p => ({ p, m: (await stat(p)).mtimeMs })));
  return withMtime.sort((a, b) => a.m - b.m).map(x => x.p);
}

async function loadSchedule(): Promise<Schedule> {
  if (!existsSync(SCHEDULE_FILE)) return DEFAULT_SCHEDULE;
  const text = await readFile(SCHEDULE_FILE, 'utf-8');
  const s: Schedule = { ...DEFAULT_SCHEDULE };
  const lines = text.split('\n');
  let cmdList: string[] | null = null;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '');
    const kv = line.match(/^([a-z_]+)\s*:\s*(.*?)\s*$/);
    if (kv && !line.startsWith(' ') && !line.startsWith('\t')) {
      cmdList = null;
      const [, key, value] = kv;
      if (key === 'allowed_hours') {
        if (!value || /^null|none$/i.test(value)) { s.allowedHours = null; continue; }
        const m = value.match(/^(\d+)\s*-\s*(\d+)$/);
        if (m) s.allowedHours = [Number(m[1]), Number(m[2])];
      }
      if (key === 'max_files_per_run') s.maxFilesPerRun = Number(value) || 0;
      if (key === 'agent_command' && !value) cmdList = [];
      if (key === 'agent_command' && value) s.agentCommand = splitShell(value);
    } else if (cmdList && /^\s*-\s/.test(line)) {
      cmdList.push(line.replace(/^\s*-\s+/, '').replace(/^["']|["']$/g, ''));
    }
  }
  if (cmdList && cmdList.length) s.agentCommand = cmdList;
  return s;
}

function splitShell(s: string): string[] {
  // Very simple shell-lex: respects double quotes.
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (const ch of s) {
    if (ch === '"') { inQ = !inQ; continue; }
    if (/\s/.test(ch) && !inQ) { if (cur) { out.push(cur); cur = ''; } continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function buildPrompt(vault: string, filePath: string, relPath: string): string {
  return `You are performing a scheduled enrichment pass on my brain (GBrain).

Brain root: ${vault}
This invocation processes ONE inbox file:
  Path: ${filePath}
  Relative: ${relPath}

Follow \`skills/signal-detector/SKILL.md\` and \`skills/brain-ops/SKILL.md\`:

1. Read the file at the path above (use the Bash or Read tool).
2. Detect entities mentioned: people, companies, meetings, deals, media.
3. For each entity:
   - Use MCP tool \`gbrain__search\` or \`gbrain__get_page\` to check if a page exists.
   - If the page exists: append a timeline entry with source attribution via
     \`gbrain__add_timeline_entry\`. Update \`compiled_truth\` via \`gbrain__put_page\`
     only when there is genuinely new factual info.
   - If the page does NOT exist and the entity is notable: create a stub via
     \`gbrain__put_page\` under the correct wiki (follow \`skills/_brain-filing-rules.md\`).
4. Maintain back-links (Iron Law): every mention creates a wikilink and the
   reverse edge via \`gbrain__add_link\` when appropriate.
5. When done, move the source file to the \`_archive/\` mirror path:
   source  = ${filePath}
   archive = ${filePath.replace('/_inbox/', '/_archive/')}
   Create parent dirs if needed, then move with \`mv\`. This is the completion
   signal — an unmoved file means "retry next run".
6. Output a one-line summary at the end like:
   Signals: 2 ideas, 5 entities (enriched → ffc/wiki/people/faraz-ghadooshahy,
   ffc/wiki/companies/wallis-bank), archived.

Be efficient. Minimize tool calls. Don't re-read the same page twice. If the
file is obviously noise (no entities, no signal), just archive it and move on.
`;
}

async function runAgent(cmd: string[], prompt: string): Promise<string> {
  const proc = Bun.spawn([...cmd], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  proc.stdin.write(prompt);
  await proc.stdin.end();

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exit = await proc.exited;
  if (exit !== 0) {
    throw new Error(`agent exited ${exit}: ${stderr.slice(0, 500) || stdout.slice(0, 500)}`);
  }
  return stdout;
}

async function logEntry(entry: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(LOG_FILE), { recursive: true });
  await appendFile(LOG_FILE, JSON.stringify(entry) + '\n');
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

main().catch(e => {
  console.error(`process-inbox: ${e instanceof Error ? e.stack ?? e.message : e}`);
  process.exit(1);
});

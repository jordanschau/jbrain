/**
 * gbrain obsidian <vault> [--no-embed] [--no-links] [--no-tags] [--watch] [--interval N]
 *
 * One-shot Obsidian vault ingest:
 *   1. Walk the vault, import every .md as a page (path-derived slug)
 *   2. Pass 2: extract [[wikilinks]] and create typed edges
 *   3. Pass 3: extract body #tags (frontmatter tags already picked up in step 1)
 *   4. Optional --watch: re-ingest changed files on fs events
 *
 * Skips: .obsidian/ (config), .trash/, files that start with _ or .,
 * any path containing node_modules. Files >5MB are rejected upstream.
 */

import { readFileSync, readdirSync, lstatSync, existsSync, statSync, watch } from 'fs';
import { join, relative } from 'path';
import type { BrainEngine } from '../core/engine.ts';
import { importFromFile } from '../core/import-file.ts';
import { slugifyPath } from '../core/sync.ts';
import { extractWikilinks, resolveWikilink } from '../core/obsidian/wikilinks.ts';
import { extractBodyTags } from '../core/obsidian/tags.ts';

const SKIP_DIRS = new Set(['.obsidian', '.trash', '.git', 'node_modules']);

export async function runObsidian(engine: BrainEngine, args: string[]): Promise<void> {
  const vault = args.find(a => !a.startsWith('--'));
  if (!vault) {
    console.error('Usage: gbrain obsidian <vault> [--no-embed] [--no-links] [--no-tags] [--watch] [--interval N]');
    process.exit(1);
  }
  if (!existsSync(vault) || !statSync(vault).isDirectory()) {
    console.error(`Vault not found or not a directory: ${vault}`);
    process.exit(1);
  }

  const opts = {
    noEmbed: args.includes('--no-embed'),
    noLinks: args.includes('--no-links'),
    noTags: args.includes('--no-tags'),
    watch: args.includes('--watch'),
    interval: parseInt(args[args.indexOf('--interval') + 1] ?? '0', 10),
  };

  await ingestVault(engine, vault, opts);

  if (opts.watch) {
    console.log(`\nWatching ${vault} for changes. Ctrl-C to stop.`);
    watchVault(engine, vault, opts);
    // Hold the process open indefinitely while the watcher runs.
    await new Promise(() => { /* never resolves */ });
  }
}

interface IngestOpts {
  noEmbed: boolean;
  noLinks: boolean;
  noTags: boolean;
}

async function ingestVault(engine: BrainEngine, vault: string, opts: IngestOpts): Promise<void> {
  const files = walkVault(vault);
  console.log(`Found ${files.length} markdown files in ${vault}`);

  // Pass 1: import files.
  let imported = 0, skipped = 0, errors = 0;
  for (let i = 0; i < files.length; i++) {
    const { path, relPath } = files[i];
    try {
      const result = await importFromFile(engine, path, relPath, { noEmbed: opts.noEmbed });
      if (result.status === 'imported') imported++;
      else if (result.status === 'skipped') skipped++;
      else errors++;
      if (result.error && result.status === 'skipped') {
        console.warn(`  skip ${relPath}: ${result.error}`);
      }
    } catch (e) {
      errors++;
      console.error(`  error ${relPath}: ${e instanceof Error ? e.message : e}`);
    }
    if ((i + 1) % 25 === 0 || i === files.length - 1) {
      process.stdout.write(`\r  ${i + 1}/${files.length} files  (imported ${imported}, skipped ${skipped}, errors ${errors})`);
    }
  }
  process.stdout.write('\n');

  // Build the slug set AFTER import so wikilinks resolve against the fresh brain state.
  const allSlugs = new Set<string>(files.map(f => slugifyPath(f.relPath)));

  if (!opts.noLinks) {
    const created = await linkPass(engine, files, allSlugs);
    console.log(`Links: created ${created} wikilink edges`);
  }

  if (!opts.noTags) {
    const created = await tagPass(engine, files);
    console.log(`Tags: added ${created} body-tag associations`);
  }
}

async function linkPass(
  engine: BrainEngine,
  files: { path: string; relPath: string }[],
  allSlugs: Set<string>,
): Promise<number> {
  let created = 0;
  for (const { path, relPath } of files) {
    const slug = slugifyPath(relPath);
    let content: string;
    try { content = readFileSync(path, 'utf-8'); } catch { continue; }

    const seen = new Set<string>();
    for (const link of extractWikilinks(content)) {
      if (link.isEmbed) continue; // attachments, not page links
      const resolved = resolveWikilink(link.target, allSlugs);
      if (!resolved || resolved === slug) continue;
      const key = `${slug}::${resolved}`;
      if (seen.has(key)) continue;
      seen.add(key);

      try {
        const context = link.alias ? `[[${link.target}|${link.alias}]]` : `[[${link.target}]]`;
        await engine.addLink(slug, resolved, context, 'wikilink');
        created++;
      } catch { /* UNIQUE conflict or page missing — skip */ }
    }
  }
  return created;
}

async function tagPass(
  engine: BrainEngine,
  files: { path: string; relPath: string }[],
): Promise<number> {
  let added = 0;
  for (const { path, relPath } of files) {
    const slug = slugifyPath(relPath);
    let content: string;
    try { content = readFileSync(path, 'utf-8'); } catch { continue; }

    for (const tag of extractBodyTags(content)) {
      try {
        await engine.addTag(slug, tag);
        added++;
      } catch { /* UNIQUE conflict — tag already attached */ }
    }
  }
  return added;
}

function walkVault(vault: string): { path: string; relPath: string }[] {
  const out: { path: string; relPath: string }[] = [];
  function walk(dir: string) {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      if (name.startsWith('.')) continue;
      if (name.startsWith('_')) continue;
      const full = join(dir, name);
      let stat;
      try { stat = lstatSync(full); } catch { continue; }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) { walk(full); continue; }
      if (name.endsWith('.md')) {
        out.push({ path: full, relPath: relative(vault, full) });
      }
    }
  }
  walk(vault);
  return out;
}

function watchVault(
  engine: BrainEngine,
  vault: string,
  opts: IngestOpts,
): void {
  // Debounce per-file to collapse rapid save bursts (editors often fire
  // multiple rename/change events per save).
  const pending = new Map<string, NodeJS.Timeout>();
  const DEBOUNCE_MS = 400;

  watch(vault, { recursive: true }, (_event, filename) => {
    if (!filename || !filename.endsWith('.md')) return;
    if (filename.startsWith('.') || filename.startsWith('_')) return;
    if ([...SKIP_DIRS].some(d => filename.startsWith(`${d}/`) || filename.includes(`/${d}/`))) return;

    const existing = pending.get(filename);
    if (existing) clearTimeout(existing);
    pending.set(filename, setTimeout(() => {
      pending.delete(filename);
      void reingestOne(engine, vault, filename, opts);
    }, DEBOUNCE_MS));
  });
}

async function reingestOne(
  engine: BrainEngine,
  vault: string,
  relPath: string,
  opts: IngestOpts,
): Promise<void> {
  const full = join(vault, relPath);
  if (!existsSync(full)) return; // file was deleted; leave DB as-is for now
  try {
    const result = await importFromFile(engine, full, relPath, { noEmbed: opts.noEmbed });
    if (result.status === 'imported') {
      console.log(`  ${new Date().toISOString()} reingested ${relPath} (${result.chunks} chunks)`);
    }
  } catch (e) {
    console.error(`  reingest error on ${relPath}: ${e instanceof Error ? e.message : e}`);
  }
}

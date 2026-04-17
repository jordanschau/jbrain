#!/usr/bin/env bun
/**
 * Calendar backfill — one-shot pull of past events across all configured
 * calendars, grouped into one markdown digest file per month.
 *
 * Output: $CHIBRAIN/_inbox/calendar/backfill-YYYY-MM.md, one file per month
 * in the range. Watch ingests each file as a separate page, so search
 * queries like "who did I meet with last September" hit the right chunk.
 *
 * Usage:
 *   bun run scripts/pullers/calendar-backfill.ts --days 365 [vault]
 *   bun run scripts/pullers/calendar-backfill.ts --since 2025-04-17 --until 2026-04-17 [vault]
 *   bun run scripts/pullers/calendar-backfill.ts --force --days 90 [vault]   # overwrite existing
 *
 * Idempotent: skips months whose file already exists unless --force.
 * Reads ~/.gbrain/calendar-sources.yaml for the calendar filter (same as
 * calendar-puller.ts).
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  readFilterConfig,
  listCalendars,
  selectCalendars,
  pullAllEvents,
  applyFilters,
  renderEventBullet,
  startDate,
  localDateString,
  localMonthString,
  yamlQuote,
  type TaggedEvent,
  type CalendarListEntry,
} from './gcal.ts';

interface Args {
  vault: string;
  since: Date;
  until: Date;
  force: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let vault: string | undefined;
  let since: Date | undefined;
  let until: Date | undefined;
  let days: number | undefined;
  let force = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--days') { days = Number(argv[++i]); continue; }
    if (a === '--since') { since = new Date(argv[++i]); continue; }
    if (a === '--until') { until = new Date(argv[++i]); continue; }
    if (a === '--force') { force = true; continue; }
    if (a.startsWith('--')) {
      console.error(`Unknown flag: ${a}`);
      process.exit(1);
    }
    if (!vault) vault = a;
  }

  vault = vault ?? process.env.CHIBRAIN;
  if (!vault) {
    console.error('Usage: calendar-backfill.ts [--days N | --since DATE --until DATE] [--force] [vault]');
    process.exit(1);
  }
  if (!existsSync(vault)) {
    console.error(`vault not a directory: ${vault}`);
    process.exit(1);
  }

  const now = new Date();
  if (!until) until = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (!since) {
    if (!days) {
      console.error('Must pass either --days N or --since DATE');
      process.exit(1);
    }
    since = new Date(until.getTime() - days * 24 * 60 * 60 * 1000);
  }
  if (since >= until) {
    console.error('--since must be before --until');
    process.exit(1);
  }

  return { vault, since, until, force };
}

async function main() {
  const { vault, since, until, force } = parseArgs();

  const filter = readFilterConfig();
  const allCals = await listCalendars();
  const calendars = selectCalendars(allCals, filter.include);
  if (calendars.length === 0) {
    console.error('no calendars matched (check ~/.gbrain/calendar-sources.yaml)');
    process.exit(1);
  }

  console.error(
    `backfill: ${since.toISOString().slice(0, 10)} → ${until.toISOString().slice(0, 10)} ` +
    `from ${calendars.length} calendar(s)`,
  );

  const raw = await pullAllEvents(
    calendars,
    since.toISOString(),
    until.toISOString(),
    (cal, n) => console.error(`  ${cal.summary}: ${n} event(s)`),
  );
  const events = applyFilters(raw, filter);
  console.error(
    `backfill: ${events.length} unique event(s) in window` +
    (raw.length !== events.length ? ` (filtered ${raw.length - events.length} noisy)` : ''),
  );

  // Group by YYYY-MM of start date
  const byMonth = new Map<string, TaggedEvent[]>();
  for (const ev of events) {
    const key = localMonthString(startDate(ev));
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key)!.push(ev);
  }

  const outdir = join(vault, '_inbox', 'calendar');
  await mkdir(outdir, { recursive: true });

  let written = 0, skipped = 0;
  for (const [month, list] of [...byMonth.entries()].sort()) {
    const outfile = join(outdir, `backfill-${month}.md`);
    if (existsSync(outfile) && !force) {
      console.error(`  ${month}: skip (exists; pass --force to overwrite)`);
      skipped++;
      continue;
    }
    await writeFile(outfile, renderMonth(month, list, calendars), 'utf-8');
    console.error(`  ${month}: wrote ${list.length} event(s) → ${outfile}`);
    written++;
  }

  console.error(`backfill done: wrote ${written} file(s), skipped ${skipped}`);
}

function renderMonth(
  month: string,
  events: TaggedEvent[],
  calendars: CalendarListEntry[],
): string {
  const [year, mm] = month.split('-');
  const monthLabel = new Date(`${month}-01T00:00:00`).toLocaleString('en-US', { month: 'long', year: 'numeric' });
  const windowStart = `${month}-01T00:00:00Z`;
  const lastDay = new Date(Number(year), Number(mm), 0).getDate();
  const windowEnd = `${month}-${String(lastDay).padStart(2, '0')}T23:59:59Z`;

  const frontmatter = [
    '---',
    'type: journal-digest',
    `title: Calendar Backfill — ${monthLabel}`,
    'tags: [calendar, _inbox, backfill]',
    'source: calendar-backfill',
    `pulled_at: ${new Date().toISOString()}`,
    `window_start: ${windowStart}`,
    `window_end: ${windowEnd}`,
    `calendars: [${calendars.map(c => yamlQuote(c.summary)).join(', ')}]`,
    '---',
    '',
  ].join('\n');

  const header = [
    `# Calendar Backfill — ${monthLabel}`,
    '',
    `Historical pull from Google Calendar via gws. ${events.length} unique event(s).`,
    `Agent should mine this for meetings worth promoting into dedicated pages`,
    `under the right wiki, then leave this digest in place as an archive.`,
    '',
  ].join('\n');

  // Group by day within the month
  const byDay = new Map<string, TaggedEvent[]>();
  for (const ev of events) {
    const key = localDateString(startDate(ev));
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(ev);
  }

  const sections: string[] = [];
  for (const [date, list] of [...byDay.entries()].sort()) {
    sections.push(`## ${date}\n`);
    for (const ev of list) sections.push(renderEventBullet(ev));
    sections.push('');
  }

  return frontmatter + header + sections.join('\n');
}

main().catch(e => {
  console.error(`backfill: ${e instanceof Error ? e.stack ?? e.message : e}`);
  process.exit(1);
});

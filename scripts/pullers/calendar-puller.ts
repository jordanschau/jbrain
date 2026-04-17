#!/usr/bin/env bun
/**
 * Multi-calendar Google Calendar puller using the Google Workspace CLI (`gws`).
 *
 * Writes today's + tomorrow's events (across all calendars the authed account
 * can see) into $CHIBRAIN/_inbox/calendar/YYYY-MM-DD.md. The watch loop picks
 * it up; the enrichment agent triages into proper meeting pages.
 *
 * For one-shot historical pulls across many months, see calendar-backfill.ts.
 *
 * Multi-account strategy:
 *   `gws` holds one auth at a time. To aggregate calendars across several
 *   Google accounts, share them INTO the authed account via Google Calendar UI
 *   (Settings → Share with specific people → {your primary account}). Once
 *   shared, they appear in `calendarList list` and get pulled automatically.
 *
 * Usage:
 *   bun run scripts/pullers/calendar-puller.ts                # uses $CHIBRAIN
 *   bun run scripts/pullers/calendar-puller.ts /path/to/vault
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
  yamlQuote,
  type TaggedEvent,
  type CalendarListEntry,
} from './gcal.ts';

async function main() {
  const vault = process.argv[2] ?? process.env.CHIBRAIN;
  if (!vault) {
    console.error('calendar-puller: no vault path. Pass as arg or set $CHIBRAIN.');
    process.exit(1);
  }
  if (!existsSync(vault)) {
    console.error(`calendar-puller: vault not a directory: ${vault}`);
    process.exit(1);
  }

  // Window: start of today → end of tomorrow (48h)
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfTomorrow = new Date(startOfToday.getTime() + 2 * 24 * 60 * 60 * 1000);
  const timeMin = startOfToday.toISOString();
  const timeMax = endOfTomorrow.toISOString();

  const filter = readFilterConfig();
  const allCals = await listCalendars();
  const calendars = selectCalendars(allCals, filter.include);
  if (calendars.length === 0) {
    console.error('calendar-puller: no calendars matched (check ~/.gbrain/calendar-sources.yaml).');
    process.exit(1);
  }

  console.error(`calendar-puller: pulling ${calendars.length} calendar(s)...`);
  const raw = await pullAllEvents(
    calendars,
    timeMin,
    timeMax,
    (cal, n) => console.error(`  ${cal.summary}: ${n} event(s)`),
  );
  const unique = applyFilters(raw, filter);
  if (raw.length !== unique.length) {
    console.error(`calendar-puller: filtered ${raw.length - unique.length} noisy event(s)`);
  }

  const today = localDateString(now);
  const outdir = join(vault, '_inbox', 'calendar');
  const outfile = join(outdir, `${today}.md`);
  await mkdir(outdir, { recursive: true });
  await writeFile(outfile, renderMarkdown(today, timeMin, timeMax, calendars, unique), 'utf-8');

  console.error(`calendar-puller: wrote ${outfile} (${unique.length} unique event(s))`);
}

function renderMarkdown(
  today: string,
  timeMin: string,
  timeMax: string,
  calendars: CalendarListEntry[],
  events: TaggedEvent[],
): string {
  const frontmatter = [
    '---',
    'type: journal-digest',
    `title: Calendar — ${today}`,
    'tags: [calendar, _inbox]',
    'source: calendar-puller',
    `pulled_at: ${new Date().toISOString()}`,
    `window_start: ${timeMin}`,
    `window_end: ${timeMax}`,
    `calendars: [${calendars.map(c => yamlQuote(c.summary)).join(', ')}]`,
    '---',
    '',
  ].join('\n');

  const header = [
    `# Calendar — ${today}`,
    '',
    `Auto-pulled from Google Calendar via gws (${calendars.length} calendar(s)).`,
    'Agent should triage new meetings into proper meeting pages under the right',
    'wiki, then archive this file.',
    '',
  ].join('\n');

  if (events.length === 0) return frontmatter + header + '\n_No events in the next 48 hours._\n';

  const groups = new Map<string, TaggedEvent[]>();
  for (const ev of events) {
    const key = localDateString(startDate(ev));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(ev);
  }

  const sections: string[] = [];
  for (const [date, list] of [...groups.entries()].sort()) {
    const label = date === today ? `Today — ${date}` : `Tomorrow — ${date}`;
    sections.push(`## ${label}\n`);
    for (const ev of list) sections.push(renderEventBullet(ev));
    sections.push('');
  }

  return frontmatter + header + sections.join('\n');
}

main().catch(e => {
  console.error(`calendar-puller: ${e instanceof Error ? e.stack ?? e.message : e}`);
  process.exit(1);
});

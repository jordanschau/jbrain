#!/usr/bin/env bun
/**
 * Multi-calendar Google Calendar puller using the Google Workspace CLI (`gws`).
 *
 * Writes today's + tomorrow's events (across all calendars the authed account
 * can see) into $CHIBRAIN/_inbox/calendar/YYYY-MM-DD.md. The watch loop picks
 * it up; the enrichment agent triages into proper meeting pages.
 *
 * Multi-account strategy:
 *   `gws` holds one auth at a time. To aggregate calendars across several
 *   Google accounts, share them INTO the authed account via Google Calendar UI
 *   (Settings → Share with specific people → {your primary account}). Once
 *   shared, they appear in `calendarList list` and get pulled automatically.
 *
 *   To restrict which calendars get pulled, create ~/.gbrain/calendar-sources.yaml:
 *
 *     include:
 *       - primary
 *       - abc123@group.calendar.google.com   # specific calendar from another account
 *       - xyz789@group.calendar.google.com
 *
 *   Without that file, every calendar `calendarList` returns is pulled.
 *
 * Usage:
 *   bun run scripts/pullers/calendar-puller.ts                # uses $CHIBRAIN
 *   bun run scripts/pullers/calendar-puller.ts /path/to/vault
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface CalendarListEntry {
  id: string;
  summary: string;
  primary?: boolean;
  accessRole: string;
  timeZone?: string;
  backgroundColor?: string;
}

interface CalendarEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start: { date?: string; dateTime?: string; timeZone?: string };
  end: { date?: string; dateTime?: string; timeZone?: string };
  attendees?: { email: string; displayName?: string; responseStatus?: string }[];
  organizer?: { email: string; displayName?: string };
  htmlLink?: string;
  recurringEventId?: string;
  status?: string;
}

interface TaggedEvent extends CalendarEvent {
  _calendarLabel: string;
  _calendarId: string;
}

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

  // Resolve the pull window: start of today → end of tomorrow (48-hour window)
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfTomorrow = new Date(startOfToday.getTime() + 2 * 24 * 60 * 60 * 1000);
  const timeMin = startOfToday.toISOString();
  const timeMax = endOfTomorrow.toISOString();

  const include = await readIncludeList();
  const calendars = await listCalendars();
  const selected = include.length
    ? calendars.filter(c => include.includes(c.id) || include.includes(c.summary))
    : calendars;

  if (selected.length === 0) {
    console.error('calendar-puller: no calendars matched (check ~/.gbrain/calendar-sources.yaml).');
    process.exit(1);
  }

  console.error(`calendar-puller: pulling ${selected.length} calendar(s)...`);

  const allEvents: TaggedEvent[] = [];
  for (const cal of selected) {
    try {
      const events = await listEvents(cal.id, timeMin, timeMax);
      for (const ev of events) {
        allEvents.push({ ...ev, _calendarLabel: cal.summary, _calendarId: cal.id });
      }
      console.error(`  ${cal.summary}: ${events.length} event(s)`);
    } catch (e) {
      console.error(`  ${cal.summary}: FAILED — ${e instanceof Error ? e.message : e}`);
    }
  }

  // Dedup by event id (cross-calendar invites land on both sides of the share)
  const byId = new Map<string, TaggedEvent>();
  for (const ev of allEvents) {
    // Prefer the primary calendar's copy when duplicated
    if (!byId.has(ev.id) || ev._calendarId === 'primary') byId.set(ev.id, ev);
  }
  const unique = [...byId.values()].sort(sortByStart);

  const today = localDateString(now);
  const outdir = join(vault, '_inbox', 'calendar');
  const outfile = join(outdir, `${today}.md`);
  await mkdir(outdir, { recursive: true });
  await writeFile(outfile, renderMarkdown(today, timeMin, timeMax, selected, unique), 'utf-8');

  console.error(`calendar-puller: wrote ${outfile} (${unique.length} unique event(s))`);
}

async function readIncludeList(): Promise<string[]> {
  const path = join(homedir(), '.gbrain', 'calendar-sources.yaml');
  if (!existsSync(path)) return [];
  const text = await readFile(path, 'utf-8');
  // Tiny YAML parser — we only support `include:` + dashed list.
  const lines = text.split('\n');
  const include: string[] = [];
  let inInclude = false;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '');
    if (/^include\s*:/.test(line)) { inInclude = true; continue; }
    if (inInclude) {
      const m = line.match(/^\s*-\s+(.+?)\s*$/);
      if (m) { include.push(m[1].replace(/^["']|["']$/g, '')); continue; }
      if (/^\S/.test(line)) break; // new top-level key
    }
  }
  return include;
}

async function gws(args: string[]): Promise<unknown> {
  const proc = Bun.spawn(['gws', ...args], { stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exit = await proc.exited;
  if (exit !== 0) {
    throw new Error(`gws ${args.join(' ')} failed (exit ${exit}): ${stderr || stdout}`);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`gws returned non-JSON: ${stdout.slice(0, 200)}`);
  }
}

async function listCalendars(): Promise<CalendarListEntry[]> {
  const data = await gws(['calendar', 'calendarList', 'list', '--params', '{}']) as {
    items?: CalendarListEntry[];
  };
  return (data.items ?? []).filter(c => c.accessRole !== 'freeBusyReader');
}

async function listEvents(calendarId: string, timeMin: string, timeMax: string): Promise<CalendarEvent[]> {
  const params = JSON.stringify({
    calendarId, timeMin, timeMax,
    singleEvents: true, orderBy: 'startTime', maxResults: 250,
  });
  const data = await gws(['calendar', 'events', 'list', '--params', params]) as {
    items?: CalendarEvent[];
  };
  return (data.items ?? []).filter(e => e.status !== 'cancelled');
}

function sortByStart(a: CalendarEvent, b: CalendarEvent): number {
  const av = a.start.dateTime ?? a.start.date ?? '';
  const bv = b.start.dateTime ?? b.start.date ?? '';
  return av.localeCompare(bv);
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
    `calendars: [${calendars.map(c => quote(c.summary)).join(', ')}]`,
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

  // Group by local date so "today" and "tomorrow" are visually separated.
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
    for (const ev of list) sections.push(renderEvent(ev));
    sections.push('');
  }

  return frontmatter + header + sections.join('\n');
}

function renderEvent(ev: TaggedEvent): string {
  const title = (ev.summary ?? '(no title)').replace(/\n/g, ' ');
  const timeRange = formatTimeRange(ev);
  const attendees = (ev.attendees ?? [])
    .map(a => a.displayName || a.email)
    .filter(Boolean)
    .join(', ');

  const parts = [`- **${timeRange}** ${title}`];
  parts.push(`_${ev._calendarLabel}_`);
  if (attendees) parts.push(attendees);
  if (ev.location) parts.push(ev.location);
  if (ev.htmlLink) parts.push(`[gcal](${ev.htmlLink})`);

  return parts.join(' · ');
}

function formatTimeRange(ev: CalendarEvent): string {
  if (ev.start.date && !ev.start.dateTime) return '(all-day)';
  const start = new Date(ev.start.dateTime!);
  const end = new Date(ev.end.dateTime!);
  return `${formatTime(start)}–${formatTime(end)}`;
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
    .replace(' ', '');
}

function startDate(ev: CalendarEvent): Date {
  if (ev.start.dateTime) return new Date(ev.start.dateTime);
  if (ev.start.date) return new Date(ev.start.date + 'T00:00:00');
  return new Date();
}

function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function quote(s: string): string {
  return '"' + s.replace(/"/g, '\\"') + '"';
}

main().catch(e => {
  console.error(`calendar-puller: ${e instanceof Error ? e.stack ?? e.message : e}`);
  process.exit(1);
});

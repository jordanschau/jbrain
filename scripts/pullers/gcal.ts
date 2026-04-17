/**
 * Shared helpers for the calendar pullers. Wraps the Google Workspace CLI
 * (`gws`) and renders events to markdown bullets.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CalendarListEntry {
  id: string;
  summary: string;
  primary?: boolean;
  accessRole: string;
  timeZone?: string;
}

export interface CalendarEvent {
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

export interface TaggedEvent extends CalendarEvent {
  _calendarLabel: string;
  _calendarId: string;
}

export interface FilterConfig {
  include: string[];
  excludePatterns: RegExp[];
  skipDeclined: boolean;
  skipAllDay: boolean;
}

export function readFilterConfig(): FilterConfig {
  const path = join(homedir(), '.gbrain', 'calendar-sources.yaml');
  const config: FilterConfig = {
    include: [],
    excludePatterns: [],
    skipDeclined: true,
    skipAllDay: false,
  };
  if (!existsSync(path)) return config;

  const lines = readFileSync(path, 'utf-8').split('\n');
  let section: 'include' | 'exclude_patterns' | null = null;

  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '');
    // List sections
    if (/^include\s*:/.test(line)) { section = 'include'; continue; }
    if (/^exclude_patterns\s*:/.test(line)) { section = 'exclude_patterns'; continue; }

    // Scalar top-level keys
    const kv = line.match(/^([a-z_]+)\s*:\s*(.+?)\s*$/);
    if (kv && !line.startsWith(' ')) {
      section = null;
      if (kv[1] === 'skip_declined') config.skipDeclined = /^true$/i.test(kv[2]);
      if (kv[1] === 'skip_all_day') config.skipAllDay = /^true$/i.test(kv[2]);
      continue;
    }

    if (section) {
      const m = line.match(/^\s*-\s+(.+?)\s*$/);
      if (m) {
        const value = m[1].replace(/^["']|["']$/g, '');
        if (section === 'include') config.include.push(value);
        else if (section === 'exclude_patterns') {
          try { config.excludePatterns.push(new RegExp(value, 'i')); }
          catch (e) { console.error(`invalid regex in exclude_patterns: "${value}"`); }
        }
      } else if (/^\S/.test(line)) {
        section = null;
      }
    }
  }
  return config;
}

/** Backwards-compat shim — existing callers only needed the include list. */
export function readIncludeList(): string[] {
  return readFilterConfig().include;
}

/** Apply noise filters to a list of events. Returns the events that pass. */
export function applyFilters(events: TaggedEvent[], config: FilterConfig): TaggedEvent[] {
  return events.filter(ev => {
    const title = ev.summary ?? '';
    if (config.excludePatterns.some(p => p.test(title))) return false;

    if (config.skipAllDay && ev.start.date && !ev.start.dateTime) return false;

    if (config.skipDeclined) {
      // If the user is listed as an attendee and their responseStatus is declined, skip.
      const me = ev.attendees?.find(a => a.responseStatus === 'declined' && a.email &&
        // Treat self as the attendee with self === true when gws returns it; otherwise any declined response still drops the event.
        (('self' in a && (a as any).self) || true));
      // Simpler: if any declined entry exists AND there's only one attendee (solo decline = not real event), skip.
      // But more conservatively, only skip when self is declined.
      const selfDeclined = ev.attendees?.some(a => (a as any).self && a.responseStatus === 'declined');
      if (selfDeclined) return false;
    }

    return true;
  });
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

export async function listCalendars(): Promise<CalendarListEntry[]> {
  const data = await gws(['calendar', 'calendarList', 'list', '--params', '{}']) as {
    items?: CalendarListEntry[];
  };
  return (data.items ?? []).filter(c => c.accessRole !== 'freeBusyReader');
}

export async function listEvents(
  calendarId: string,
  timeMin: string,
  timeMax: string,
): Promise<CalendarEvent[]> {
  const params = JSON.stringify({
    calendarId, timeMin, timeMax,
    singleEvents: true, orderBy: 'startTime', maxResults: 250,
  });
  const data = await gws(['calendar', 'events', 'list', '--params', params]) as {
    items?: CalendarEvent[];
  };
  return (data.items ?? []).filter(e => e.status !== 'cancelled');
}

/** Pull events across all selected calendars within [timeMin, timeMax), dedup by id. */
export async function pullAllEvents(
  calendars: CalendarListEntry[],
  timeMin: string,
  timeMax: string,
  onProgress?: (cal: CalendarListEntry, count: number) => void,
): Promise<TaggedEvent[]> {
  const all: TaggedEvent[] = [];
  for (const cal of calendars) {
    try {
      const events = await listEvents(cal.id, timeMin, timeMax);
      for (const ev of events) {
        all.push({ ...ev, _calendarLabel: cal.summary, _calendarId: cal.id });
      }
      onProgress?.(cal, events.length);
    } catch (e) {
      console.error(`  ${cal.summary}: FAILED — ${e instanceof Error ? e.message : e}`);
    }
  }

  const byId = new Map<string, TaggedEvent>();
  for (const ev of all) {
    if (!byId.has(ev.id) || ev._calendarId === 'primary') byId.set(ev.id, ev);
  }
  return [...byId.values()].sort(sortByStart);
}

export function selectCalendars(
  calendars: CalendarListEntry[],
  include: string[],
): CalendarListEntry[] {
  if (include.length === 0) return calendars;
  return calendars.filter(c => include.includes(c.id) || include.includes(c.summary));
}

export function sortByStart(a: CalendarEvent, b: CalendarEvent): number {
  const av = a.start.dateTime ?? a.start.date ?? '';
  const bv = b.start.dateTime ?? b.start.date ?? '';
  return av.localeCompare(bv);
}

/** Render a single event as a markdown bullet. */
export function renderEventBullet(ev: TaggedEvent): string {
  const title = (ev.summary ?? '(no title)').replace(/\n/g, ' ');
  const timeRange = formatTimeRange(ev);
  const attendees = (ev.attendees ?? [])
    .map(a => a.displayName || a.email)
    .filter(Boolean)
    .join(', ');

  const parts = [`- **${timeRange}** ${title}`, `_${ev._calendarLabel}_`];
  if (attendees) parts.push(attendees);
  if (ev.location) parts.push(ev.location);
  if (ev.htmlLink) parts.push(`[gcal](${ev.htmlLink})`);
  return parts.join(' · ');
}

export function formatTimeRange(ev: CalendarEvent): string {
  if (ev.start.date && !ev.start.dateTime) return '(all-day)';
  const start = new Date(ev.start.dateTime!);
  const end = new Date(ev.end.dateTime!);
  return `${formatTime(start)}–${formatTime(end)}`;
}

export function formatTime(d: Date): string {
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
    .replace(' ', '');
}

export function startDate(ev: CalendarEvent): Date {
  if (ev.start.dateTime) return new Date(ev.start.dateTime);
  if (ev.start.date) return new Date(ev.start.date + 'T00:00:00');
  return new Date();
}

export function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function localMonthString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

export function yamlQuote(s: string): string {
  return '"' + s.replace(/"/g, '\\"') + '"';
}

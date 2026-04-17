#!/usr/bin/env fish
# calendar-puller.fish — dump today's macOS Calendar events into the vault as a
# markdown page that the brain can ingest.
#
# Usage (from cron or launchd, or manually):
#   calendar-puller.fish                  # writes to $CHIBRAIN/_inbox/calendar/YYYY-MM-DD.md
#   calendar-puller.fish /path/to/vault   # custom vault
#
# Requires: icalBuddy (brew install ical-buddy)
# Reads:    all macOS Calendar.app accounts (iCloud, Google via Calendar.app, etc.)
# Writes:   markdown with frontmatter; watch-mode gbrain obsidian picks it up.
#
# Run on a 15-min interval via launchd (see docs/guides/signal-loop.md).

set vault $argv[1]
if test -z "$vault"
    set vault $CHIBRAIN
end
if test -z "$vault"
    echo "calendar-puller: no vault path. Pass as arg or set \$CHIBRAIN." >&2
    exit 1
end
if not test -d "$vault"
    echo "calendar-puller: vault not a directory: $vault" >&2
    exit 1
end

if not type -q icalBuddy
    echo "calendar-puller: icalBuddy not installed. Run: brew install ical-buddy" >&2
    exit 1
end

set today (date +%Y-%m-%d)
set outdir "$vault/_inbox/calendar"
set outfile "$outdir/$today.md"

mkdir -p "$outdir"

# Pull events: today + tomorrow. Format as one bullet per event with time +
# title + attendees when present. Strip icalBuddy's ANSI-ish decoration.
set events (icalBuddy \
    -b '- ' \
    -ps '| ' \
    -iep 'title,datetime,attendees,notes' \
    -nc \
    -npn \
    eventsToday+1 2>/dev/null)

# Header + frontmatter. Type "calendar" is a reasonable page type;
# filing rules can route it elsewhere if the user prefers.
begin
    echo '---'
    echo 'type: journal-digest'
    echo "title: Calendar — $today"
    echo 'tags: [calendar, _inbox]'
    echo "source: calendar-puller"
    echo "pulled_at: "(date -u +%Y-%m-%dT%H:%M:%SZ)
    echo '---'
    echo ''
    echo "# Calendar — $today"
    echo ''
    echo "Auto-generated from macOS Calendar. Agent should triage new meetings into"
    echo "proper meeting pages under the right wiki, then archive this file."
    echo ''

    if test -z "$events"
        echo '_No events today or tomorrow._'
    else
        for line in $events
            echo $line
        end
    end
end >"$outfile"

echo "calendar-puller: wrote $outfile" >&2

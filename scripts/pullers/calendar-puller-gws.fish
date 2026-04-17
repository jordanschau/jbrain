#!/usr/bin/env fish
# calendar-puller-gws.fish — pull today's + tomorrow's Google Calendar events
# into the vault as a markdown page. Uses the Google Workspace CLI (`gws`) so
# the same OAuth setup covers Gmail + Calendar + Drive for future pullers.
#
# Usage:
#   calendar-puller-gws.fish                  # writes to $CHIBRAIN/_inbox/calendar/YYYY-MM-DD.md
#   calendar-puller-gws.fish /path/to/vault   # custom vault
#
# One-time setup:
#   brew install googleworkspace-cli jq
#   gws auth setup     # creates Google Cloud project, enables APIs
#   gws auth login     # OAuth browser flow
#
# Every 15 minutes from launchd. See docs/guides/signal-loop.md.
#
# Requires: gws, jq, date (BSD or GNU — handled)

set vault $argv[1]
if test -z "$vault"
    set vault $CHIBRAIN
end
if test -z "$vault"
    echo "calendar-puller-gws: no vault path. Pass as arg or set \$CHIBRAIN." >&2
    exit 1
end
if not test -d "$vault"
    echo "calendar-puller-gws: vault not a directory: $vault" >&2
    exit 1
end

for dep in gws jq
    if not type -q $dep
        echo "calendar-puller-gws: $dep not installed." >&2
        if test "$dep" = "gws"
            echo "  Install: brew install googleworkspace-cli" >&2
            echo "  Then: gws auth setup && gws auth login" >&2
        else
            echo "  Install: brew install $dep" >&2
        end
        exit 1
    end
end

# Window: start of today local → end of tomorrow local, in RFC3339 UTC.
# macOS `date` differs from GNU — handle both with python since it ships on macOS.
set time_min (python3 -c 'from datetime import datetime, timedelta, timezone; d=datetime.now().astimezone().replace(hour=0,minute=0,second=0,microsecond=0); print(d.astimezone(timezone.utc).isoformat().replace("+00:00","Z"))')
set time_max (python3 -c 'from datetime import datetime, timedelta, timezone; d=(datetime.now().astimezone().replace(hour=0,minute=0,second=0,microsecond=0)+timedelta(days=2)); print(d.astimezone(timezone.utc).isoformat().replace("+00:00","Z"))')

set today (date +%Y-%m-%d)
set outdir "$vault/_inbox/calendar"
set outfile "$outdir/$today.md"
mkdir -p "$outdir"

# Pull events via Calendar API. `--page-all` emits NDJSON across pages.
set params (jq -nc --arg tmin "$time_min" --arg tmax "$time_max" \
    '{calendarId:"primary",timeMin:$tmin,timeMax:$tmax,singleEvents:true,orderBy:"startTime",maxResults:100}')

set events_json (gws calendar events list --params "$params" 2>/dev/null)
if test $status -ne 0
    echo "calendar-puller-gws: gws call failed. Run 'gws auth login' if token expired." >&2
    exit 1
end

# Render each event as a bullet:
#   - HH:MM-HH:MM | Title | attendee1, attendee2 | <gcal-link>
set rendered (echo "$events_json" | jq -r '
    .items // []
    | map(
        (.start.dateTime // .start.date) as $s
        | (.end.dateTime   // .end.date)   as $e
        | (.summary // "(no title)") as $title
        | (.attendees // [] | map(.email) | join(", ")) as $ppl
        | "- \($s) → \($e) | \($title)"
          + (if $ppl == "" then "" else " | \($ppl)" end)
          + (if .htmlLink then " | [gcal](\(.htmlLink))" else "" end)
      )
    | .[]
')

begin
    echo '---'
    echo 'type: journal-digest'
    echo "title: Calendar — $today"
    echo 'tags: [calendar, _inbox]'
    echo "source: calendar-puller-gws"
    echo "pulled_at: "(date -u +%Y-%m-%dT%H:%M:%SZ)
    echo "window_start: $time_min"
    echo "window_end: $time_max"
    echo '---'
    echo ''
    echo "# Calendar — $today"
    echo ''
    echo "Auto-pulled from Google Calendar via gws. Agent should triage new meetings"
    echo "into proper meeting pages under the right wiki, then archive this file."
    echo ''

    if test -z "$rendered"
        echo '_No events in the next 48 hours._'
    else
        for line in $rendered
            echo $line
        end
    end
end >"$outfile"

echo "calendar-puller-gws: wrote $outfile" >&2

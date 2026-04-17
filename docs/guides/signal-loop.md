# The Signal Loop

GBrain is designed as a read-enrich-write loop: raw signals flow in, an agent
reads them, updates the living wiki, and the brain stays fresh. This guide sets
up that loop end-to-end on a single Mac with Obsidian + Ollama.

## Architecture

```
Raw signals                Wiki (authoritative)         Brain index
───────────                ──────────────────           ───────────
 Calendar    ┐             chiBrain/*.md                ~/.gbrain/brain.pglite
 Email       ├──► pullers  ├─ ffc/wiki/people/...         ├─ pages
 Meetings    ┘   drop md   ├─ jbi/wiki/...                ├─ chunks + embeddings
 Notes ───────────────────►└─ personal/journal/...        ├─ links
                                  ▲                        ├─ tags
                                  │                        └─ timeline
                        Agent (Claude via MCP)
                        reads inbox, writes pages
                                  ▲
                                  │
                        gbrain obsidian --watch
                        re-ingests on save
```

- **Vault = source of truth.** Agents write markdown here.
- **Brain = derived index.** Built from the vault, used for search + graph.
- **Pullers = signal capture.** Small scripts that drop raw signals into
  `chiBrain/_inbox/` as markdown. The agent processes and archives them.

## Setting up the loop

### 1. Enable vault-backed writes

The `put_page` operation mirrors writes to your vault when `vault_path` is set.
This is what lets an MCP agent keep your wiki updated.

Edit `~/.gbrain/config.json`:

```json
{
  "engine": "pglite",
  "database_path": "/Users/you/.gbrain/brain.pglite",
  "embedding_provider": "ollama",
  "embedding_model": "mxbai-embed-large",
  "chat_provider": "ollama",
  "chat_model": "llama3.2:3b",
  "vault_path": "/Users/you/Library/Mobile Documents/iCloud~md~obsidian/Documents/chiBrain"
}
```

Or set `GBRAIN_VAULT_PATH` in your shell env.

Verify:

```fish
echo '---
type: concept
title: Loop Test
---
Testing vault write.' | gbrain put _test/loop-test

# The file should exist in the vault now:
ls "$CHIBRAIN/_test/loop-test.md"

gbrain delete _test/loop-test
# And be gone from the vault:
ls "$CHIBRAIN/_test/loop-test.md"; or echo "deleted"
```

### 2. Run `--watch` continuously (launchd)

Without watch running, vault edits from Obsidian (or any source other than
`gbrain put`) don't flow into the brain. Install a launchd plist.

Save to `~/Library/LaunchAgents/com.gbrain.watch.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.gbrain.watch</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/you/.bun/bin/bun</string>
    <string>run</string>
    <string>/Users/you/Developer/Personal/jbrain/src/cli.ts</string>
    <string>obsidian</string>
    <string>/Users/you/Library/Mobile Documents/iCloud~md~obsidian/Documents/chiBrain</string>
    <string>--watch</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>GBRAIN_EMBEDDING_PROVIDER</key><string>ollama</string>
    <key>GBRAIN_EMBEDDING_MODEL</key><string>mxbai-embed-large</string>
    <key>GBRAIN_CHAT_PROVIDER</key><string>ollama</string>
    <key>GBRAIN_CHAT_MODEL</key><string>llama3.2:3b</string>
    <key>OLLAMA_HOST</key><string>http://localhost:11434</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/you/.gbrain/watch.log</string>
  <key>StandardErrorPath</key><string>/Users/you/.gbrain/watch.err</string>
</dict>
</plist>
```

Load it:

```fish
launchctl load ~/Library/LaunchAgents/com.gbrain.watch.plist
launchctl list | grep gbrain     # should show com.gbrain.watch running

# Tail the log to confirm it's alive
tail -f ~/.gbrain/watch.log
```

To restart after edits:

```fish
launchctl unload ~/Library/LaunchAgents/com.gbrain.watch.plist
launchctl load ~/Library/LaunchAgents/com.gbrain.watch.plist
```

### 3. Calendar puller

Run `scripts/pullers/calendar-puller.ts` (bun/TypeScript) every 15 min. It
pulls today + tomorrow from **every calendar the authed `gws` account can
see** — which lets you aggregate multiple Google accounts via calendar
sharing (Google's native pattern) without juggling separate OAuth sessions.

**One-time setup:**

```fish
brew install googleworkspace-cli
gws auth setup       # creates a Google Cloud project, enables APIs
gws auth login       # OAuth browser flow. Personal @gmail.com works;
                     # add yourself as a test user when prompted.
```

**Multi-account strategy:** `gws` holds one auth at a time. To include
calendars from your other Google accounts (e.g. jordan@purecycles.com,
jordan@schau.com), share them INTO the authed account via Google Calendar:
Settings → Share with specific people → add your authed account with
"See all event details". Once shared, they appear in `calendarList list`
and get pulled automatically.

**Optional filter:** to restrict which calendars get pulled, copy
`scripts/pullers/calendar-sources.example.yaml` to
`~/.gbrain/calendar-sources.yaml` and list the calendar IDs you want.
Get IDs with:

```fish
gws calendar calendarList list --params '{}' | jq '.items[] | {id, summary}'
```

Without the filter file, every calendar you have read access to gets pulled.

**Test:**

```fish
bun run scripts/pullers/calendar-puller.ts "$CHIBRAIN"
cat "$CHIBRAIN/_inbox/calendar/"(date +%Y-%m-%d)".md"
```

**Schedule via launchd.** Save to
`~/Library/LaunchAgents/com.gbrain.calendar-puller.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.gbrain.calendar-puller</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/you/.bun/bin/bun</string>
    <string>run</string>
    <string>/Users/you/Developer/Personal/jbrain/scripts/pullers/calendar-puller.ts</string>
    <string>/Users/you/Library/Mobile Documents/iCloud~md~obsidian/Documents/chiBrain</string>
  </array>
  <key>StartInterval</key><integer>900</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/Users/you/.gbrain/calendar-puller.log</string>
  <key>StandardErrorPath</key><string>/Users/you/.gbrain/calendar-puller.err</string>
</dict>
</plist>
```

```fish
launchctl load ~/Library/LaunchAgents/com.gbrain.calendar-puller.plist
```

**Legacy fish pullers** at `scripts/pullers/calendar-puller.fish` (icalBuddy)
and `calendar-puller-gws.fish` (single-calendar gws) are kept for reference.
The TS version supersedes both.

### 4. Email puller (next)

If you went with Option A above, the OAuth is already done. Gmail just needs a
separate puller script:

```fish
# Sketch — full puller coming as Phase 5
gws gmail users messages list --params '{"q":"newer_than:1d -label:noise"}' \
  | jq -r '.messages[] | .id' \
  | while read id
        gws gmail users messages get --params "{\"id\":\"$id\",\"format\":\"metadata\"}" \
          | format_as_markdown_into $CHIBRAIN/_inbox/email/
    end
```

The full email puller follows `recipes/email-to-brain.md`: noise filters,
signature detection, deduplication via state file, Gmail links generated in
code (never by the LLM).

### 5. Agent enrichment (the brain's job)

With MCP wired into Claude Code (`claude mcp add gbrain ...`), ask Claude:

> Read everything under my `_inbox/` folder. For each new signal, identify the
> entities mentioned, update the corresponding wiki pages (append timeline
> entries with source attribution), and move the inbox file to `_archive/`
> when done.

The skills in `skills/signal-detector/`, `skills/brain-ops/`, and
`skills/meeting-ingestion/` tell Claude exactly how to do this. It uses
`get_page` to read current wiki state, `put_page` to write updates (which now
mirrors to the vault), and `add_link` / `add_timeline_entry` for graph edges.

On a daily cadence (say 9 AM / 1 PM / 5 PM), trigger Claude to process
`_inbox/`. That's the read-enrich-write loop closing.

## Verification

A healthy loop has these signals:

```fish
# Brain stays fresh (updated_at increments as you edit notes)
gbrain list --type person -n 5

# Watch is running
pgrep -fl "obsidian.*--watch"

# Puller is dropping files
ls -lh "$CHIBRAIN/_inbox/calendar/"

# Vault mirror works (edit a page via put, confirm vault file updated)
gbrain get ffc/wiki/people/faraz-ghadooshahy | gbrain put ffc/wiki/people/faraz-ghadooshahy
stat -f "%Sm" "$CHIBRAIN/ffc/wiki/people/faraz-ghadooshahy.md"   # mtime = now
```

## Known gaps

- **Deletions in Obsidian don't propagate** — if you delete a note in the vault,
  the brain still holds the page until you manually re-ingest. Tracked as a
  Phase 3 follow-up.
- **Attachments aren't stored** — `![[image.png]]` is skipped from link creation
  but the file isn't copied anywhere.
- **Agent triggering is manual** — you still have to ask Claude to process the
  inbox. A scheduled "enrichment run" is a logical next step (launchd calling
  Claude Code with a prompt file).

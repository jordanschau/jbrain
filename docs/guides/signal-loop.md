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

Run the included fish puller every 15 minutes. It dumps today's + tomorrow's
macOS Calendar events into `$CHIBRAIN/_inbox/calendar/YYYY-MM-DD.md` using
`icalBuddy`. The watch loop picks it up and ingests it into the brain.

Install icalBuddy:

```fish
brew install ical-buddy
```

Test the puller:

```fish
scripts/pullers/calendar-puller.fish
cat "$CHIBRAIN/_inbox/calendar/"(date +%Y-%m-%d)".md"
```

Schedule it. Save to `~/Library/LaunchAgents/com.gbrain.calendar-puller.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.gbrain.calendar-puller</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/fish</string>
    <string>/Users/you/Developer/Personal/jbrain/scripts/pullers/calendar-puller.fish</string>
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

### 4. Email puller (later)

See `recipes/email-to-brain.md` for the full recipe. The short version: write a
Node/Bun script that lists new Gmail messages, filters noise, and dumps
markdown digests into `$CHIBRAIN/_inbox/email/YYYY-MM-DD.md`. The watch loop
picks them up the same way.

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

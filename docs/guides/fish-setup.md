# Fish shell setup for local (Ollama) gbrain

Drop this into `~/.config/fish/config.fish` (or `source` it from there).
Adjust `JBRAIN_ROOT` and `CHIBRAIN` paths to match your setup.

```fish
# ============================================================
# gbrain — local-first personal knowledge brain
# ============================================================

# Where you cloned jbrain (adjust to wherever `git clone` landed it)
set -x JBRAIN_ROOT $HOME/Developer/Personal/jbrain

# Your Obsidian vault (quotes around the path are important — iCloud has spaces)
set -x CHIBRAIN "$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/chiBrain"

# --- Provider selection (all-local via Ollama) ---
set -x GBRAIN_EMBEDDING_PROVIDER ollama
set -x GBRAIN_EMBEDDING_MODEL    mxbai-embed-large     # 1024d, 512-token context
set -x GBRAIN_CHAT_PROVIDER      ollama
set -x GBRAIN_CHAT_MODEL         'qwen3.6:35b-a3b-nvfp4'  # use exact tag from `ollama list`

# Optional — only set if Ollama runs on a different host/port
# set -x OLLAMA_HOST http://localhost:11434

# Optional — override embedding input truncation (safety for small-context models).
# Defaults are set per-model (mxbai=1800, nomic=6400, bge-m3=6400, etc).
# Only set this if you've extended a model's context via a custom modelfile.
# set -x GBRAIN_EMBEDDING_MAX_CHARS 6400

# --- Run gbrain directly via bun (dodges macOS Gatekeeper on the compiled binary) ---
function gbrain
    bun run $JBRAIN_ROOT/src/cli.ts $argv
end
```

## Already have `gbrain` installed globally?

If `which gbrain` shows `/Users/you/.bun/bin/gbrain` (an old 0.4.x from `bun link`),
remove it so it can't shadow the fish function:

```fish
rm $HOME/.bun/bin/gbrain
type gbrain        # should show: function, defined in config.fish
gbrain --version   # should show 0.10.1 or later
```

## After editing the file

```fish
source ~/.config/fish/config.fish
gbrain doctor          # sanity check
gbrain stats           # confirms DB is reachable
```

## Switching embedding models later

```fish
ollama pull mxbai-embed-large   # or whatever you want to try

set -x GBRAIN_EMBEDDING_MODEL mxbai-embed-large   # update config.fish too!
gbrain reembed --dry-run        # preview the change
gbrain reembed                  # drops+recreates vector column, re-embeds all chunks
```

## Known model dimensions + truncation

| Model | Dims | Native context | Char limit we use |
|---|---|---|---|
| `nomic-embed-text` | 768 | 2048 tok | 6400 |
| `mxbai-embed-large` | 1024 | 512 tok | 1800 |
| `bge-m3` | 1024 | 8192 tok | 6400 |
| `snowflake-arctic-embed` | 1024 | 512 tok | 1800 |
| `snowflake-arctic-embed2` | 1024 | 8192 tok | 6400 |
| `bge-large` | 1024 | 512 tok | 1800 |
| `all-minilm` | 384 | 256 tok | 900 |
| `embeddinggemma` | 768 | 2048 tok | 6400 |

For unknown models, set `GBRAIN_EMBEDDING_DIMENSIONS` and `GBRAIN_EMBEDDING_MAX_CHARS` explicitly.

## Troubleshooting

**`Ollama /api/embed failed: 400 "input length exceeds the context length"`**
→ Your model has a smaller context than we're sending. Either switch to a
longer-context model (`bge-m3`), or lower `GBRAIN_EMBEDDING_MAX_CHARS`.

**`gbrain` command killed by SIGKILL on macOS**
→ Gatekeeper blocking the unsigned compiled binary. Use the `function gbrain`
wrapper above (runs via `bun`), or: `xattr -d com.apple.quarantine ./bin/gbrain`.

**Vector search returns nothing but keyword does**
→ Check `GBRAIN_EMBEDDING_PROVIDER` is set. Without it, the factory defaults to
OpenAI which needs an API key.

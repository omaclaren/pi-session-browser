# pi-session-browser

Local web UI for exploring, searching, and saving notes or bundles from pi sessions.

## Status

Early MVP.

Current features:
- scan `~/.pi/agent/sessions`
- group sessions by project / cwd
- SQLite FTS5-backed search over session metadata and extracted text snippets
- full-text indexing of compaction and branch summaries for better long-session recall
- query syntax with `label:` and `project:` filters
- persistent local search index in `.cache/sessions.sqlite`
- relevance scoring for search results
- preview selected sessions in the browser
- tree-aware stats: branch points, compactions, branch summaries, labels
- visible session tree view with active-path highlighting
- tree focus modes: all, active path, branches + labels
- jump from recent labeled checkpoints straight into the tree
- assistant tool-call turns summarised in the tree (e.g. `read ×3`, `bash ×2`)
- search snippets can surface summary hits directly (e.g. `[compaction] ...`, `[branch summary] ...`)
- extract recent labeled checkpoints and key path mentions
- copy a local deep link
- copy a `pi --session ...` resume command
- copy a markdown session note for passing context forward
- save a markdown session note to a local notes directory
- multi-select sessions across projects/views and save a deterministic markdown bundle

Planned next:
- cached model-generated summaries
- deeper branch-tree ergonomics (folding, subtree collapse, branch diff/focus)
- optional pi-extension bridge for opening the current browser selection or bundle inside pi

## Run

```bash
npm install
npm start
```

Open:

```text
http://127.0.0.1:4314
```

Optional flags:

```bash
npm start -- --open
npm start -- --port 4315
npm start -- --sessions-dir "/custom/path/to/sessions"
npm start -- --index-db "/custom/path/to/index.sqlite"
npm start -- --notes-dir "/custom/path/to/notes"
```

Supported environment variables:

- `PI_SESSION_BROWSER_PORT`
- `PI_SESSION_BROWSER_SESSIONS_DIR`
- `PI_SESSION_BROWSER_INDEX_DB`
- `PI_SESSION_BROWSER_NOTES_DIR`

Legacy note-directory aliases are still accepted for backward compatibility:

- `--distill-dir`
- `PI_SESSION_BROWSER_DISTILL_DIR`

## Settings

Pi-session-browser follows a pi-like global/project configuration style.

Settings files:

- Global: `~/.pi-session-browser/settings.json`
- Project-local: `.pi-session-browser/settings.json`

Supported keys:

```json
{
  "port": 4314,
  "sessionsDir": "~/.pi/agent/sessions",
  "indexDbPath": "~/.cache/pi-session-browser/sessions.sqlite",
  "notesDir": "~/.pi-session-browser/notes"
}
```

Notes:

- relative paths in settings files are resolved relative to the settings file location
- CLI flags override environment variables
- environment variables override project settings
- project settings override global settings
- global settings override built-in defaults
- `distillDir` in settings is still accepted as a legacy alias for `notesDir`

Built-in defaults:

- Notes: `~/.pi-session-browser/notes`
- Search index: `~/.cache/pi-session-browser/sessions.sqlite`
- Sessions: `~/.pi/agent/sessions`

## Development

```bash
npm run typecheck
npm start -- --open
```

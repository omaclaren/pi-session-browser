# pi-session-browser

Local web UI for exploring, searching, and saving notes or bundles from [pi](https://github.com/badlogic/pi-mono) sessions.

## Why

Pi stores every conversation as a JSONL session file. Over time you end up with hundreds of sessions across many projects. This tool gives you a fast, searchable, local browser for all of them — no cloud, no uploads, everything stays on your machine.

## Features

- scan `~/.pi/agent/sessions` (or custom path)
- group sessions by project / cwd
- live SQLite FTS5-backed full-text search with `label:` and `project:` filters
- full-text indexing of compaction and branch summaries for better long-session recall
- conversation view with timeline + branch modes
- tree-aware stats: branch points, compactions, branch summaries, labels
- jump from labeled checkpoints into the branch view
- copy deep link, resume command, or session note
- save session notes to disk
- multi-select sessions across projects and save a deterministic markdown bundle
- query-aware project list with match counts
- sort results by smart/default ordering, best match, newest, oldest, or most entries
- inspect search matches with surrounding transcript context
- open the full transcript in a scrollable browser tab
- adapts to your active pi theme automatically

## Run

```bash
git clone https://github.com/omaclaren/pi-session-browser.git
cd pi-session-browser
npm install
npm start
```

The browser opens automatically at:

```
http://127.0.0.1:4314
```

### Flags

```bash
npm start -- --headless                              # do not open browser on launch
npm start -- --no-open                               # alias for --headless
npm start -- --port 4315                             # custom port
npm start -- --sessions-dir "/path/to/sessions"      # custom sessions directory
npm start -- --index-db "/path/to/index.sqlite"      # custom index location
npm start -- --notes-dir "/path/to/notes"            # custom notes directory
```

### Environment variables

- `PI_SESSION_BROWSER_PORT`
- `PI_SESSION_BROWSER_SESSIONS_DIR`
- `PI_SESSION_BROWSER_INDEX_DB`
- `PI_SESSION_BROWSER_NOTES_DIR`

## Settings

Follows a pi-like global/project configuration style.

- Global: `~/.pi-session-browser/settings.json`
- Project-local: `.pi-session-browser/settings.json`

Example:

```json
{
  "port": 4314,
  "sessionsDir": "~/.pi/agent/sessions",
  "indexDbPath": "~/.cache/pi-session-browser/sessions.sqlite",
  "notesDir": "~/.pi-session-browser/notes"
}
```

Relative paths in settings files are resolved relative to the settings file location.

Config precedence: CLI flags → env vars → project settings → global settings → built-in defaults.

Built-in defaults:

| Setting | Default |
|---------|---------|
| Notes | `~/.pi-session-browser/notes` |
| Search index | `~/.cache/pi-session-browser/sessions.sqlite` |
| Sessions | `~/.pi/agent/sessions` |

You can also change the notes folder from the browser UI at runtime.

## Development

```bash
npm run typecheck
npm start
```

## License

MIT

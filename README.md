# pi-session-browser

Local web UI for exploring, searching, and saving notes or bundles from [pi](https://github.com/badlogic/pi-mono) sessions.

## Why

Pi stores every conversation as a JSONL session file. Over time you end up with hundreds of sessions across many projects. This tool gives you a fast, searchable, local browser for all of them — no cloud, no uploads, everything stays on your machine.

## Features

- scan `~/.pi/agent/sessions` (or custom path)
- watch the sessions directory: new and updated sessions are indexed within seconds, no manual reindex
- persistent summary cache: only changed sessions are re-parsed on startup
- group sessions by project / cwd
- live SQLite FTS5-backed full-text search with `label:` and `project:` filters
- full-text indexing of compaction and branch summaries for better long-session recall
- conversation view with timeline + branch modes
- show/hide entry types (user, assistant, tool output, summaries) in both the conversation excerpt and the full transcript, remembered across sessions
- tree-aware stats: branch points, compactions, branch summaries, labels
- jump from labeled checkpoints into the branch view
- copy deep link, resume command, or session note
- save session notes to disk
- multi-select sessions across projects and save a deterministic markdown bundle
- query-aware project list with match counts
- sort results by smart/default ordering, best match, newest, oldest, or most entries
- keyboard navigation: `/` focuses search, `j`/`k` or arrow keys move through sessions, `Enter` opens the full transcript, `Esc` clears search
- shareable URLs: the current search query and selected session live in the URL hash, so links and bookmarks restore both
- inspect search matches with surrounding transcript context
- open the full transcript in a scrollable browser tab with pi entry IDs
- copy an explicit pi `/tree` handoff from any search match
- create a deterministic forked session from a search match and copy its resume command
- adapts to your active pi theme automatically

## Run

Via npm:

```bash
npx pi-session-browser
```

Or from source:

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
npx pi-session-browser --headless                              # do not open browser on launch
npx pi-session-browser --no-open                               # alias for --headless
npx pi-session-browser --port 4315                             # custom port
npx pi-session-browser --sessions-dir "/path/to/sessions"      # custom sessions directory
npx pi-session-browser --index-db "/path/to/index.sqlite"      # custom index location
npx pi-session-browser --notes-dir "/path/to/notes"            # custom notes directory
```

When running from source, pass flags after `--`, e.g. `npm start -- --headless`.

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
npm start            # run from TypeScript source via tsx
npm run build        # compile to dist/ (used by the npm bin entry)
```

## License

MIT

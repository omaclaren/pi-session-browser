# pi-session-browser

Local web UI for exploring, searching, and distilling pi sessions.

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
- copy a markdown handoff block for passing context forward
- save a distilled markdown note to a local distill directory

Planned next:
- cached model-generated summaries
- deeper branch-tree ergonomics (folding, subtree collapse, branch diff/focus)
- optional pi-extension bridge for opening the current browser selection inside pi

## Run

```bash
cd "/Users/omac010/Git-Working/pi-session-browser"
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
npm start -- --distill-dir "/custom/path/to/distills"
```

You can also use the environment variables:

- `PI_SESSION_BROWSER_PORT`
- `PI_SESSION_BROWSER_SESSIONS_DIR`
- `PI_SESSION_BROWSER_INDEX_DB`
- `PI_SESSION_BROWSER_DISTILL_DIR`

## Development

```bash
npm run typecheck
npm start -- --open
```

## Naming

Repo name: `pi-session-browser`

Suggested package name: `pi-session-browser`

That matches the style of your other pi packages. If npm publish later reveals a collision, we can revisit, but the unscoped name appears fine to use for now.

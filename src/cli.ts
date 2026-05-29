import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionIndex } from "./sessions.js";
import { loadActiveBrowserTheme } from "./pi-theme.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const DEFAULT_NOTES_DIR = join(homedir(), ".pi-session-browser", "notes");
const DEFAULT_INDEX_DB = join(homedir(), ".cache", "pi-session-browser", "sessions.sqlite");
const GLOBAL_SETTINGS_PATH = join(homedir(), ".pi-session-browser", "settings.json");

function getProjectSettingsPath(cwd: string): string {
  return join(cwd, ".pi-session-browser", "settings.json");
}

type AppSettings = {
  port?: number | string;
  sessionsDir?: string;
  indexDbPath?: string;
  notesDir?: string;
  distillDir?: string;
};

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function resolvePathValue(path: string, baseDir: string): string {
  const expanded = expandHome(path);
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    const raw = await fs.readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function parsePort(value: number | string | undefined, fallback = 4314): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function loadAppConfig(cwd: string): Promise<{
  port: number;
  sessionsDir?: string;
  indexDbPath: string;
  notesDir: string;
}> {
  const projectSettingsPath = getProjectSettingsPath(cwd);
  const [globalSettings, projectSettings] = await Promise.all([
    readJsonFile<AppSettings>(GLOBAL_SETTINGS_PATH),
    readJsonFile<AppSettings>(projectSettingsPath),
  ]);

  const resolveFromSettings = (value: string | undefined, settingsPath: string): string | undefined => {
    if (!value) return undefined;
    return resolvePathValue(value, dirname(settingsPath));
  };

  const cliPath = (primaryFlag: string, legacyFlag: string | undefined, envKey: string | undefined, legacyEnvKey: string | undefined): string | undefined => {
    const raw = getArg(primaryFlag)
      ?? (legacyFlag ? getArg(legacyFlag) : undefined)
      ?? (envKey ? process.env[envKey] : undefined)
      ?? (legacyEnvKey ? process.env[legacyEnvKey] : undefined);
    if (!raw) return undefined;
    return resolvePathValue(raw, cwd);
  };

  const notesDir = cliPath("--notes-dir", "--distill-dir", "PI_SESSION_BROWSER_NOTES_DIR", "PI_SESSION_BROWSER_DISTILL_DIR")
    ?? resolveFromSettings(projectSettings?.notesDir ?? projectSettings?.distillDir, projectSettingsPath)
    ?? resolveFromSettings(globalSettings?.notesDir ?? globalSettings?.distillDir, GLOBAL_SETTINGS_PATH)
    ?? DEFAULT_NOTES_DIR;

  const indexDbPath = cliPath("--index-db", undefined, "PI_SESSION_BROWSER_INDEX_DB", undefined)
    ?? resolveFromSettings(projectSettings?.indexDbPath, projectSettingsPath)
    ?? resolveFromSettings(globalSettings?.indexDbPath, GLOBAL_SETTINGS_PATH)
    ?? DEFAULT_INDEX_DB;

  const sessionsDir = cliPath("--sessions-dir", undefined, "PI_SESSION_BROWSER_SESSIONS_DIR", undefined)
    ?? resolveFromSettings(projectSettings?.sessionsDir, projectSettingsPath)
    ?? resolveFromSettings(globalSettings?.sessionsDir, GLOBAL_SETTINGS_PATH);

  const port = parsePort(
    getArg("--port")
      ?? process.env.PI_SESSION_BROWSER_PORT
      ?? projectSettings?.port
      ?? globalSettings?.port,
  );

  return { port, sessionsDir, indexDbPath, notesDir };
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function updateSettingsFile(path: string, update: (settings: AppSettings) => AppSettings): Promise<void> {
  const current = (await readJsonFile<AppSettings>(path)) ?? {};
  await writeJsonFile(path, update(current));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function text(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function queryTerms(query: string | undefined): string[] {
  const terms = new Set<string>();
  for (const token of (query ?? "").split(/\s+/).filter(Boolean)) {
    if (/^(label|project|cwd):/i.test(token)) continue;
    for (const piece of token.toLowerCase().split(/[^a-z0-9]+/)) {
      if (piece) terms.add(piece);
    }
  }
  return Array.from(terms);
}

function highlightHtml(textValue: string, terms: string[]): string {
  if (!terms.length) return escapeHtml(textValue);
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi");
  return textValue.split(pattern).map((part) => {
    const matched = terms.some((term) => part.toLowerCase() === term.toLowerCase());
    return matched ? `<mark>${escapeHtml(part)}</mark>` : escapeHtml(part);
  }).join("");
}

function renderTranscriptPage(transcript: Awaited<ReturnType<SessionIndex["getTranscript"]>>, query: string | undefined): string {
  if (!transcript) return "";
  const terms = queryTerms(query);
  const title = transcript.summary.sessionName
    ?? transcript.summary.firstUserPrompt
    ?? transcript.summary.projectLabel
    ?? "Session transcript";
  const entries = transcript.entries.map((entry, index) => {
    const roleClass = entry.role.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const entryIdAnchor = entry.entryId ? `pi-entry-${entry.entryId}` : undefined;
    return `
      <article class="entry role-${escapeHtml(roleClass)}" id="entry-${index + 1}" ${entry.entryId ? `data-entry-id="${escapeHtml(entry.entryId)}"` : ""}>
        ${entryIdAnchor ? `<a class="entry-id-anchor" id="${escapeHtml(entryIdAnchor)}" aria-hidden="true"></a>` : ""}
        <div class="entry-meta">
          <a href="#entry-${index + 1}">#${index + 1}</a>
          <span>${escapeHtml(entry.role)}</span>
          ${entry.entryId ? `<a href="#${escapeHtml(entryIdAnchor)}" title="Pi JSONL entry id">id ${escapeHtml(entry.entryId)}</a>` : ""}
          ${entry.timestamp ? `<time>${escapeHtml(entry.timestamp)}</time>` : ""}
        </div>
        <div class="entry-text">${highlightHtml(entry.text, terms)}</div>
      </article>
    `;
  }).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · transcript</title>
  <style>
    :root { color-scheme: light dark; --bg: #ffffff; --panel: #f6f8fa; --surface: #ffffff; --border: #d0d7de; --text: #0e1116; --muted: #656e77; --accent: #1b7c83; --highlight: rgba(241,187,121,0.24); }
    @media (prefers-color-scheme: dark) { :root { --bg: #181818; --panel: #1f1f1f; --surface: #1a1a1a; --border: #363636; --text: #d5d0c9; --muted: #88847f; --accent: #42d9c5; --highlight: rgba(241,187,121,0.20); } }
    * { box-sizing: border-box; }
    html { font-size: 90%; }
    body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.5; background: var(--bg); color: var(--text); }
    header { position: sticky; top: 0; z-index: 2; padding: 1rem 1.2rem; border-bottom: 1px solid var(--border); background: var(--bg); }
    h1 { margin: 0; font-size: clamp(1.25rem, 2vw, 1.7rem); line-height: 1.15; letter-spacing: -0.03em; }
    .meta { margin-top: 0.45rem; color: var(--muted); font-size: 0.9rem; display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; }
    main { width: min(110rem, 100%); margin: 0 auto; padding: 1rem; display: grid; gap: 0.75rem; }
    .entry { position: relative; border: 1px solid var(--border); border-radius: 14px; background: var(--surface); overflow: hidden; }
    .entry-id-anchor { position: absolute; top: -5rem; }
    .entry-meta { display: flex; flex-wrap: wrap; gap: 0.45rem 0.75rem; align-items: baseline; padding: 0.65rem 0.8rem; border-bottom: 1px solid var(--border); color: var(--muted); font-size: 0.8rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
    .entry-meta a { color: var(--accent); text-decoration: none; }
    .entry-meta time { font-weight: 500; letter-spacing: 0; text-transform: none; }
    .entry-text { padding: 0.85rem 0.95rem; white-space: pre-wrap; word-break: break-word; }
    .role-user { border-color: color-mix(in srgb, var(--accent), var(--border) 55%); }
    .role-toolresult, .role-tool-result, .role-compaction-summary, .role-branch-summary { background: var(--panel); }
    mark { padding: 0 0.08em; border-radius: 0.22em; background: var(--highlight); color: var(--text); box-shadow: inset 0 -0.12em 0 #f1bb79; }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(title)}</h1>
    <div class="meta">
      <span>${transcript.entries.length} transcript entries</span>
      <span>${escapeHtml(transcript.summary.projectLabel)}</span>
      <span>${escapeHtml(transcript.summary.updatedAt)}</span>
      ${terms.length ? `<span>highlighting: ${terms.map(escapeHtml).join(", ")}</span>` : ""}
    </div>
  </header>
  <main>${entries || `<p>No transcript entries found.</p>`}</main>
</body>
</html>`;
}

function omitSearchText<T extends { searchText?: string }>(session: T): Omit<T, "searchText"> {
  const { searchText: _searchText, ...rest } = session;
  return rest;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return undefined;
  return JSON.parse(raw);
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const relativePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = join(PUBLIC_DIR, relativePath);
  try {
    const data = await fs.readFile(filePath);
    const type = contentType(filePath);
    res.writeHead(200, { "content-type": type });
    res.end(data);
  } catch {
    text(res, 404, "Not found");
  }
}

function contentType(filePath: string): string {
  switch (extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  execFile(command, args, () => {});
}

async function isSessionBrowserRunning(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/api/health`);
    if (!response.ok) return false;
    const body = (await response.json()) as { ok?: unknown; sessions?: unknown; projects?: unknown };
    return body.ok === true && typeof body.sessions === "number" && typeof body.projects === "number";
  } catch {
    return false;
  }
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };

    const onListening = () => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

async function main(): Promise<void> {
  const configCwd = process.cwd();
  const projectSettingsPath = getProjectSettingsPath(configCwd);
  const { port, sessionsDir, indexDbPath, notesDir } = await loadAppConfig(configCwd);
  const autoOpen = !hasFlag("--headless") && !hasFlag("--no-open");
  const appUrl = `http://127.0.0.1:${port}`;
  let currentNotesDir = notesDir;

  if (await isSessionBrowserRunning(appUrl)) {
    process.stdout.write(`pi-session-browser is already running at ${appUrl}\n`);
    if (autoOpen) openBrowser(appUrl);
    return;
  }

  await fs.mkdir(dirname(indexDbPath), { recursive: true });
  await fs.mkdir(currentNotesDir, { recursive: true });

  const index = new SessionIndex(sessionsDir, indexDbPath);

  process.stdout.write(`Indexing sessions from ${index.sessionsDir}...\n`);
  await index.refresh();
  process.stdout.write(`Indexed ${index.getStats().sessions} sessions across ${index.getStats().projects} projects.\n`);
  process.stdout.write(`Search index database: ${index.indexDbPath}\n`);
  process.stdout.write(`Session notes will be written to ${currentNotesDir}\n`);

  setInterval(() => {
    index.refresh().catch((error) => {
      console.error("Background refresh failed", error);
    });
  }, 60_000).unref();

  const server = createServer(async (req, res) => {
    if (!req.url) {
      text(res, 400, "Missing URL");
      return;
    }

    const url = new URL(req.url, `http://localhost:${port}`);
    const { pathname, searchParams } = url;

    if (pathname === "/api/health") {
      json(res, 200, { ok: true, notesDir: currentNotesDir, distillDir: currentNotesDir, ...index.getStats() });
      return;
    }

    if (pathname === "/api/theme") {
      const theme = await loadActiveBrowserTheme(process.cwd());
      json(res, 200, { theme: theme ?? null });
      return;
    }

    if (pathname === "/api/refresh" && req.method === "POST") {
      await index.refresh();
      json(res, 200, { ok: true, notesDir: currentNotesDir, distillDir: currentNotesDir, ...index.getStats() });
      return;
    }

    if (pathname === "/api/config") {
      json(res, 200, {
        notesDir: currentNotesDir,
        cwd: configCwd,
        globalSettingsPath: GLOBAL_SETTINGS_PATH,
        projectSettingsPath,
      });
      return;
    }

    if (pathname === "/api/config/notes-dir" && req.method === "POST") {
      try {
        const body = (await readJsonBody(req)) as { notesDir?: string; scope?: string } | undefined;
        const rawNotesDir = body?.notesDir?.trim();
        const scope = body?.scope === "project" ? "project" : body?.scope === "global" ? "global" : undefined;
        if (!rawNotesDir) {
          json(res, 400, { error: "Missing notesDir" });
          return;
        }
        if (!scope) {
          json(res, 400, { error: "Missing scope" });
          return;
        }

        const settingsPath = scope === "project" ? projectSettingsPath : GLOBAL_SETTINGS_PATH;
        await updateSettingsFile(settingsPath, (settings) => {
          const next = { ...settings, notesDir: rawNotesDir };
          delete next.distillDir;
          return next;
        });

        const reloaded = await loadAppConfig(configCwd);
        currentNotesDir = reloaded.notesDir;
        await fs.mkdir(currentNotesDir, { recursive: true });

        json(res, 200, {
          ok: true,
          notesDir: currentNotesDir,
          savedNotesDir: rawNotesDir,
          scope,
          settingsPath,
        });
      } catch (error) {
        json(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (pathname === "/api/projects") {
      const query = searchParams.get("q") ?? undefined;
      json(res, 200, { projects: index.getProjects({ query }) });
      return;
    }

    if (pathname === "/api/sessions") {
      const projectId = searchParams.get("project") ?? undefined;
      const query = searchParams.get("q") ?? undefined;
      const sort = searchParams.get("sort") ?? undefined;
      const limit = Number.parseInt(searchParams.get("limit") ?? "200", 10);
      json(res, 200, {
        sessions: index.getSessions({ projectId, query, sort, limit: Number.isFinite(limit) ? limit : 200 }).map(omitSearchText),
      });
      return;
    }

    if (pathname === "/api/session") {
      const sessionFile = searchParams.get("path");
      const query = searchParams.get("q") ?? undefined;
      if (!sessionFile) {
        json(res, 400, { error: "Missing path" });
        return;
      }
      const detail = await index.getSessionDetail(sessionFile, query);
      if (!detail) {
        json(res, 404, { error: "Session not found" });
        return;
      }
      json(res, 200, { session: omitSearchText(detail) });
      return;
    }

    if (pathname === "/transcript") {
      const sessionFile = searchParams.get("path");
      const query = searchParams.get("q") ?? undefined;
      if (!sessionFile) {
        text(res, 400, "Missing path");
        return;
      }
      const transcript = await index.getTranscript(sessionFile);
      if (!transcript) {
        text(res, 404, "Session not found");
        return;
      }
      html(res, 200, renderTranscriptPage(transcript, query));
      return;
    }

    if (pathname === "/api/note" && req.method === "POST") {
      try {
        const body = (await readJsonBody(req)) as { path?: string } | undefined;
        const sessionFile = body?.path;
        if (!sessionFile) {
          json(res, 400, { error: "Missing path" });
          return;
        }
        const result = await index.writeNote(sessionFile, currentNotesDir);
        if (!result) {
          json(res, 404, { error: "Session not found" });
          return;
        }
        json(res, 200, { ok: true, path: result.path, fileName: result.session.noteFileName });
      } catch (error) {
        json(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (pathname === "/api/fork" && req.method === "POST") {
      try {
        const body = (await readJsonBody(req)) as { path?: string; entryId?: string } | undefined;
        const sessionFile = body?.path;
        const entryId = body?.entryId;
        if (!sessionFile) {
          json(res, 400, { error: "Missing path" });
          return;
        }
        if (!entryId) {
          json(res, 400, { error: "Missing entryId" });
          return;
        }
        const result = await index.createForkAtEntry(sessionFile, entryId);
        if (!result) {
          json(res, 404, { error: "Session not found" });
          return;
        }
        json(res, 200, { ok: true, ...result });
      } catch (error) {
        json(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (pathname === "/api/bundle" && req.method === "POST") {
      try {
        const body = (await readJsonBody(req)) as { paths?: string[] } | undefined;
        const sessionFiles = Array.isArray(body?.paths) ? body.paths.filter((path): path is string => typeof path === "string" && path.length > 0) : [];
        if (!sessionFiles.length) {
          json(res, 400, { error: "Missing paths" });
          return;
        }
        const result = await index.writeBundle(sessionFiles, currentNotesDir);
        if (!result) {
          json(res, 404, { error: "No sessions found" });
          return;
        }
        json(res, 200, { ok: true, path: result.path, fileName: result.fileName, sessionCount: result.sessions.length });
      } catch (error) {
        json(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    await serveStatic(pathname, res);
  });

  try {
    await listen(server, port);
  } catch (error) {
    index.close();

    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      if (await isSessionBrowserRunning(appUrl)) {
        process.stdout.write(`\npi-session-browser is already running at ${appUrl}\n`);
        if (autoOpen) openBrowser(appUrl);
        return;
      }

      process.stderr.write(`\nPort ${port} is already in use on 127.0.0.1.\n`);
      process.stderr.write(`Use --port ${port + 1} to start another instance.\n`);
      process.exit(1);
    }

    throw error;
  }

  process.stdout.write(`\npi-session-browser running at ${appUrl}\n`);
  process.stdout.write("Use --headless or --no-open to skip launching a browser.\n");

  if (autoOpen) openBrowser(appUrl);

  const shutdown = () => {
    index.close();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

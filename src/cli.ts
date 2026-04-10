import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionIndex } from "./sessions.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const DEFAULT_DISTILL_DIR = join(ROOT, "distills");
const DEFAULT_INDEX_DB = join(ROOT, ".cache", "sessions.sqlite");

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
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

async function main(): Promise<void> {
  const port = Number.parseInt(getArg("--port") ?? process.env.PI_SESSION_BROWSER_PORT ?? "4314", 10);
  const sessionsDir = getArg("--sessions-dir") ?? process.env.PI_SESSION_BROWSER_SESSIONS_DIR;
  const indexDbPath = getArg("--index-db") ?? process.env.PI_SESSION_BROWSER_INDEX_DB ?? DEFAULT_INDEX_DB;
  const distillDir = getArg("--distill-dir") ?? process.env.PI_SESSION_BROWSER_DISTILL_DIR ?? DEFAULT_DISTILL_DIR;
  const autoOpen = hasFlag("--open");
  const index = new SessionIndex(sessionsDir, indexDbPath);

  process.stdout.write(`Indexing sessions from ${index.sessionsDir}...\n`);
  await index.refresh();
  process.stdout.write(`Indexed ${index.getStats().sessions} sessions across ${index.getStats().projects} projects.\n`);
  process.stdout.write(`Search index database: ${index.indexDbPath}\n`);
  process.stdout.write(`Distills will be written to ${distillDir}\n`);

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
      json(res, 200, { ok: true, distillDir, ...index.getStats() });
      return;
    }

    if (pathname === "/api/refresh" && req.method === "POST") {
      await index.refresh();
      json(res, 200, { ok: true, distillDir, ...index.getStats() });
      return;
    }

    if (pathname === "/api/projects") {
      json(res, 200, { projects: index.getProjects() });
      return;
    }

    if (pathname === "/api/sessions") {
      const projectId = searchParams.get("project") ?? undefined;
      const query = searchParams.get("q") ?? undefined;
      const limit = Number.parseInt(searchParams.get("limit") ?? "200", 10);
      json(res, 200, {
        sessions: index.getSessions({ projectId, query, limit: Number.isFinite(limit) ? limit : 200 }),
      });
      return;
    }

    if (pathname === "/api/session") {
      const sessionFile = searchParams.get("path");
      if (!sessionFile) {
        json(res, 400, { error: "Missing path" });
        return;
      }
      const detail = await index.getSessionDetail(sessionFile);
      if (!detail) {
        json(res, 404, { error: "Session not found" });
        return;
      }
      json(res, 200, { session: detail });
      return;
    }

    if (pathname === "/api/distill" && req.method === "POST") {
      try {
        const body = (await readJsonBody(req)) as { path?: string } | undefined;
        const sessionFile = body?.path;
        if (!sessionFile) {
          json(res, 400, { error: "Missing path" });
          return;
        }
        const result = await index.writeDistill(sessionFile, distillDir);
        if (!result) {
          json(res, 404, { error: "Session not found" });
          return;
        }
        json(res, 200, { ok: true, path: result.path, fileName: result.session.distillFileName });
      } catch (error) {
        json(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    await serveStatic(pathname, res);
  });

  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve());
  });

  const appUrl = `http://127.0.0.1:${port}`;
  process.stdout.write(`\npi-session-browser running at ${appUrl}\n`);
  process.stdout.write("Use --open to launch a browser automatically.\n");

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

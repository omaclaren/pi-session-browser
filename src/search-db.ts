import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { SessionSearchDocument, SessionSummary } from "./types.js";

// Bump whenever parseSessionSummary output or the FTS schema changes, so stale
// cached/indexed rows from older versions are rebuilt instead of trusted.
const CACHE_VERSION = 1;

export type SearchHit = {
  sessionFile: string;
  matchSnippet?: string;
  scoreBoost: number;
  source: "session" | "summary" | "mixed";
  summaryHitCount: number;
};

export type CachedSessionSummary = {
  sessionFile: string;
  mtimeMs: number;
  summary: SessionSummary;
};

function ftsTokens(terms: string[]): string[] {
  const tokens = new Set<string>();
  for (const term of terms) {
    for (const piece of term.toLowerCase().split(/[^a-z0-9]+/)) {
      if (!piece) continue;
      tokens.add(piece);
    }
  }
  return Array.from(tokens);
}

function buildFtsQuery(terms: string[]): string | undefined {
  const tokens = ftsTokens(terms);
  if (tokens.length === 0) return undefined;
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(" AND ");
}

function segmentTypeLabel(segmentType: string): string {
  return segmentType === "branchSummary" ? "branch summary" : "compaction";
}

export class SessionSearchDb {
  readonly dbPath: string;
  private readonly db: Database.Database;
  private readonly insertSessionStmt: Database.Statement;
  private readonly insertSegmentStmt: Database.Statement;
  private readonly insertCacheStmt: Database.Statement;
  private readonly deleteSessionStmt: Database.Statement;
  private readonly deleteSegmentStmt: Database.Statement;
  private readonly deleteCacheStmt: Database.Statement;
  private readonly countStmt: Database.Statement;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
        sessionFile UNINDEXED,
        sessionName,
        projectLabel,
        cwd,
        firstUserPrompt,
        latestUserPrompt,
        labels,
        searchText,
        tokenize = 'porter unicode61'
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS summary_segments_fts USING fts5(
        sessionFile UNINDEXED,
        segmentType UNINDEXED,
        segmentOrder UNINDEXED,
        summaryText,
        tokenize = 'porter unicode61'
      );

      CREATE TABLE IF NOT EXISTS session_cache (
        sessionFile TEXT PRIMARY KEY,
        mtimeMs REAL NOT NULL,
        summaryJson TEXT NOT NULL
      );
    `);

    const storedVersion = this.db.pragma("user_version", { simple: true }) as number;
    if (storedVersion !== CACHE_VERSION) {
      this.db.exec(`
        DELETE FROM sessions_fts;
        DELETE FROM summary_segments_fts;
        DELETE FROM session_cache;
      `);
      this.db.pragma(`user_version = ${CACHE_VERSION}`);
    }

    this.insertSessionStmt = this.db.prepare(`
      INSERT INTO sessions_fts(
        sessionFile,
        sessionName,
        projectLabel,
        cwd,
        firstUserPrompt,
        latestUserPrompt,
        labels,
        searchText
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.insertSegmentStmt = this.db.prepare(`
      INSERT INTO summary_segments_fts(
        sessionFile,
        segmentType,
        segmentOrder,
        summaryText
      ) VALUES (?, ?, ?, ?)
    `);

    this.insertCacheStmt = this.db.prepare(`
      INSERT OR REPLACE INTO session_cache(sessionFile, mtimeMs, summaryJson)
      VALUES (?, ?, ?)
    `);

    this.deleteSessionStmt = this.db.prepare(`DELETE FROM sessions_fts WHERE sessionFile = ?`);
    this.deleteSegmentStmt = this.db.prepare(`DELETE FROM summary_segments_fts WHERE sessionFile = ?`);
    this.deleteCacheStmt = this.db.prepare(`DELETE FROM session_cache WHERE sessionFile = ?`);
    this.countStmt = this.db.prepare(`SELECT count(*) as count FROM sessions_fts`);
  }

  close(): void {
    this.db.close();
  }

  loadCachedSummaries(): CachedSessionSummary[] {
    const rows = this.db
      .prepare(`SELECT sessionFile, mtimeMs, summaryJson FROM session_cache`)
      .all() as Array<{ sessionFile: string; mtimeMs: number; summaryJson: string }>;
    const cached: CachedSessionSummary[] = [];
    for (const row of rows) {
      try {
        cached.push({
          sessionFile: row.sessionFile,
          mtimeMs: row.mtimeMs,
          summary: JSON.parse(row.summaryJson) as SessionSummary,
        });
      } catch {
        this.remove(row.sessionFile);
      }
    }
    return cached;
  }

  upsert(doc: SessionSearchDocument, mtimeMs: number): void {
    const tx = this.db.transaction((input: SessionSearchDocument) => {
      this.deleteSessionStmt.run(input.summary.sessionFile);
      this.deleteSegmentStmt.run(input.summary.sessionFile);

      this.insertSessionStmt.run(
        input.summary.sessionFile,
        input.summary.sessionName ?? "",
        input.summary.projectLabel,
        input.summary.cwd,
        input.summary.firstUserPrompt ?? "",
        input.summary.latestUserPrompt ?? "",
        input.summary.labels.join(" "),
        input.summary.searchText,
      );

      for (const segment of input.segments) {
        const text = segment.text.trim();
        if (!text) continue;
        this.insertSegmentStmt.run(
          input.summary.sessionFile,
          segment.type,
          segment.order,
          text,
        );
      }

      this.insertCacheStmt.run(input.summary.sessionFile, mtimeMs, JSON.stringify(input.summary));
    });
    tx(doc);
  }

  remove(sessionFile: string): void {
    this.deleteSessionStmt.run(sessionFile);
    this.deleteSegmentStmt.run(sessionFile);
    this.deleteCacheStmt.run(sessionFile);
  }

  search(terms: string[], limit = 400): SearchHit[] {
    const query = buildFtsQuery(terms);
    if (!query) return [];

    const sessionStmt = this.db.prepare(`
      SELECT
        sessionFile,
        snippet(sessions_fts, 7, '', '', '…', 18) AS matchSnippet,
        bm25(sessions_fts) AS score
      FROM sessions_fts
      WHERE sessions_fts MATCH ?
      ORDER BY score ASC
      LIMIT ?
    `);

    const segmentStmt = this.db.prepare(`
      SELECT
        sessionFile,
        segmentType,
        snippet(summary_segments_fts, 3, '', '', '…', 18) AS matchSnippet,
        bm25(summary_segments_fts) AS score
      FROM summary_segments_fts
      WHERE summary_segments_fts MATCH ?
      ORDER BY score ASC
      LIMIT ?
    `);

    const sessionRows = sessionStmt.all(query, Math.max(limit * 2, 100)) as Array<{
      sessionFile: string;
      matchSnippet?: string;
    }>;

    const segmentRows = segmentStmt.all(query, Math.max(limit * 4, 200)) as Array<{
      sessionFile: string;
      segmentType: string;
      matchSnippet?: string;
    }>;

    type Aggregate = {
      sessionRank?: number;
      sessionSnippet?: string;
      segmentRank?: number;
      segmentSnippet?: string;
      segmentHits: number;
    };

    const aggregateBySession = new Map<string, Aggregate>();

    for (const [index, row] of sessionRows.entries()) {
      const existing = aggregateBySession.get(row.sessionFile) ?? { segmentHits: 0 };
      if (existing.sessionRank === undefined || index < existing.sessionRank) {
        existing.sessionRank = index;
        existing.sessionSnippet = row.matchSnippet;
      }
      aggregateBySession.set(row.sessionFile, existing);
    }

    for (const [index, row] of segmentRows.entries()) {
      const existing = aggregateBySession.get(row.sessionFile) ?? { segmentHits: 0 };
      existing.segmentHits += 1;
      if (existing.segmentRank === undefined || index < existing.segmentRank) {
        existing.segmentRank = index;
        const prefix = `[${segmentTypeLabel(row.segmentType)}] `;
        existing.segmentSnippet = `${prefix}${row.matchSnippet ?? ""}`.trim();
      }
      aggregateBySession.set(row.sessionFile, existing);
    }

    const hits = Array.from(aggregateBySession.entries()).map(([sessionFile, aggregate]) => {
      const sessionBoost = aggregate.sessionRank === undefined ? 0 : Math.max(0, 120 - aggregate.sessionRank);
      const segmentBoost = aggregate.segmentRank === undefined ? 0 : Math.max(0, 180 - aggregate.segmentRank);
      const repeatedSegmentBoost = Math.min(aggregate.segmentHits, 6) * 8;
      const mixedBoost = aggregate.sessionRank !== undefined && aggregate.segmentRank !== undefined ? 12 : 0;

      const source: SearchHit["source"] =
        aggregate.sessionRank !== undefined && aggregate.segmentRank !== undefined
          ? "mixed"
          : aggregate.segmentRank !== undefined
            ? "summary"
            : "session";

      return {
        sessionFile,
        matchSnippet: aggregate.segmentSnippet ?? aggregate.sessionSnippet,
        scoreBoost: sessionBoost + segmentBoost + repeatedSegmentBoost + mixedBoost,
        source,
        summaryHitCount: aggregate.segmentHits,
      } satisfies SearchHit;
    });

    hits.sort((a, b) => {
      if (a.scoreBoost !== b.scoreBoost) return b.scoreBoost - a.scoreBoost;
      return a.sessionFile.localeCompare(b.sessionFile);
    });

    return hits.slice(0, limit);
  }

  count(): number {
    return (this.countStmt.get() as { count: number }).count;
  }
}

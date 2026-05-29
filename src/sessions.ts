import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, relative } from "node:path";
import readline from "node:readline";
import { SessionSearchDb } from "./search-db.js";
import type {
  SessionDetail,
  SessionLabelRecord,
  SessionPathMention,
  SessionPreviewEntry,
  SessionProject,
  SessionSearchDocument,
  SessionSearchMatch,
  SessionSearchResult,
  SessionSummary,
  SessionTranscript,
  SessionTreeNode,
  SessionTreeStats,
} from "./types.js";

type PiMessageLike = {
  role?: string;
  content?: unknown;
};

type SessionIndexEntry = {
  mtimeMs: number;
  summary: SessionSummary;
};

type ParsedQuery = {
  raw: string;
  freeTerms: string[];
  labelTerms: string[];
  projectTerms: string[];
};

type EntryInfo = {
  role: string;
  text: string;
};

type RawVisibleNode = {
  id: string;
  parentId?: string;
  kind: SessionTreeNode["kind"];
  label: string;
  text: string;
  timestamp?: string;
  order: number;
};

type SessionSortMode = "smart" | "best" | "newest" | "oldest" | "entries";

const HOME = homedir();
const DEFAULT_SESSIONS_DIR = join(HOME, ".pi", "agent", "sessions");
const DEFAULT_INDEX_DB = join(HOME, ".cache", "pi-session-browser", "sessions.sqlite");
const MAX_SEARCH_SNIPPETS = 160;
const MAX_SEARCH_TEXT_CHARS = 80_000;
const PREVIEW_HEAD = 6;
const PREVIEW_TAIL = 24;
const MAX_PATH_MENTIONS = 8;
const MAX_SESSION_SEARCH_MATCHES = 16;
const MATCH_CONTEXT_RADIUS = 1;
const PATH_REGEX = /(?:~\/[^\s"'`()\[\]{}<>]+|\/[^\s"'`()\[\]{}<>]+|\.\/[^\s"'`()\[\]{}<>]+)/g;
const SPACED_PATH_REGEX = /(?:\/Users\/[^\n`]+|~\/[^\n`]+|\.\/[^\n`]+)/g;
const BACKTICK_REGEX = /`([^`]+)`/g;
const FILE_ENDING_REGEX = /(.+?\.(?:md|json|jsonl|ts|tsx|js|jsx|jl|py|tex|pdf|png|jpg|jpeg|html|csv|txt))(?:$|[^A-Za-z0-9._-])/i;

function shorten(text: string | undefined, max = 180): string | undefined {
  if (!text) return undefined;
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1)}...`;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function slugify(text: string | undefined, fallback = "session"): string {
  const base = (text ?? fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return base || fallback;
}

function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z0-9._/-]+/g);
  return matches ?? [];
}

function parseQuery(rawQuery: string | undefined): ParsedQuery {
  const raw = (rawQuery ?? "").trim();
  const labelTerms: string[] = [];
  const projectTerms: string[] = [];
  const freeTerms: string[] = [];

  for (const token of raw.split(/\s+/).filter(Boolean)) {
    if (token.startsWith("label:")) {
      const value = token.slice("label:".length).trim().toLowerCase();
      if (value) labelTerms.push(value);
      continue;
    }
    if (token.startsWith("project:") || token.startsWith("cwd:")) {
      const value = token.includes(":") ? token.slice(token.indexOf(":") + 1).trim().toLowerCase() : "";
      if (value) projectTerms.push(value);
      continue;
    }
    freeTerms.push(...tokenize(token));
  }

  return { raw, freeTerms, labelTerms, projectTerms };
}

function safeJsonParse(line: string): any | undefined {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function extractTextParts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];

  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const type = (item as { type?: string }).type;
    if (type === "text" && typeof (item as { text?: unknown }).text === "string") {
      parts.push((item as { text: string }).text);
    }
    if (type === "toolCall") {
      const name = typeof (item as { name?: unknown }).name === "string" ? (item as { name: string }).name : "tool";
      parts.push(`[tool call: ${name}]`);
    }
  }
  return parts;
}

function extractToolCallNames(content: unknown): string[] {
  if (!Array.isArray(content)) return [];

  const names: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    if ((item as { type?: string }).type !== "toolCall") continue;
    if (typeof (item as { name?: unknown }).name === "string") {
      names.push((item as { name: string }).name);
    }
  }
  return names;
}

function messageIsToolOnly(message: PiMessageLike | undefined): boolean {
  if (!message || !Array.isArray(message.content)) return false;

  let sawToolCall = false;
  for (const item of message.content) {
    if (!item || typeof item !== "object") continue;
    const type = (item as { type?: string }).type;
    if (type === "toolCall") {
      sawToolCall = true;
      continue;
    }
    if (type === "text" && typeof (item as { text?: unknown }).text === "string") {
      if ((item as { text: string }).text.trim()) return false;
      continue;
    }
  }

  return sawToolCall;
}

function summarizeToolCalls(names: string[]): string {
  if (names.length === 0) return "tools";

  const counts = new Map<string, number>();
  for (const name of names) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  const parts = Array.from(counts.entries())
    .sort((a, b) => (b[1] === a[1] ? a[0].localeCompare(b[0]) : b[1] - a[1]))
    .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name));

  const shown = parts.slice(0, 5);
  const suffix = parts.length > shown.length ? ` +${parts.length - shown.length} more` : "";
  return `tools: ${shown.join(", ")}${suffix}`;
}

function extractMessageText(message: PiMessageLike | undefined): string | undefined {
  if (!message) return undefined;
  const text = extractTextParts(message.content).join("\n").trim();
  return text || undefined;
}

function isVisibleEntry(entry: any): boolean {
  if (!entry || typeof entry !== "object") return false;
  if (entry.type === "compaction" || entry.type === "branch_summary" || entry.type === "custom_message") return true;
  if (entry.type !== "message") return false;
  const role = entry.message?.role;
  return role === "user" || role === "assistant";
}

function entryToVisibleNode(entry: any, order: number): RawVisibleNode | undefined {
  if (!isVisibleEntry(entry)) return undefined;

  if (entry.type === "compaction") {
    const text = typeof entry.summary === "string" ? shorten(entry.summary, 220) ?? entry.summary : "Compaction summary";
    return {
      id: entry.id,
      parentId: typeof entry.parentId === "string" ? entry.parentId : undefined,
      kind: "compaction",
      label: "compaction",
      text,
      timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined,
      order,
    };
  }

  if (entry.type === "branch_summary") {
    const text = typeof entry.summary === "string" ? shorten(entry.summary, 220) ?? entry.summary : "Branch summary";
    return {
      id: entry.id,
      parentId: typeof entry.parentId === "string" ? entry.parentId : undefined,
      kind: "branchSummary",
      label: "branch summary",
      text,
      timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined,
      order,
    };
  }

  if (entry.type === "custom_message") {
    const text = typeof entry.content === "string" ? shorten(entry.content, 220) ?? entry.content : "custom message";
    return {
      id: entry.id,
      parentId: typeof entry.parentId === "string" ? entry.parentId : undefined,
      kind: "customMessage",
      label: entry.customType ? `custom:${entry.customType}` : "custom",
      text,
      timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined,
      order,
    };
  }

  const message = entry.message as PiMessageLike | undefined;
  const role = message?.role === "user" ? "user" : "assistant";
  const rawText = extractMessageText(message) ?? role;
  const toolCalls = extractToolCallNames(message?.content);

  let label = role;
  let text = shorten(rawText, 220) ?? rawText;
  if (role === "assistant" && toolCalls.length > 0) {
    const toolSummary = summarizeToolCalls(toolCalls);
    if (messageIsToolOnly(message)) {
      label = "assistant/tools";
      text = toolSummary;
    } else if (toolCalls.length >= 2) {
      text = shorten(`${text} · ${toolSummary}`, 220) ?? text;
    }
  }

  return {
    id: entry.id,
    parentId: typeof entry.parentId === "string" ? entry.parentId : undefined,
    kind: role,
    label,
    text,
    timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined,
    order,
  };
}

function entryIdentity(entry: any): Pick<SessionPreviewEntry, "entryId" | "entryType" | "parentId"> {
  return {
    entryId: typeof entry?.id === "string" ? entry.id : undefined,
    entryType: typeof entry?.type === "string" ? entry.type : undefined,
    parentId: typeof entry?.parentId === "string" ? entry.parentId : undefined,
  };
}

function displayPath(absPath: string): string {
  if (absPath.startsWith(HOME)) {
    return `~/${relative(HOME, absPath)}`;
  }
  return absPath;
}

function projectLabelFromCwd(cwd: string): string {
  const base = basename(cwd).trim();
  if (base) return base;
  return cwd;
}

function incrementChildCount(childCounts: Map<string, number>, parentId: unknown): void {
  if (typeof parentId !== "string" || !parentId) return;
  childCounts.set(parentId, (childCounts.get(parentId) ?? 0) + 1);
}

function countBranchPoints(childCounts: Map<string, number>): number {
  let count = 0;
  for (const childCount of childCounts.values()) {
    if (childCount > 1) count += 1;
  }
  return count;
}

function buildSnippet(searchText: string, parsedQuery: ParsedQuery): string | undefined {
  if (!parsedQuery.raw.trim()) return undefined;

  const cleaned = searchText.replace(/\s+/g, " ").trim();
  const haystack = cleaned.toLowerCase();
  const preferredTerms = [parsedQuery.raw.toLowerCase(), ...parsedQuery.freeTerms].filter(Boolean);

  for (const term of preferredTerms) {
    const idx = haystack.indexOf(term);
    if (idx === -1) continue;
    const start = Math.max(0, idx - 100);
    const end = Math.min(cleaned.length, idx + term.length + 140);
    const prefix = start > 0 ? "..." : "";
    const suffix = end < cleaned.length ? "..." : "";
    return `${prefix}${cleaned.slice(start, end).trim()}${suffix}`;
  }

  return shorten(cleaned, 220);
}

function excerptAroundTerms(text: string, terms: string[], max = 1200): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;

  const haystack = cleaned.toLowerCase();
  const indexes = terms
    .map((term) => haystack.indexOf(term.toLowerCase()))
    .filter((index) => index >= 0);
  const firstIndex = indexes.length ? Math.min(...indexes) : 0;
  const start = Math.max(0, firstIndex - Math.floor(max * 0.35));
  const end = Math.min(cleaned.length, start + max);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < cleaned.length ? "..." : "";
  return `${prefix}${cleaned.slice(start, end).trim()}${suffix}`;
}

function queryContentTerms(query: string | undefined): string[] {
  return Array.from(new Set(parseQuery(query).freeTerms));
}

function buildSearchMatches(entries: SessionPreviewEntry[], query: string | undefined): SessionSearchMatch[] {
  const terms = queryContentTerms(query);
  if (!terms.length) return [];

  const candidates: Array<SessionSearchMatch & { allTermsMatched: boolean }> = [];
  for (const [index, entry] of entries.entries()) {
    const haystack = normalize(entry.text);
    const matchTerms = terms.filter((term) => haystack.includes(term));
    if (!matchTerms.length) continue;

    const contextStart = Math.max(0, index - MATCH_CONTEXT_RADIUS);
    const contextEnd = Math.min(entries.length, index + MATCH_CONTEXT_RADIUS + 1);
    const context = entries.slice(contextStart, contextEnd).map((contextEntry, contextOffset) => {
      const contextIndex = contextStart + contextOffset;
      const matched = contextIndex === index;
      return {
        entryIndex: contextIndex,
        entryId: contextEntry.entryId,
        entryType: contextEntry.entryType,
        parentId: contextEntry.parentId,
        role: contextEntry.role,
        timestamp: contextEntry.timestamp,
        matched,
        text: excerptAroundTerms(contextEntry.text, matched ? matchTerms : terms, matched ? 1400 : 700),
      };
    });

    candidates.push({
      entryIndex: index,
      entryId: entry.entryId,
      entryType: entry.entryType,
      parentId: entry.parentId,
      role: entry.role,
      timestamp: entry.timestamp,
      matchTerms,
      context,
      allTermsMatched: matchTerms.length === terms.length,
    });
  }

  const preferred = candidates.some((candidate) => candidate.allTermsMatched)
    ? candidates.filter((candidate) => candidate.allTermsMatched)
    : candidates;

  return preferred.slice(0, MAX_SESSION_SEARCH_MATCHES).map(({ allTermsMatched: _allTermsMatched, ...match }) => match);
}

function matchesStructuredFilters(summary: SessionSummary, parsedQuery: ParsedQuery): boolean {
  const projectHaystack = normalize(`${summary.projectLabel} ${summary.cwd}`);
  const labelHaystack = normalize(summary.labels.join(" "));

  for (const term of parsedQuery.projectTerms) {
    if (!projectHaystack.includes(term)) return false;
  }

  for (const term of parsedQuery.labelTerms) {
    if (!labelHaystack.includes(term)) return false;
  }

  return true;
}

function sortSessionResults(results: SessionSearchResult[], sort: SessionSortMode, hasQuery: boolean): SessionSearchResult[] {
  const effectiveSort = sort === "smart" ? (hasQuery ? "best" : "newest") : sort;
  const sorted = [...results];

  sorted.sort((a, b) => {
    if (effectiveSort === "best") {
      const scoreA = a.score ?? 0;
      const scoreB = b.score ?? 0;
      if (scoreA !== scoreB) return scoreB - scoreA;
      return b.updatedAt.localeCompare(a.updatedAt);
    }

    if (effectiveSort === "oldest") {
      return a.updatedAt === b.updatedAt ? a.projectLabel.localeCompare(b.projectLabel) : a.updatedAt.localeCompare(b.updatedAt);
    }

    if (effectiveSort === "entries") {
      if (a.totalEntries !== b.totalEntries) return b.totalEntries - a.totalEntries;
      return b.updatedAt.localeCompare(a.updatedAt);
    }

    return b.updatedAt === a.updatedAt ? a.projectLabel.localeCompare(b.projectLabel) : b.updatedAt.localeCompare(a.updatedAt);
  });

  return sorted;
}

function parseSortMode(value: string | undefined): SessionSortMode {
  if (value === "best" || value === "newest" || value === "oldest" || value === "entries") return value;
  return "smart";
}

function matchSummary(summary: SessionSummary, parsedQuery: ParsedQuery): { score: number; matchSnippet?: string } | undefined {
  const projectHaystack = normalize(`${summary.projectLabel} ${summary.cwd}`);
  const labelHaystack = normalize(summary.labels.join(" "));
  const nameHaystack = normalize(summary.sessionName ?? "");
  const firstPromptHaystack = normalize(summary.firstUserPrompt ?? "");
  const latestPromptHaystack = normalize(summary.latestUserPrompt ?? "");
  const searchHaystack = normalize(summary.searchText);

  let score = 0;
  if (summary.sessionName) score += 2;
  if (summary.labels.length) score += Math.min(summary.labels.length, 3);

  if (parsedQuery.freeTerms.length > 0) {
    for (const term of parsedQuery.freeTerms) {
      if (!searchHaystack.includes(term)) return undefined;

      score += 2;
      if (nameHaystack.includes(term)) score += 9;
      if (labelHaystack.includes(term)) score += 7;
      if (firstPromptHaystack.includes(term)) score += 6;
      if (latestPromptHaystack.includes(term)) score += 5;
      if (projectHaystack.includes(term)) score += 4;
    }

    const normalizedRaw = normalize(parsedQuery.raw);
    if (normalizedRaw && normalizedRaw.includes(" ") && searchHaystack.includes(normalizedRaw)) {
      score += 8;
    }
  }

  return {
    score,
    matchSnippet: buildSnippet(summary.searchText, parsedQuery),
  };
}

function buildDeepLinkPath(sessionFile: string): string {
  return `/#session=${encodeURIComponent(sessionFile)}`;
}

function cleanPathCandidate(candidate: string): string {
  const trimmed = candidate.replace(/[),.;:]+$/, "").trim();
  const fileEndingMatch = trimmed.match(FILE_ENDING_REGEX);
  if (fileEndingMatch?.[1]) return fileEndingMatch[1];
  return trimmed;
}

function looksLikeUsefulPath(candidate: string): boolean {
  if (!candidate || candidate.length < 5) return false;
  if (["/new", "/tree", "/fork", "/resume", "/settings", "/model"].includes(candidate)) return false;
  if (candidate.startsWith("/api/")) return false;
  if (candidate.startsWith("http://") || candidate.startsWith("https://")) return false;
  if (candidate.startsWith("/Users/")) return true;
  if (candidate.startsWith("~/")) return true;
  if (candidate.startsWith("./")) return true;
  if (candidate.startsWith("/") && candidate.split("/").length < 4) return false;
  if (/\.(md|json|jsonl|ts|tsx|js|jsx|jl|py|tex|pdf|png|jpg|jpeg|html|csv|txt)$/i.test(candidate)) return true;
  return candidate.split("/").length >= 4;
}

function extractPathMentions(texts: string[]): SessionPathMention[] {
  const counts = new Map<string, number>();

  const addCandidate = (seenInText: Set<string>, rawCandidate: string) => {
    const candidate = cleanPathCandidate(rawCandidate);
    if (!looksLikeUsefulPath(candidate)) return;

    for (const existing of seenInText) {
      if (existing === candidate || existing.includes(candidate)) return;
      if (candidate.includes(existing)) {
        seenInText.delete(existing);
      }
    }
    seenInText.add(candidate);
  };

  for (const text of texts) {
    const seenInText = new Set<string>();

    for (const backtickMatch of text.matchAll(BACKTICK_REGEX)) {
      addCandidate(seenInText, backtickMatch[1] ?? "");
    }

    for (const spacedMatch of text.matchAll(SPACED_PATH_REGEX)) {
      addCandidate(seenInText, spacedMatch[0] ?? "");
    }

    for (const rawMatch of text.matchAll(PATH_REGEX)) {
      addCandidate(seenInText, rawMatch[0] ?? "");
    }

    for (const candidate of seenInText) {
      counts.set(candidate, (counts.get(candidate) ?? 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .sort((a, b) => (b[1] === a[1] ? a[0].localeCompare(b[0]) : b[1] - a[1]))
    .slice(0, MAX_PATH_MENTIONS)
    .map(([path, count]) => ({ path, count }));
}

function getSessionNoteTitle(summary: Pick<SessionSummary, "sessionName" | "projectLabel" | "firstUserPrompt" | "sessionFile">): string {
  return summary.sessionName
    ?? shorten(summary.firstUserPrompt, 96)
    ?? summary.projectLabel
    ?? basename(summary.sessionFile);
}

function buildNoteFileName(summary: SessionSummary): string {
  const date = (summary.createdAt ?? summary.updatedAt).slice(0, 10);
  const slug = slugify(summary.sessionName ?? summary.projectLabel ?? summary.firstUserPrompt, "session");
  return `${date}_${slug}_${summary.sessionId.slice(0, 8)}.md`;
}

function buildTreeStats(summary: SessionSummary): SessionTreeStats {
  return {
    branchPoints: summary.branchPointCount,
    compactions: summary.compactionCount,
    branchSummaries: summary.branchSummaryCount,
    labeledEntries: summary.labels.length,
  };
}

function buildVisibleTree(params: {
  visibleNodes: RawVisibleNode[];
  parentById: Map<string, string | undefined>;
  labelByVisibleId: Map<string, string[]>;
  activeLeafId?: string;
}): SessionTreeNode[] {
  const { visibleNodes, parentById, labelByVisibleId, activeLeafId } = params;
  const visibleById = new Map(visibleNodes.map((node) => [node.id, node]));

  const visibleParentById = new Map<string, string | undefined>();
  for (const node of visibleNodes) {
    let current = node.parentId;
    while (current) {
      if (visibleById.has(current)) {
        visibleParentById.set(node.id, current);
        break;
      }
      current = parentById.get(current);
    }
    if (!visibleParentById.has(node.id)) visibleParentById.set(node.id, undefined);
  }

  const activePath = new Set<string>();
  let cursor = activeLeafId;
  while (cursor) {
    activePath.add(cursor);
    cursor = visibleParentById.get(cursor);
  }

  const nodeMap = new Map<string, SessionTreeNode>();
  for (const node of visibleNodes) {
    nodeMap.set(node.id, {
      id: node.id,
      kind: node.kind,
      label: node.label,
      text: node.text,
      timestamp: node.timestamp,
      active: activePath.has(node.id),
      labels: [...(labelByVisibleId.get(node.id) ?? [])].sort(),
      children: [],
    });
  }

  const roots: SessionTreeNode[] = [];
  const childrenByParent = new Map<string, SessionTreeNode[]>();
  for (const node of visibleNodes) {
    const built = nodeMap.get(node.id)!;
    const parentId = visibleParentById.get(node.id);
    if (!parentId) {
      roots.push(built);
      continue;
    }
    const siblings = childrenByParent.get(parentId) ?? [];
    siblings.push(built);
    childrenByParent.set(parentId, siblings);
  }

  const orderById = new Map(visibleNodes.map((node) => [node.id, node.order]));
  const attachChildren = (treeNode: SessionTreeNode) => {
    const children = childrenByParent.get(treeNode.id) ?? [];
    children.sort((a, b) => (orderById.get(a.id) ?? 0) - (orderById.get(b.id) ?? 0));
    treeNode.children = children;
    for (const child of children) attachChildren(child);
  };

  roots.sort((a, b) => (orderById.get(a.id) ?? 0) - (orderById.get(b.id) ?? 0));
  for (const root of roots) attachChildren(root);
  return roots;
}

function buildSessionNoteMarkdown(input: {
  summary: SessionSummary;
  previewEntries: SessionPreviewEntry[];
  omittedEntryCount: number;
  recentLabels: SessionLabelRecord[];
  pathMentions: SessionPathMention[];
  treeStats: SessionTreeStats;
  deepLinkPath: string;
  resumeCommand: string;
}): string {
  const { summary, previewEntries, omittedEntryCount, recentLabels, pathMentions, treeStats, deepLinkPath, resumeCommand } = input;
  const lines: string[] = [];

  lines.push(`# Session note: ${summary.sessionName ?? summary.projectLabel}`);
  lines.push("");
  lines.push(`- Project: ${displayPath(summary.cwd)}`);
  lines.push(`- Session file: ${summary.sessionFile}`);
  lines.push(`- Resume: \`${resumeCommand}\``);
  if (summary.createdAt) lines.push(`- Created: ${summary.createdAt}`);
  lines.push(`- Updated: ${summary.updatedAt}`);
  if (summary.labels.length) lines.push(`- Labels: ${summary.labels.join(", ")}`);
  lines.push(`- Tree stats: ${treeStats.branchPoints} branch points, ${treeStats.compactions} compactions, ${treeStats.branchSummaries} branch summaries`);
  if (summary.firstUserPrompt) lines.push(`- First prompt: ${summary.firstUserPrompt}`);
  if (summary.latestUserPrompt && summary.latestUserPrompt !== summary.firstUserPrompt) {
    lines.push(`- Latest user prompt: ${summary.latestUserPrompt}`);
  }

  if (pathMentions.length) {
    lines.push("");
    lines.push("## Key paths");
    lines.push("");
    for (const mention of pathMentions) {
      lines.push(`- ${mention.path}${mention.count > 1 ? ` (${mention.count} mentions)` : ""}`);
    }
  }

  if (recentLabels.length) {
    lines.push("");
    lines.push("## Recent labels");
    lines.push("");
    for (const label of recentLabels.slice(0, 6)) {
      const target = label.targetText ? ` - ${label.targetText}` : "";
      lines.push(`- ${label.label}${target}`);
    }
  }

  lines.push("");
  lines.push("## Transcript excerpt");
  lines.push("");
  for (const entry of previewEntries) {
    lines.push(`### ${entry.role}`);
    lines.push(entry.text);
    lines.push("");
  }
  if (omittedEntryCount > 0) {
    lines.push(`_Omitted ${omittedEntryCount} middle entries from this excerpt._`);
    lines.push("");
  }
  lines.push(`Local viewer link: ${deepLinkPath}`);
  return lines.join("\n").trim();
}

function buildSavedSessionNoteMarkdown(detail: SessionDetail): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`session_id: ${JSON.stringify(detail.sessionId)}`);
  lines.push(`session_file: ${JSON.stringify(detail.sessionFile)}`);
  lines.push(`cwd: ${JSON.stringify(detail.cwd)}`);
  if (detail.sessionName) lines.push(`session_name: ${JSON.stringify(detail.sessionName)}`);
  lines.push(`created_at: ${JSON.stringify(detail.createdAt ?? detail.updatedAt)}`);
  lines.push(`updated_at: ${JSON.stringify(detail.updatedAt)}`);
  if (detail.labels.length) {
    lines.push("labels:");
    for (const label of detail.labels) lines.push(`  - ${JSON.stringify(label)}`);
  }
  lines.push("---");
  lines.push("");
  lines.push(detail.noteMarkdown);
  return lines.join("\n");
}

function demoteMarkdownHeadings(markdown: string, levels = 1): string {
  return markdown.replace(/^(#{1,6})(\s+)/gm, (_match, hashes: string, spacing: string) => {
    return `${"#".repeat(Math.min(6, hashes.length + levels))}${spacing}`;
  });
}

function sortCounts(counts: Map<string, number>): Array<[string, number]> {
  return Array.from(counts.entries())
    .sort((a, b) => (b[1] === a[1] ? a[0].localeCompare(b[0]) : b[1] - a[1]));
}

function buildBundleFileName(details: SessionDetail[]): string {
  const latestUpdatedAt = details.map((detail) => detail.updatedAt).sort().at(-1) ?? "bundle";
  const uniqueProjects = Array.from(new Set(details.map((detail) => detail.projectLabel).filter(Boolean)));
  const base = uniqueProjects.length === 1
    ? `bundle-${uniqueProjects[0]}`
    : `bundle-${getSessionNoteTitle(details[0])}`;
  const firstId = details[0]?.sessionId.slice(0, 4) ?? "sess";
  const lastId = details.at(-1)?.sessionId.slice(0, 4) ?? firstId;
  return `${latestUpdatedAt.slice(0, 10)}_${slugify(base, "session-bundle")}_${details.length}_${firstId}${lastId}.md`;
}

function buildSessionBundleMarkdown(details: SessionDetail[]): string {
  const uniqueProjects = Array.from(new Set(details.map((detail) => detail.projectLabel).filter(Boolean)));
  const startTimestamps = details.map((detail) => detail.createdAt ?? detail.updatedAt).filter(Boolean).sort();
  const updatedTimestamps = details.map((detail) => detail.updatedAt).filter(Boolean).sort();
  const labelCounts = new Map<string, number>();
  const pathCounts = new Map<string, number>();

  for (const detail of details) {
    for (const label of detail.labels) {
      labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    }
    for (const mention of detail.pathMentions) {
      pathCounts.set(mention.path, (pathCounts.get(mention.path) ?? 0) + mention.count);
    }
  }

  const totalUserMessages = details.reduce((sum, detail) => sum + detail.userMessageCount, 0);
  const totalAssistantMessages = details.reduce((sum, detail) => sum + detail.assistantMessageCount, 0);
  const totalEntries = details.reduce((sum, detail) => sum + detail.totalEntries, 0);
  const totalBranches = details.reduce((sum, detail) => sum + detail.treeStats.branchPoints, 0);
  const totalCompactions = details.reduce((sum, detail) => sum + detail.treeStats.compactions, 0);
  const totalBranchSummaries = details.reduce((sum, detail) => sum + detail.treeStats.branchSummaries, 0);
  const commonLabels = sortCounts(labelCounts).slice(0, 12);
  const commonPaths = sortCounts(pathCounts).slice(0, 12);
  const bundleTitle = uniqueProjects.length === 1
    ? `Session bundle: ${uniqueProjects[0]}`
    : `Session bundle: ${details.length} selected sessions`;

  const lines: string[] = [];
  lines.push("---");
  lines.push("bundle_type: \"session_bundle\"");
  lines.push(`session_count: ${details.length}`);
  if (startTimestamps[0]) lines.push(`date_range_start: ${JSON.stringify(startTimestamps[0])}`);
  if (updatedTimestamps.length) lines.push(`date_range_end: ${JSON.stringify(updatedTimestamps.at(-1))}`);
  if (uniqueProjects.length) {
    lines.push("projects:");
    for (const project of uniqueProjects) lines.push(`  - ${JSON.stringify(project)}`);
  }
  lines.push("session_files:");
  for (const detail of details) lines.push(`  - ${JSON.stringify(detail.sessionFile)}`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${bundleTitle}`);
  lines.push("");
  lines.push(`- Sessions: ${details.length}`);
  if (uniqueProjects.length) lines.push(`- Projects: ${uniqueProjects.join(", ")}`);
  if (startTimestamps[0] && updatedTimestamps.length) {
    lines.push(`- Date range: ${startTimestamps[0]} → ${updatedTimestamps.at(-1)}`);
  }
  lines.push(`- Message totals: ${totalUserMessages} user · ${totalAssistantMessages} assistant · ${totalEntries} total entries`);
  lines.push(`- Structure totals: ${totalBranches} branches · ${totalCompactions} compactions · ${totalBranchSummaries} branch summaries`);

  lines.push("");
  lines.push("## Source sessions");
  lines.push("");
  details.forEach((detail, index) => {
    const title = getSessionNoteTitle(detail);
    lines.push(`${index + 1}. **${title}** — ${displayPath(detail.cwd)} · ${detail.updatedAt}`);
    lines.push(`   - Session file: \`${detail.sessionFile}\``);
    lines.push(`   - Resume: \`${detail.resumeCommand}\``);
  });

  if (commonLabels.length) {
    lines.push("");
    lines.push("## Common labels");
    lines.push("");
    for (const [label, count] of commonLabels) {
      lines.push(`- ${label} (${count}/${details.length} sessions)`);
    }
  }

  if (commonPaths.length) {
    lines.push("");
    lines.push("## Frequent path mentions");
    lines.push("");
    for (const [path, count] of commonPaths) {
      lines.push(`- ${path} (${count} mentions)`);
    }
  }

  lines.push("");
  lines.push("## Included session notes");
  lines.push("");
  for (const detail of details) {
    lines.push(demoteMarkdownHeadings(detail.noteMarkdown, 2));
    lines.push("");
  }

  return lines.join("\n").trim();
}

async function* iterSessionFiles(dir: string): AsyncGenerator<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* iterSessionFiles(fullPath);
      continue;
    }
    if (entry.isFile() && extname(entry.name) === ".jsonl") {
      yield fullPath;
    }
  }
}

async function parseSessionSummary(sessionFile: string, mtimeMs: number): Promise<SessionSearchDocument> {
  const searchSnippets: string[] = [];
  const segments: SessionSearchDocument["segments"] = [];
  let sessionId = sessionFile;
  let cwd = "";
  let createdAt: string | undefined;
  let sessionName: string | undefined;
  let firstUserPrompt: string | undefined;
  let latestUserPrompt: string | undefined;
  let userMessageCount = 0;
  let assistantMessageCount = 0;
  let totalEntries = 0;
  let compactionCount = 0;
  let branchSummaryCount = 0;
  const labels = new Set<string>();
  const childCounts = new Map<string, number>();
  let segmentOrder = 0;

  const stream = createReadStream(sessionFile, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    const entry = safeJsonParse(line);
    if (!entry) continue;
    totalEntries += 1;
    incrementChildCount(childCounts, entry.parentId);

    if (entry.type === "session") {
      sessionId = typeof entry.id === "string" ? entry.id : sessionId;
      cwd = typeof entry.cwd === "string" ? entry.cwd : cwd;
      createdAt = typeof entry.timestamp === "string" ? entry.timestamp : createdAt;
      continue;
    }

    if (entry.type === "session_info" && typeof entry.name === "string") {
      sessionName = entry.name.trim() || sessionName;
      continue;
    }

    if (entry.type === "label" && typeof entry.label === "string" && entry.label.trim()) {
      labels.add(entry.label.trim());
      continue;
    }

    if (entry.type === "branch_summary" && typeof entry.summary === "string") {
      branchSummaryCount += 1;
      const summaryText = entry.summary.trim();
      if (summaryText) {
        segments.push({ type: "branchSummary", text: summaryText, order: segmentOrder++ });
      }
      if (searchSnippets.length < MAX_SEARCH_SNIPPETS) {
        searchSnippets.push(shorten(entry.summary, 300) ?? entry.summary);
      }
      continue;
    }

    if (entry.type === "compaction" && typeof entry.summary === "string") {
      compactionCount += 1;
      const summaryText = entry.summary.trim();
      if (summaryText) {
        segments.push({ type: "compaction", text: summaryText, order: segmentOrder++ });
      }
      if (searchSnippets.length < MAX_SEARCH_SNIPPETS) {
        searchSnippets.push(shorten(entry.summary, 300) ?? entry.summary);
      }
      continue;
    }

    if (entry.type !== "message") continue;
    const message = entry.message as PiMessageLike | undefined;
    const role = message?.role;
    const text = extractMessageText(message);
    if (!text) continue;

    if (role === "user") {
      userMessageCount += 1;
      const short = shorten(text, 220) ?? text;
      if (!firstUserPrompt) firstUserPrompt = short;
      latestUserPrompt = short;
    }
    if (role === "assistant") assistantMessageCount += 1;

    if (searchSnippets.length < MAX_SEARCH_SNIPPETS && (role === "user" || role === "assistant" || role === "toolResult")) {
      searchSnippets.push(shorten(text, 300) ?? text);
    }
  }

  const projectId = cwd || sessionFile;
  const projectLabel = projectLabelFromCwd(projectId);
  const searchText = [sessionName, cwd, firstUserPrompt, latestUserPrompt, ...labels, ...searchSnippets]
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .slice(0, MAX_SEARCH_TEXT_CHARS);

  return {
    summary: {
      sessionFile,
      sessionId,
      cwd,
      projectId,
      projectLabel,
      sessionName,
      createdAt,
      updatedAt: new Date(mtimeMs).toISOString(),
      firstUserPrompt,
      latestUserPrompt,
      labels: Array.from(labels).sort(),
      userMessageCount,
      assistantMessageCount,
      totalEntries,
      branchPointCount: countBranchPoints(childCounts),
      compactionCount,
      branchSummaryCount,
      searchText,
    },
    segments,
  };
}

export class SessionIndex {
  readonly sessionsDir: string;
  readonly indexDbPath: string;
  private readonly entries = new Map<string, SessionIndexEntry>();
  private readonly searchDb: SessionSearchDb;
  private lastIndexedAt?: string;

  constructor(sessionsDir = DEFAULT_SESSIONS_DIR, indexDbPath = DEFAULT_INDEX_DB) {
    this.sessionsDir = sessionsDir;
    this.indexDbPath = indexDbPath;
    this.searchDb = new SessionSearchDb(indexDbPath);
  }

  close(): void {
    this.searchDb.close();
  }

  async refresh(): Promise<void> {
    const seen = new Set<string>();
    for await (const sessionFile of iterSessionFiles(this.sessionsDir)) {
      seen.add(sessionFile);
      const stat = await fs.stat(sessionFile);
      const existing = this.entries.get(sessionFile);
      if (existing && existing.mtimeMs === stat.mtimeMs) continue;
      const doc = await parseSessionSummary(sessionFile, stat.mtimeMs);
      this.entries.set(sessionFile, { mtimeMs: stat.mtimeMs, summary: doc.summary });
      this.searchDb.upsert(doc);
    }

    for (const sessionFile of Array.from(this.entries.keys())) {
      if (!seen.has(sessionFile)) {
        this.entries.delete(sessionFile);
        this.searchDb.remove(sessionFile);
      }
    }

    this.lastIndexedAt = new Date().toISOString();
  }

  private collectSessionResults(options?: { projectId?: string; query?: string; limit?: number; sort?: string }): SessionSearchResult[] {
    const parsedQuery = parseQuery(options?.query);
    const hasQuery = Boolean(parsedQuery.raw || parsedQuery.labelTerms.length || parsedQuery.projectTerms.length);
    const sort = parseSortMode(options?.sort);
    let sessions = Array.from(this.entries.values()).map((entry) => entry.summary);

    if (options?.projectId) {
      sessions = sessions.filter((summary) => summary.projectId === options.projectId);
    }

    let results: SessionSearchResult[] = sessions.map((summary) => ({ ...summary }));

    if (hasQuery) {
      const baseLimit = options?.limit ?? this.entries.size ?? 1;
      const searchLimit = Math.max(baseLimit * 4, 200);
      const dbHits = this.searchDb.search(parsedQuery.freeTerms, searchLimit);
      const dbHitMap = new Map(dbHits.map((hit) => [hit.sessionFile, hit]));

      const matchedResults: SessionSearchResult[] = [];
      for (const summary of results) {
        if (!matchesStructuredFilters(summary, parsedQuery)) continue;

        const match = matchSummary(summary, parsedQuery);
        const dbHit = dbHitMap.get(summary.sessionFile);
        if (parsedQuery.freeTerms.length > 0 && !match && !dbHit) continue;

        matchedResults.push({
          ...summary,
          score: (match?.score ?? 0) + (dbHit?.scoreBoost ?? 0),
          matchSnippet: dbHit?.matchSnippet ?? match?.matchSnippet,
        });
      }
      results = matchedResults;
    }

    return sortSessionResults(results, sort, hasQuery);
  }

  getProjects(options?: { query?: string }): SessionProject[] {
    const grouped = new Map<string, SessionProject>();
    for (const { summary } of this.entries.values()) {
      const existing = grouped.get(summary.projectId);
      if (!existing) {
        grouped.set(summary.projectId, {
          projectId: summary.projectId,
          projectLabel: summary.projectLabel,
          sessionCount: 1,
          latestUpdatedAt: summary.updatedAt,
        });
        continue;
      }
      existing.sessionCount += 1;
      if (!existing.latestUpdatedAt || existing.latestUpdatedAt < summary.updatedAt) {
        existing.latestUpdatedAt = summary.updatedAt;
      }
    }

    const hasQuery = Boolean(options?.query?.trim());
    if (!hasQuery) {
      return Array.from(grouped.values()).sort((a, b) => {
        const timeA = a.latestUpdatedAt ?? "";
        const timeB = b.latestUpdatedAt ?? "";
        return timeA === timeB ? a.projectLabel.localeCompare(b.projectLabel) : timeB.localeCompare(timeA);
      });
    }

    const matchedSessions = this.collectSessionResults({ query: options?.query, limit: this.entries.size });
    const matchingCounts = new Map<string, number>();
    const latestMatchingByProject = new Map<string, string>();

    for (const summary of matchedSessions) {
      matchingCounts.set(summary.projectId, (matchingCounts.get(summary.projectId) ?? 0) + 1);
      const currentLatest = latestMatchingByProject.get(summary.projectId);
      if (!currentLatest || currentLatest < summary.updatedAt) {
        latestMatchingByProject.set(summary.projectId, summary.updatedAt);
      }
    }

    return Array.from(grouped.values())
      .map((project) => ({
        ...project,
        matchingSessionCount: matchingCounts.get(project.projectId) ?? 0,
        latestMatchingUpdatedAt: latestMatchingByProject.get(project.projectId),
      }))
      .sort((a, b) => {
        const matchesA = a.matchingSessionCount ?? 0;
        const matchesB = b.matchingSessionCount ?? 0;
        if (matchesA !== matchesB) return matchesB - matchesA;

        const timeA = a.latestMatchingUpdatedAt ?? a.latestUpdatedAt ?? "";
        const timeB = b.latestMatchingUpdatedAt ?? b.latestUpdatedAt ?? "";
        return timeA === timeB ? a.projectLabel.localeCompare(b.projectLabel) : timeB.localeCompare(timeA);
      });
  }

  getSessions(options?: { projectId?: string; query?: string; limit?: number; sort?: string }): SessionSearchResult[] {
    return this.collectSessionResults(options).slice(0, options?.limit ?? 200);
  }

  async getTranscript(sessionFile: string): Promise<SessionTranscript | undefined> {
    const existing = this.entries.get(sessionFile);
    if (!existing) return undefined;

    const entries: SessionTranscript["entries"] = [];
    const stream = createReadStream(sessionFile, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      const entry = safeJsonParse(line);
      if (!entry) continue;

      if (entry.type === "message") {
        const message = entry.message as PiMessageLike | undefined;
        const role = message?.role ?? "message";
        const text = extractMessageText(message);
        if (!text) continue;
        entries.push({ ...entryIdentity(entry), role, timestamp: entry.timestamp, text });
        continue;
      }

      if (entry.type === "branch_summary" && typeof entry.summary === "string") {
        entries.push({ ...entryIdentity(entry), role: "branch summary", timestamp: entry.timestamp, text: entry.summary });
        continue;
      }

      if (entry.type === "compaction" && typeof entry.summary === "string") {
        entries.push({ ...entryIdentity(entry), role: "compaction summary", timestamp: entry.timestamp, text: entry.summary });
        continue;
      }

      if (entry.type === "custom_message" && typeof entry.content === "string") {
        entries.push({
          ...entryIdentity(entry),
          role: entry.customType ? `custom:${entry.customType}` : "custom",
          timestamp: entry.timestamp,
          text: entry.content,
        });
      }
    }

    return { summary: existing.summary, entries };
  }

  async getSessionDetail(sessionFile: string, query?: string): Promise<SessionDetail | undefined> {
    const existing = this.entries.get(sessionFile);
    if (!existing) return undefined;

    const previewEntries: SessionPreviewEntry[] = [];
    const rawEntries: SessionPreviewEntry[] = [];
    const matchEntries: SessionPreviewEntry[] = [];
    const entryInfoById = new Map<string, EntryInfo>();
    const parentById = new Map<string, string | undefined>();
    const visibleNodes: RawVisibleNode[] = [];
    const labelRecords: SessionLabelRecord[] = [];
    const childCounts = new Map<string, number>();
    let branchSummaryCount = 0;
    let compactionCount = 0;
    let order = 0;
    let lastVisibleId: string | undefined;

    const stream = createReadStream(sessionFile, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      const entry = safeJsonParse(line);
      if (!entry) continue;
      incrementChildCount(childCounts, entry.parentId);
      if (typeof entry.id === "string") {
        parentById.set(entry.id, typeof entry.parentId === "string" ? entry.parentId : undefined);
      }

      const visibleNode = entryToVisibleNode(entry, order++);
      if (visibleNode) {
        visibleNodes.push(visibleNode);
        lastVisibleId = visibleNode.id;
      }

      if (entry.type === "message") {
        const message = entry.message as PiMessageLike | undefined;
        const role = message?.role ?? "message";
        const text = extractMessageText(message);
        if (!text) continue;
        const identity = entryIdentity(entry);
        matchEntries.push({ ...identity, role, timestamp: entry.timestamp, text });
        const previewText = shorten(text, 800) ?? text;
        rawEntries.push({ ...identity, role, timestamp: entry.timestamp, text: previewText });
        if (typeof entry.id === "string") {
          entryInfoById.set(entry.id, { role, text: shorten(text, 180) ?? text });
        }
        continue;
      }

      if (entry.type === "label" && typeof entry.label === "string") {
        labelRecords.push({
          label: entry.label,
          timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined,
          targetId: typeof entry.targetId === "string" ? entry.targetId : undefined,
        });
        continue;
      }

      if (entry.type === "custom_message" && typeof entry.content === "string") {
        matchEntries.push({
          ...entryIdentity(entry),
          role: entry.customType ? `custom:${entry.customType}` : "custom",
          timestamp: entry.timestamp,
          text: entry.content,
        });
        continue;
      }

      if ((entry.type === "branch_summary" || entry.type === "compaction") && typeof entry.summary === "string") {
        const role = entry.type === "branch_summary" ? "branch summary" : "compaction summary";
        const identity = entryIdentity(entry);
        matchEntries.push({ ...identity, role, timestamp: entry.timestamp, text: entry.summary });
        rawEntries.push({
          ...identity,
          role,
          timestamp: entry.timestamp,
          text: shorten(entry.summary, 800) ?? entry.summary,
        });
        if (entry.type === "branch_summary") branchSummaryCount += 1;
        if (entry.type === "compaction") compactionCount += 1;
      }
    }

    if (rawEntries.length <= PREVIEW_HEAD + PREVIEW_TAIL) {
      previewEntries.push(...rawEntries);
    } else {
      previewEntries.push(...rawEntries.slice(0, PREVIEW_HEAD));
      previewEntries.push(...rawEntries.slice(-PREVIEW_TAIL));
    }

    const omittedEntryCount = Math.max(0, rawEntries.length - previewEntries.length);

    const visibleNodeById = new Map(visibleNodes.map((node) => [node.id, node]));
    const nearestVisibleTarget = (targetId: string | undefined): string | undefined => {
      let cursor = targetId;
      while (cursor) {
        if (visibleNodeById.has(cursor)) return cursor;
        cursor = parentById.get(cursor);
      }
      return undefined;
    };

    const labelByVisibleId = new Map<string, string[]>();
    for (const record of labelRecords) {
      const visibleTargetId = nearestVisibleTarget(record.targetId);
      if (!visibleTargetId) continue;
      const labels = labelByVisibleId.get(visibleTargetId) ?? [];
      labels.push(record.label);
      labelByVisibleId.set(visibleTargetId, labels);
    }

    const recentLabels = labelRecords
      .map((record) => {
        const visibleTargetId = nearestVisibleTarget(record.targetId);
        const target = visibleTargetId ? entryInfoById.get(visibleTargetId) ?? (visibleNodeById.has(visibleTargetId) ? {
          role: visibleNodeById.get(visibleTargetId)?.label ?? "entry",
          text: visibleNodeById.get(visibleTargetId)?.text ?? "",
        } : undefined) : undefined;
        return {
          ...record,
          targetId: visibleTargetId ?? record.targetId,
          targetRole: target?.role,
          targetText: target?.text,
        } satisfies SessionLabelRecord;
      })
      .sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""))
      .slice(0, 8);

    const searchMatches = buildSearchMatches(matchEntries, query);
    const pathMentions = extractPathMentions(rawEntries.map((entry) => entry.text));
    const deepLinkPath = buildDeepLinkPath(existing.summary.sessionFile);
    const resumeCommand = `pi --session \"${existing.summary.sessionFile}\"`;
    const treeStats: SessionTreeStats = {
      branchPoints: countBranchPoints(childCounts),
      compactions: compactionCount,
      branchSummaries: branchSummaryCount,
      labeledEntries: existing.summary.labels.length,
    };
    const tree = buildVisibleTree({
      visibleNodes,
      parentById,
      labelByVisibleId,
      activeLeafId: lastVisibleId,
    });
    const noteFileName = buildNoteFileName(existing.summary);

    const detailBase = {
      ...existing.summary,
      previewEntries,
      omittedEntryCount,
      searchMatches,
      resumeCommand,
      deepLinkPath,
      recentLabels,
      pathMentions,
      treeStats,
      tree,
      noteFileName,
    };

    const detail: SessionDetail = {
      ...detailBase,
      noteMarkdown: buildSessionNoteMarkdown({
        summary: existing.summary,
        previewEntries,
        omittedEntryCount,
        recentLabels,
        pathMentions,
        treeStats,
        deepLinkPath,
        resumeCommand,
      }),
    };

    return detail;
  }

  private async getSessionDetails(sessionFiles: string[]): Promise<SessionDetail[]> {
    const details: SessionDetail[] = [];
    for (const sessionFile of Array.from(new Set(sessionFiles.filter(Boolean)))) {
      const detail = await this.getSessionDetail(sessionFile);
      if (detail) details.push(detail);
    }
    return details;
  }

  async writeNote(sessionFile: string, notesDir: string): Promise<{ path: string; markdown: string; session: SessionDetail } | undefined> {
    const detail = await this.getSessionDetail(sessionFile);
    if (!detail) return undefined;

    await fs.mkdir(notesDir, { recursive: true });
    const outPath = join(notesDir, detail.noteFileName);
    const markdown = buildSavedSessionNoteMarkdown(detail);
    await fs.writeFile(outPath, markdown, "utf8");
    return { path: outPath, markdown, session: detail };
  }

  async writeBundle(sessionFiles: string[], notesDir: string): Promise<{ path: string; markdown: string; fileName: string; sessions: SessionDetail[] } | undefined> {
    const details = await this.getSessionDetails(sessionFiles);
    if (!details.length) return undefined;

    await fs.mkdir(notesDir, { recursive: true });
    const fileName = buildBundleFileName(details);
    const outPath = join(notesDir, fileName);
    const markdown = buildSessionBundleMarkdown(details);
    await fs.writeFile(outPath, markdown, "utf8");
    return { path: outPath, markdown, fileName, sessions: details };
  }

  getStats(): { sessions: number; indexedDocs: number; projects: number; lastIndexedAt?: string; sessionsDir: string; indexDbPath: string } {
    return {
      sessions: this.entries.size,
      indexedDocs: this.searchDb.count(),
      projects: this.getProjects().length,
      lastIndexedAt: this.lastIndexedAt,
      sessionsDir: this.sessionsDir,
      indexDbPath: this.indexDbPath,
    };
  }
}

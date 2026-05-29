export type SessionSummary = {
  sessionFile: string;
  sessionId: string;
  cwd: string;
  projectId: string;
  projectLabel: string;
  sessionName?: string;
  createdAt?: string;
  updatedAt: string;
  firstUserPrompt?: string;
  latestUserPrompt?: string;
  labels: string[];
  userMessageCount: number;
  assistantMessageCount: number;
  totalEntries: number;
  branchPointCount: number;
  compactionCount: number;
  branchSummaryCount: number;
  searchText: string;
};

export type SessionProject = {
  projectId: string;
  projectLabel: string;
  sessionCount: number;
  matchingSessionCount?: number;
  latestUpdatedAt?: string;
  latestMatchingUpdatedAt?: string;
};

export type SessionPreviewEntry = {
  role: string;
  timestamp?: string;
  text: string;
};

export type SessionSearchMatchContextEntry = SessionPreviewEntry & {
  matched: boolean;
};

export type SessionSearchMatch = {
  entryIndex: number;
  role: string;
  timestamp?: string;
  matchTerms: string[];
  context: SessionSearchMatchContextEntry[];
};

export type SessionTranscriptEntry = {
  role: string;
  timestamp?: string;
  text: string;
};

export type SessionTranscript = {
  summary: SessionSummary;
  entries: SessionTranscriptEntry[];
};

export type SessionSearchResult = SessionSummary & {
  matchSnippet?: string;
  score?: number;
};

export type SessionLabelRecord = {
  label: string;
  timestamp?: string;
  targetId?: string;
  targetRole?: string;
  targetText?: string;
};

export type SessionPathMention = {
  path: string;
  count: number;
};

export type SessionSearchSegment = {
  type: "compaction" | "branchSummary";
  text: string;
  order: number;
};

export type SessionSearchDocument = {
  summary: SessionSummary;
  segments: SessionSearchSegment[];
};

export type SessionTreeStats = {
  branchPoints: number;
  compactions: number;
  branchSummaries: number;
  labeledEntries: number;
};

export type SessionTreeNode = {
  id: string;
  kind: "user" | "assistant" | "compaction" | "branchSummary" | "customMessage";
  label: string;
  text: string;
  timestamp?: string;
  active: boolean;
  labels: string[];
  children: SessionTreeNode[];
};

export type SessionDetail = SessionSummary & {
  previewEntries: SessionPreviewEntry[];
  omittedEntryCount: number;
  searchMatches: SessionSearchMatch[];
  noteMarkdown: string;
  resumeCommand: string;
  deepLinkPath: string;
  recentLabels: SessionLabelRecord[];
  pathMentions: SessionPathMention[];
  treeStats: SessionTreeStats;
  tree: SessionTreeNode[];
  noteFileName: string;
};

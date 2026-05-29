const state = {
  projects: [],
  sessions: [],
  selectedProject: null,
  selectedSessionFile: null,
  selectedSessionDetail: null,
  selectedSessionFiles: new Set(),
  query: "",
  sessionSort: "smart",
  notesDir: "",
  configInfo: null,
  conversationMode: "timeline",
  treeMode: "all",
  focusedTreeNodeId: null,
};

const els = {
  search: document.querySelector("#search"),
  changeNotesDir: document.querySelector("#change-notes-dir"),
  refresh: document.querySelector("#refresh"),
  stats: document.querySelector("#stats"),
  projects: document.querySelector("#projects"),
  sessions: document.querySelector("#sessions"),
  sessionSort: document.querySelector("#session-sort"),
  sessionCount: document.querySelector("#session-count"),
  sessionSelectionBar: document.querySelector("#session-selection-bar"),
  detail: document.querySelector("#detail"),
  detailEmpty: document.querySelector("#detail-empty"),
  notesDirDialog: document.querySelector("#notes-dir-dialog"),
  notesDirForm: document.querySelector("#notes-dir-form"),
  notesDirInput: document.querySelector("#notes-dir-input"),
  notesGlobalPath: document.querySelector("#notes-global-path"),
  notesProjectPath: document.querySelector("#notes-project-path"),
  notesDirStatus: document.querySelector("#notes-dir-status"),
  notesDirCancel: document.querySelector("#notes-dir-cancel"),
  notesDirSave: document.querySelector("#notes-dir-save"),
};

const appliedThemeVariables = new Set();

function escapeHtml(text = "") {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeRegExp(text = "") {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getSearchTerms(query = state.query) {
  const terms = new Set();
  for (const token of String(query || "").split(/\s+/).filter(Boolean)) {
    if (/^(label|project|cwd):/i.test(token)) continue;
    for (const piece of token.toLowerCase().split(/[^a-z0-9]+/)) {
      if (piece) terms.add(piece);
    }
  }
  return Array.from(terms);
}

function highlightText(text = "", terms = getSearchTerms()) {
  if (!terms.length) return escapeHtml(text);
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi");
  return String(text).split(pattern).map((part) => {
    const matched = terms.some((term) => part.toLowerCase() === term.toLowerCase());
    return matched ? `<mark>${escapeHtml(part)}</mark>` : escapeHtml(part);
  }).join("");
}

function normalizeWhitespace(text = "") {
  return String(text).replace(/\s+/g, " ").trim();
}

function truncateText(text = "", maxLength = 120) {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function comparableText(text = "") {
  return normalizeWhitespace(text)
    .toLowerCase()
    .replaceAll("…", "")
    .replace(/[‘’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isHomeLikeCwd(cwd = "") {
  const normalized = normalizeWhitespace(cwd);
  return /^\/Users\/[^/]+\/?$/.test(normalized)
    || /^\/home\/[^/]+\/?$/.test(normalized)
    || /^[A-Za-z]:\\Users\\[^\\]+\\?$/.test(normalized);
}

function derivePromptTitle(firstPrompt = "") {
  const normalized = normalizeWhitespace(firstPrompt);
  if (!normalized) return "";

  let title = normalized
    .replace(/^Output a bash one-liner between <cmd> and <\/cmd> tags to:\s*/i, "")
    .replace(/^Output ONLY the shell command\. No markdown, no backticks, no explanation\. Just the raw command\.\s*/i, "")
    .replace(/^(?:hi|hello|hey)[,!\s]+/i, "")
    .replace(/^(?:can|could|would|will)\s+you\s+/i, "")
    .replace(/^(?:please\s+)?(?:just\s+)?/i, "")
    .replace(/[?.!]+$/g, "")
    .trim();

  if (!title) title = normalized;
  title = title.charAt(0).toUpperCase() + title.slice(1);
  return truncateText(title, 72);
}

function isPromptDerivedSessionName(sessionName, firstPrompt) {
  const comparableName = comparableText(sessionName);
  const comparablePrompt = comparableText(firstPrompt);
  if (!comparableName || !comparablePrompt) return false;
  if (comparableName === comparablePrompt) return true;

  const [shorter, longer] = comparableName.length <= comparablePrompt.length
    ? [comparableName, comparablePrompt]
    : [comparablePrompt, comparableName];

  return shorter.length >= 24 && longer.startsWith(shorter);
}

function getSessionDisplay(session) {
  const sessionName = normalizeWhitespace(session.sessionName || "");
  const firstPrompt = normalizeWhitespace(session.firstUserPrompt || "");
  const projectLabel = normalizeWhitespace(session.projectLabel || "");
  const informativeProject = projectLabel && !isHomeLikeCwd(session.cwd || "");
  const promptDerivedName = sessionName && isPromptDerivedSessionName(sessionName, firstPrompt);
  const promptTitle = derivePromptTitle(firstPrompt);

  if (sessionName && !promptDerivedName) {
    return {
      title: sessionName,
      source: "sessionName",
      derived: false,
      metaContext: projectLabel && comparableText(projectLabel) !== comparableText(sessionName) ? projectLabel : "",
      secondaryText: promptTitle && comparableText(promptTitle) !== comparableText(sessionName) ? promptTitle : "",
    };
  }

  if (informativeProject) {
    return {
      title: projectLabel,
      source: "project",
      derived: true,
      metaContext: "",
      secondaryText: promptTitle && comparableText(promptTitle) !== comparableText(projectLabel) ? promptTitle : "",
    };
  }

  if (promptTitle) {
    return {
      title: promptTitle,
      source: "prompt",
      derived: true,
      metaContext: projectLabel && comparableText(projectLabel) !== comparableText(promptTitle) ? projectLabel : "",
      secondaryText: "",
    };
  }

  if (projectLabel) {
    return {
      title: projectLabel,
      source: "project",
      derived: true,
      metaContext: "",
      secondaryText: "",
    };
  }

  if (sessionName) {
    return {
      title: sessionName,
      source: "sessionName",
      derived: false,
      metaContext: "",
      secondaryText: "",
    };
  }

  return {
    title: "Session",
    source: "fallback",
    derived: true,
    metaContext: "",
    secondaryText: "",
  };
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function setHashForSession(sessionFile) {
  const url = new URL(window.location.href);
  url.hash = `session=${encodeURIComponent(sessionFile)}`;
  window.history.replaceState({}, "", url);
}

function buildTranscriptUrl(sessionFile, entryNumber) {
  const url = new URL("/transcript", window.location.origin);
  url.searchParams.set("path", sessionFile);
  if (state.query) url.searchParams.set("q", state.query);
  if (entryNumber) url.hash = `entry-${entryNumber}`;
  return url.toString();
}

function getHashSession() {
  const hash = window.location.hash.replace(/^#/, "");
  const params = new URLSearchParams(hash);
  return params.get("session");
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function flashButton(button, nextLabel, task) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = nextLabel;
  try {
    return await task();
  } finally {
    setTimeout(() => {
      button.disabled = false;
      button.textContent = original;
    }, 1200);
  }
}

function formatTreeStats(session) {
  return `${session.treeStats.branchPoints} branches · ${session.treeStats.compactions} compactions · ${session.treeStats.branchSummaries} branch summaries`;
}

function visitTree(nodes, visit) {
  for (const node of nodes ?? []) {
    visit(node);
    visitTree(node.children ?? [], visit);
  }
}

function countTreeNodes(nodes) {
  let count = 0;
  visitTree(nodes, () => {
    count += 1;
  });
  return count;
}

function findTreeNode(nodes, targetId) {
  if (!targetId) return null;
  let found = null;
  visitTree(nodes, (node) => {
    if (!found && node.id === targetId) found = node;
  });
  return found;
}

function findTreePathIds(nodes, targetId) {
  if (!targetId) return new Set();

  const visit = (node) => {
    if (node.id === targetId) return [node.id];
    for (const child of node.children ?? []) {
      const path = visit(child);
      if (path) return [node.id, ...path];
    }
    return null;
  };

  for (const root of nodes ?? []) {
    const path = visit(root);
    if (path) return new Set(path);
  }

  return new Set();
}

function filterTreeNodes(nodes, mode, focusPathIds = new Set()) {
  const keepMode = (node, keptChildren) => {
    if (mode === "all") return true;
    if (mode === "active") return node.active || keptChildren.length > 0;

    const important =
      node.active ||
      focusPathIds.has(node.id) ||
      (node.labels?.length ?? 0) > 0 ||
      (node.children?.length ?? 0) > 1;

    return important || keptChildren.length > 0;
  };

  return (nodes ?? []).flatMap((node) => {
    const keptChildren = filterTreeNodes(node.children ?? [], mode, focusPathIds);
    if (!keepMode(node, keptChildren)) return [];
    return [{ ...node, children: keptChildren }];
  });
}

function scrollTreeNodeIntoView(nodeId) {
  if (!nodeId) return;
  const target = Array.from(els.detail.querySelectorAll("[data-tree-node]"))
    .find((element) => element.dataset.treeNode === nodeId);
  target?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function focusTreeNode(nodeId, options = {}) {
  if (!state.selectedSessionDetail || !nodeId) return;
  state.focusedTreeNodeId = nodeId;
  if (options.treeMode) state.treeMode = options.treeMode;
  if (options.conversationMode) state.conversationMode = options.conversationMode;
  renderDetail(state.selectedSessionDetail);
  if (options.scroll !== false) {
    requestAnimationFrame(() => scrollTreeNodeIntoView(nodeId));
  }
}

function flattenTreeRows(nodes, branchDepth = 0, rows = []) {
  for (const node of nodes ?? []) {
    rows.push({ node, branchDepth });
    const nextDepth = branchDepth + ((node.children?.length ?? 0) > 1 ? 1 : 0);
    flattenTreeRows(node.children ?? [], nextDepth, rows);
  }
  return rows;
}

function renderTreeNodes(nodes) {
  if (!nodes?.length) {
    return '<p class="muted small">No visible branch structure available for this filter.</p>';
  }

  const rows = flattenTreeRows(nodes);
  const maxBranchDepth = rows.reduce((max, row) => Math.max(max, row.branchDepth), 0);
  const railWidth = maxBranchDepth > 0 ? `${maxBranchDepth * 1.2}rem` : "0px";

  return `
    <div class="tree-flat" style="--tree-rail-width: ${railWidth}">
      ${rows.map(({ node, branchDepth }) => {
        const badges = [];
        if ((node.children?.length ?? 0) > 1) {
          badges.push(`<span class="tag">branch ×${node.children.length}</span>`);
        }
        for (const label of node.labels ?? []) {
          badges.push(`<span class="tag">${escapeHtml(label)}</span>`);
        }

        const lanes = Array.from({ length: maxBranchDepth }, (_, laneIndex) => {
          const active = laneIndex < branchDepth;
          const current = laneIndex === branchDepth - 1;
          return `<span class="tree-lane ${active ? "active" : ""} ${current ? "current" : ""}"></span>`;
        }).join("");

        return `
          <div class="tree-row ${branchDepth > 0 ? "branched" : "rooted"}" data-branch-depth="${branchDepth}">
            <div class="tree-lanes" aria-hidden="true">${lanes}</div>
            <div class="tree-node ${node.active ? "active" : ""} ${state.focusedTreeNodeId === node.id ? "focused" : ""} ${(node.children?.length ?? 0) > 1 ? "branching" : ""}" data-tree-node="${escapeHtml(node.id)}">
              <div class="tree-node-header">
                <span class="tree-kind">${escapeHtml(node.label)}</span>
                ${node.timestamp ? `<time>${escapeHtml(formatDate(node.timestamp))}</time>` : ""}
              </div>
              <div class="tree-text">${escapeHtml(node.text)}</div>
              ${badges.length ? `<div class="tag-row">${badges.join("")}</div>` : ""}
            </div>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function renderTimelineEntries(session) {
  return `
    ${session.omittedEntryCount > 0 ? `<p class="muted small">Showing a transcript excerpt: omitted ${session.omittedEntryCount} middle entries from this session.</p>` : ""}
    <div class="timeline-list">
      ${session.previewEntries.map((entry) => {
        const roleClass = String(entry.role || "message").toLowerCase().replace(/[^a-z0-9]+/g, "-");
        return `
          <section class="timeline-entry timeline-${escapeHtml(roleClass)}">
            <div class="timeline-marker" aria-hidden="true"></div>
            <div class="timeline-card preview-entry">
              <div class="preview-entry-role">${escapeHtml(entry.role)} ${entry.timestamp ? `<time>${escapeHtml(formatDate(entry.timestamp))}</time>` : ""}</div>
              <div>${escapeHtml(entry.text)}</div>
            </div>
          </section>
        `;
      }).join("")}
    </div>
  `;
}

function renderSearchMatches(session) {
  const terms = getSearchTerms();
  if (!terms.length) return "";

  const matches = session.searchMatches || [];
  if (!matches.length) {
    return `
      <section class="detail-section search-matches-section">
        <h3>Search matches</h3>
        <p class="muted small">No direct text hits found inside this session transcript for this query. The result may have matched metadata, labels, project path, or indexed summaries.</p>
      </section>
    `;
  }

  return `
    <section class="detail-section search-matches-section">
      <div class="section-heading-row">
        <h3>Search matches</h3>
        <span class="tag">${matches.length} shown</span>
      </div>
      <p class="muted small">Showing matching turns with one neighbouring turn on each side where available.</p>
      <div class="search-match-list">
        ${matches.map((match, index) => `
          <details class="search-match" ${index < 4 ? "open" : ""}>
            <summary>
              <span>Match ${index + 1}: ${escapeHtml(match.role)}</span>
              <span class="match-summary-actions">
                ${match.timestamp ? `<time>${escapeHtml(formatDate(match.timestamp))}</time>` : ""}
                <button class="mini-button" data-open-transcript-entry="${match.entryIndex + 1}">Open there</button>
              </span>
            </summary>
            <div class="search-context-list">
              ${match.context.map((entry) => `
                <section class="search-context-entry ${entry.matched ? "matched" : ""}">
                  <div class="preview-entry-role">
                    ${escapeHtml(entry.role)} ${entry.timestamp ? `<time>${escapeHtml(formatDate(entry.timestamp))}</time>` : ""}
                    ${entry.matched ? `<span class="tag">match</span>` : ""}
                  </div>
                  <div class="search-context-text">${highlightText(entry.text, terms)}</div>
                </section>
              `).join("")}
            </div>
          </details>
        `).join("")}
      </div>
    </section>
  `;
}

async function loadTheme() {
  try {
    const data = await fetchJson("/api/theme");
    const theme = data.theme;
    const rootStyle = document.documentElement.style;

    for (const variable of appliedThemeVariables) {
      rootStyle.removeProperty(variable);
    }
    appliedThemeVariables.clear();

    if (!theme?.variables) {
      rootStyle.removeProperty("color-scheme");
      return;
    }

    for (const [variable, value] of Object.entries(theme.variables)) {
      if (!value) continue;
      rootStyle.setProperty(variable, value);
      appliedThemeVariables.add(variable);
    }

    if (theme.mode) rootStyle.setProperty("color-scheme", theme.mode);
  } catch {
    // keep CSS defaults if theme loading fails
  }
}

function renderNotesDirButton() {
  const label = state.notesDir ? `Notes: ${truncateText(state.notesDir, 28)}` : "Notes folder…";
  els.changeNotesDir.textContent = label;
  els.changeNotesDir.title = state.notesDir || "Change notes folder";
}

async function loadStats() {
  const data = await fetchJson("/api/health");
  state.notesDir = data.notesDir || data.distillDir || "";
  els.stats.textContent = `${data.sessions} sessions · ${data.indexedDocs} indexed docs · ${data.projects} projects`;
  renderNotesDirButton();
}

async function loadConfig() {
  const data = await fetchJson("/api/config");
  state.configInfo = data;
  if (data.notesDir) state.notesDir = data.notesDir;
  renderNotesDirButton();
}

function openNotesDirDialog() {
  if (!state.configInfo) return;
  els.notesDirInput.value = state.notesDir || "";
  els.notesGlobalPath.textContent = state.configInfo.globalSettingsPath || "";
  els.notesProjectPath.textContent = state.configInfo.projectSettingsPath || "";
  els.notesDirStatus.textContent = `Current effective folder: ${state.notesDir || "not set"}`;
  const defaultScope = els.notesDirForm.querySelector('input[name="notesScope"][value="global"]');
  if (defaultScope) defaultScope.checked = true;
  els.notesDirDialog.showModal();
  requestAnimationFrame(() => {
    els.notesDirInput.focus();
    els.notesDirInput.select();
  });
}

async function saveNotesDirFromDialog() {
  const checkedScope = els.notesDirForm.querySelector('input[name="notesScope"]:checked');
  const scope = checkedScope?.value || "global";
  const notesDir = els.notesDirInput.value.trim();
  if (!notesDir) {
    els.notesDirStatus.textContent = "Enter a folder path first.";
    return;
  }

  els.notesDirStatus.textContent = "Saving…";
  els.notesDirSave.disabled = true;

  try {
    const result = await fetchJson("/api/config/notes-dir", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notesDir, scope }),
    });

    state.notesDir = result.notesDir || state.notesDir;
    await loadConfig();
    renderNotesDirButton();
    if (state.selectedSessionDetail) renderDetail(state.selectedSessionDetail);
    els.notesDirDialog.close();
  } catch (error) {
    els.notesDirStatus.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    els.notesDirSave.disabled = false;
  }
}

async function loadProjects() {
  const params = new URLSearchParams();
  if (state.query) params.set("q", state.query);
  const queryString = params.toString();
  const data = await fetchJson(queryString ? `/api/projects?${queryString}` : "/api/projects");
  state.projects = data.projects;
  renderProjects();
}

function getSelectedProjectLabel() {
  if (!state.selectedProject) return "";
  return state.projects.find((project) => project.projectId === state.selectedProject)?.projectLabel || "selected project";
}

function renderSessionCount() {
  const selectedProjectLabel = getSelectedProjectLabel();
  if (state.query && selectedProjectLabel) {
    els.sessionCount.textContent = `${state.sessions.length} matches in ${selectedProjectLabel}`;
    return;
  }
  if (state.query) {
    els.sessionCount.textContent = `${state.sessions.length} matches`;
    return;
  }
  els.sessionCount.textContent = `${state.sessions.length} shown`;
}

async function loadSessions() {
  const params = new URLSearchParams();
  if (state.selectedProject) params.set("project", state.selectedProject);
  if (state.query) params.set("q", state.query);
  if (state.sessionSort) params.set("sort", state.sessionSort);
  params.set("limit", "250");
  const data = await fetchJson(`/api/sessions?${params.toString()}`);
  state.sessions = data.sessions;

  renderSessionCount();
  renderSessions();

  const fromHash = getHashSession();
  if (fromHash && !state.selectedSessionFile) {
    await selectSession(decodeURIComponent(fromHash));
    return;
  }

  if (state.selectedSessionFile && state.sessions.some((session) => session.sessionFile === state.selectedSessionFile)) {
    await selectSession(state.selectedSessionFile);
    return;
  }

  if (state.sessions[0]) {
    await selectSession(state.sessions[0].sessionFile);
  } else {
    state.selectedSessionFile = null;
    state.selectedSessionDetail = null;
    state.focusedTreeNodeId = null;
    renderDetail(null);
  }
}

function renderProjects() {
  const queryActive = Boolean(state.query);
  const totalSessions = state.projects.reduce((acc, project) => acc + project.sessionCount, 0);
  const totalMatchingSessions = queryActive
    ? state.projects.reduce((acc, project) => acc + (project.matchingSessionCount ?? 0), 0)
    : totalSessions;
  const matchingProjectCount = queryActive
    ? state.projects.filter((project) => (project.matchingSessionCount ?? 0) > 0).length
    : state.projects.length;
  const latestMatchingUpdatedAt = state.projects.find((project) => (project.matchingSessionCount ?? 0) > 0)?.latestMatchingUpdatedAt;

  const items = [
    {
      projectId: null,
      projectLabel: queryActive ? "All matches" : "All sessions",
      sessionCount: totalSessions,
      matchingSessionCount: totalMatchingSessions,
      latestUpdatedAt: state.projects[0]?.latestUpdatedAt,
      latestMatchingUpdatedAt,
      matchingProjectCount,
      isRoot: true,
    },
    ...state.projects,
  ];

  els.projects.innerHTML = items
    .map((project) => {
      const active = project.projectId === state.selectedProject;
      const matchingCount = queryActive ? (project.matchingSessionCount ?? 0) : project.sessionCount;
      const unmatched = queryActive && !project.isRoot && matchingCount === 0;
      const countLabel = queryActive ? `${matchingCount}/${project.sessionCount}` : `${project.sessionCount}`;
      let meta = "";
      if (queryActive) {
        if (project.isRoot) {
          meta = `${project.matchingProjectCount} matching projects`;
        } else if (matchingCount === 0) {
          meta = "No matching sessions";
        } else {
          const parts = [`${matchingCount} matching`];
          const timestamp = project.latestMatchingUpdatedAt ?? project.latestUpdatedAt;
          if (timestamp) parts.push(formatDate(timestamp));
          meta = parts.join(" · ");
        }
      } else {
        meta = project.latestUpdatedAt ? formatDate(project.latestUpdatedAt) : "";
      }

      return `
        <button class="list-item project-item ${active ? "active" : ""} ${unmatched ? "unmatched" : ""}" data-project="${project.projectId ?? ""}">
          <div class="project-row">
            <strong>${escapeHtml(project.projectLabel)}</strong>
            <span class="project-count">${escapeHtml(countLabel)}</span>
          </div>
          <div class="small muted">${escapeHtml(meta)}</div>
        </button>
      `;
    })
    .join("");

  els.projects.querySelectorAll("[data-project]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.selectedProject = button.dataset.project || null;
      renderProjects();
      await loadSessions();
    });
  });
}

function getSelectedSessionFiles() {
  return Array.from(state.selectedSessionFiles);
}

function getSelectedVisibleSessionFiles() {
  return state.sessions
    .filter((session) => state.selectedSessionFiles.has(session.sessionFile))
    .map((session) => session.sessionFile);
}

function toggleSessionSelection(sessionFile, checked) {
  if (!sessionFile) return;
  if (checked) {
    state.selectedSessionFiles.add(sessionFile);
  } else {
    state.selectedSessionFiles.delete(sessionFile);
  }
  renderSessions();
}

function renderSessionSelectionBar() {
  const selectedCount = state.selectedSessionFiles.size;
  const visibleSelectedCount = getSelectedVisibleSessionFiles().length;
  const hiddenSelectedCount = Math.max(0, selectedCount - visibleSelectedCount);
  const allShownSelected = state.sessions.length > 0 && visibleSelectedCount === state.sessions.length;

  let summary = "Select sessions to save a deterministic bundle note";
  if (selectedCount > 0) {
    summary = `<strong>${selectedCount}</strong> selected for bundle`;
    if (hiddenSelectedCount > 0) {
      summary += ` <span class="selection-detail">(${visibleSelectedCount} shown here, ${hiddenSelectedCount} in other projects/views)</span>`;
    } else if (visibleSelectedCount > 0 && selectedCount > 1) {
      summary += ` <span class="selection-detail">(${visibleSelectedCount} shown here)</span>`;
    }
  }

  els.sessionSelectionBar.innerHTML = `
    <div class="selection-toolbar-main">
      <div class="selection-summary ${selectedCount > 0 ? "has-selection" : ""}">
        ${summary}
      </div>
      <div class="selection-actions">
        <button class="mini-button" data-selection-action="select-all" ${state.sessions.length === 0 || allShownSelected ? "disabled" : ""}>Select all shown</button>
        <button class="mini-button" data-selection-action="clear-shown" ${visibleSelectedCount === 0 ? "disabled" : ""}>Clear shown</button>
        <button class="mini-button" data-selection-action="clear-all" ${selectedCount === 0 ? "disabled" : ""}>Clear all</button>
        <button class="mini-button" data-selection-action="save-bundle" ${selectedCount === 0 ? "disabled" : ""}>Save bundle</button>
      </div>
    </div>
  `;

  els.sessionSelectionBar.querySelector('[data-selection-action="select-all"]')?.addEventListener("click", () => {
    state.sessions.forEach((session) => state.selectedSessionFiles.add(session.sessionFile));
    renderSessions();
  });

  els.sessionSelectionBar.querySelector('[data-selection-action="clear-shown"]')?.addEventListener("click", () => {
    state.sessions.forEach((session) => state.selectedSessionFiles.delete(session.sessionFile));
    renderSessions();
  });

  els.sessionSelectionBar.querySelector('[data-selection-action="clear-all"]')?.addEventListener("click", () => {
    state.selectedSessionFiles.clear();
    renderSessions();
  });

  els.sessionSelectionBar.querySelector('[data-selection-action="save-bundle"]')?.addEventListener("click", async (event) => {
    const selectedPaths = getSelectedSessionFiles();
    if (!selectedPaths.length) return;

    const button = event.currentTarget;
    await flashButton(button, "Saving…", async () => {
      const result = await fetchJson("/api/bundle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paths: selectedPaths }),
      });
      button.textContent = `Saved ${result.fileName}`;
    });
  });
}

function renderSessions() {
  renderSessionSelectionBar();

  els.sessions.innerHTML = state.sessions
    .map((session) => {
      const active = session.sessionFile === state.selectedSessionFile;
      const marked = state.selectedSessionFiles.has(session.sessionFile);
      const score = state.query && session.score ? `<span class="tag">score ${session.score}</span>` : "";
      const display = getSessionDisplay(session);
      const title = display.title;
      const derived = display.derived;
      const metaParts = [];
      if (display.metaContext) metaParts.push(display.metaContext);
      metaParts.push(formatDate(session.updatedAt));
      return `
        <article class="list-item session-item ${active ? "active" : ""} ${marked ? "marked" : ""}" data-session="${escapeHtml(session.sessionFile)}">
          <div class="session-item-header">
            <div class="session-card-title ${derived ? "derived" : ""}">${escapeHtml(title)}</div>
            <label class="session-select" title="Select session for bundle">
              <input type="checkbox" data-select-session="${escapeHtml(session.sessionFile)}" ${marked ? "checked" : ""} aria-label="Select ${escapeHtml(title)} for bundle">
            </label>
          </div>
          <div class="session-card-meta">${escapeHtml(metaParts.filter(Boolean).join(" · "))}</div>
          <div class="session-card-stats small muted">${session.userMessageCount} user · ${session.assistantMessageCount} assistant · ${session.branchPointCount} branches</div>
          ${display.secondaryText ? `<div class="session-card-body"><span class="session-card-body-label">Task</span>${escapeHtml(display.secondaryText)}</div>` : ""}
          ${session.matchSnippet ? `<div class="snippet muted">${highlightText(session.matchSnippet)}</div>` : ""}
          ${(session.labels?.length || score) ? `<div class="tag-row">${score}${session.labels.map((label) => `<span class="tag">${escapeHtml(label)}</span>`).join("")}</div>` : ""}
        </article>
      `;
    })
    .join("");

  els.sessions.querySelectorAll("[data-session]").forEach((element) => {
    element.addEventListener("click", async () => {
      await selectSession(element.dataset.session);
    });
  });

  els.sessions.querySelectorAll("[data-select-session]").forEach((input) => {
    input.addEventListener("click", (event) => {
      event.stopPropagation();
    });
    input.addEventListener("change", (event) => {
      const target = event.currentTarget;
      toggleSessionSelection(target.dataset.selectSession, target.checked);
    });
  });
}

async function selectSession(sessionFile) {
  if (!sessionFile) return;
  const changedSession = sessionFile !== state.selectedSessionFile;
  state.selectedSessionFile = sessionFile;
  if (changedSession) {
    state.focusedTreeNodeId = null;
  }
  setHashForSession(sessionFile);
  renderSessions();
  const params = new URLSearchParams({ path: sessionFile });
  if (state.query) params.set("q", state.query);
  const data = await fetchJson(`/api/session?${params.toString()}`);
  state.selectedSessionDetail = data.session;
  if (state.focusedTreeNodeId && !findTreeNode(data.session.tree, state.focusedTreeNodeId)) {
    state.focusedTreeNodeId = null;
  }
  renderDetail(data.session);
}

async function copyText(text, button, feedbackLabel) {
  await flashButton(button, feedbackLabel, () => navigator.clipboard.writeText(text));
}

function renderDetail(session) {
  state.selectedSessionDetail = session;

  if (!session) {
    els.detail.classList.add("hidden");
    els.detailEmpty.classList.remove("hidden");
    els.detail.innerHTML = "";
    return;
  }

  const focusPathIds = findTreePathIds(session.tree, state.focusedTreeNodeId);
  const filteredTree = filterTreeNodes(session.tree, state.treeMode, focusPathIds);
  const totalTreeNodes = countTreeNodes(session.tree);
  const visibleTreeNodes = countTreeNodes(filteredTree);
  const focusedNode = findTreeNode(session.tree, state.focusedTreeNodeId);
  const display = getSessionDisplay(session);
  const detailTitle = display.title;
  const detailSubtitleParts = [];
  if (display.metaContext && display.metaContext !== detailTitle) detailSubtitleParts.push(display.metaContext);
  if (session.updatedAt) detailSubtitleParts.push(formatDate(session.updatedAt));
  const detailLeadPreview = display.secondaryText || "";

  els.detailEmpty.classList.add("hidden");
  els.detail.classList.remove("hidden");

  els.detail.innerHTML = `
    <section class="detail-hero">
      <div class="detail-heading">
        <div class="eyebrow">Session</div>
        <h2>${escapeHtml(detailTitle)}</h2>
        ${detailSubtitleParts.length ? `<p class="detail-subtitle muted">${escapeHtml(detailSubtitleParts.join(" · "))}</p>` : ""}
        ${detailLeadPreview ? `<p class="detail-lead"><span class="detail-lead-label">Task</span>${escapeHtml(detailLeadPreview)}</p>` : ""}
      </div>

      <div class="actions">
        <button id="copy-link" class="action-button">Copy link</button>
        <button id="copy-resume" class="action-button">Copy resume command</button>
        <button id="open-transcript" class="action-button">Open full transcript</button>
        <button id="copy-note" class="action-button">Copy note</button>
        <button id="save-note" class="action-button button-primary">Save note</button>
      </div>
    </section>

    <div class="summary-bar">
      <span class="summary-pill">${session.userMessageCount} user</span>
      <span class="summary-pill">${session.assistantMessageCount} assistant</span>
      <span class="summary-pill">${session.totalEntries} total entries</span>
      <span class="summary-pill">${session.treeStats.branchPoints} branches</span>
      <span class="summary-pill">${session.treeStats.compactions} compactions</span>
      ${session.labels.length ? `<span class="summary-pill">${session.labels.length} labels</span>` : ""}
    </div>

    <div class="detail-grid">
      <div class="metric">
        <div class="metric-label">Session file</div>
        <div class="code-block">${escapeHtml(session.sessionFile)}</div>
      </div>
      <div class="metric">
        <div class="metric-label">Project cwd</div>
        <div class="code-block">${escapeHtml(session.cwd)}</div>
      </div>
      <div class="metric">
        <div class="metric-label">First prompt</div>
        <div>${escapeHtml(session.firstUserPrompt || "")}</div>
      </div>
      <div class="metric">
        <div class="metric-label">Latest user prompt</div>
        <div>${escapeHtml(session.latestUserPrompt || "")}</div>
      </div>
      <div class="metric">
        <div class="metric-label">Message counts</div>
        <div>${session.userMessageCount} user · ${session.assistantMessageCount} assistant · ${session.totalEntries} total entries</div>
      </div>
      <div class="metric">
        <div class="metric-label">Structure stats</div>
        <div>${escapeHtml(formatTreeStats(session))}</div>
      </div>
      <div class="metric">
        <div class="metric-label">Note target</div>
        <div class="code-block">${escapeHtml(state.notesDir ? `${state.notesDir}/${session.noteFileName}` : session.noteFileName)}</div>
      </div>
      <div class="metric">
        <div class="metric-label">Resume command</div>
        <div class="code-block">${escapeHtml(session.resumeCommand)}</div>
      </div>
    </div>

    ${session.labels.length ? `
      <section class="detail-section">
        <h3>Labels</h3>
        <div class="tag-row">${session.labels.map((label) => `<span class="tag">${escapeHtml(label)}</span>`).join("")}</div>
      </section>
    ` : ""}

    ${session.recentLabels.length ? `
      <section class="detail-section">
        <h3>Recent labeled checkpoints</h3>
        <div class="preview-list">
          ${session.recentLabels.map((label) => `
            <section class="preview-entry compact checkpoint-entry">
              <div class="checkpoint-main">
                <div class="preview-entry-role">${escapeHtml(label.label)} ${label.timestamp ? `<time>${escapeHtml(formatDate(label.timestamp))}</time>` : ""}</div>
                <div>${escapeHtml(label.targetText || "")}</div>
              </div>
              ${label.targetId ? `<button class="mini-button" data-jump-node="${escapeHtml(label.targetId)}">Jump to branches</button>` : ""}
            </section>
          `).join("")}
        </div>
      </section>
    ` : ""}

    ${renderSearchMatches(session)}

    <section class="detail-section">
      <h3>Conversation</h3>
      <p class="muted small">Timeline shows a readable transcript excerpt. Branches shows structural flow with compactions, labels, and branch points.</p>
      <div class="tree-toolbar conversation-toolbar">
        <div class="segmented-control">
          <button class="segmented-button ${state.conversationMode === "timeline" ? "active" : ""}" data-conversation-mode="timeline">Timeline</button>
          <button class="segmented-button ${state.conversationMode === "branches" ? "active" : ""}" data-conversation-mode="branches">Branches</button>
        </div>
        <div class="small muted">${state.conversationMode === "timeline"
          ? `${session.previewEntries.length} excerpt entries shown`
          : `${visibleTreeNodes}/${totalTreeNodes} structure nodes shown`}</div>
      </div>
      ${state.conversationMode === "timeline" ? `
        <div class="conversation-panel timeline-panel">
          ${renderTimelineEntries(session)}
        </div>
      ` : `
        <div class="conversation-panel branches-panel">
          <div class="tree-toolbar tree-subtoolbar">
            <div class="segmented-control">
              <button class="segmented-button ${state.treeMode === "all" ? "active" : ""}" data-tree-mode="all">All</button>
              <button class="segmented-button ${state.treeMode === "active" ? "active" : ""}" data-tree-mode="active">Active path</button>
              <button class="segmented-button ${state.treeMode === "branches" ? "active" : ""}" data-tree-mode="branches">Branches + labels</button>
            </div>
            <div class="small muted">Rows stay vertically aligned; left rails show branch levels.</div>
          </div>
          ${focusedNode ? `
            <div class="focus-banner">
              <div class="small"><strong>Selected node:</strong> ${escapeHtml(focusedNode.label)} — ${escapeHtml(focusedNode.text)}</div>
              <button id="clear-tree-focus" class="mini-button">Clear selection</button>
            </div>
          ` : ""}
          ${renderTreeNodes(filteredTree)}
        </div>
      `}
    </section>

    ${session.pathMentions.length ? `
      <section class="detail-section">
        <h3>Key path mentions</h3>
        <div class="path-list">
          ${session.pathMentions.map((mention) => `
            <div class="path-row">
              <code>${escapeHtml(mention.path)}</code>
              <span class="tag">${mention.count}</span>
            </div>
          `).join("")}
        </div>
      </section>
    ` : ""}

  `;

  const copyLinkButton = els.detail.querySelector("#copy-link");
  const copyResumeButton = els.detail.querySelector("#copy-resume");
  const openTranscriptButton = els.detail.querySelector("#open-transcript");
  const copyNoteButton = els.detail.querySelector("#copy-note");
  const saveNoteButton = els.detail.querySelector("#save-note");
  const clearFocusButton = els.detail.querySelector("#clear-tree-focus");

  copyLinkButton.addEventListener("click", () => {
    copyText(`${window.location.origin}${session.deepLinkPath}`, copyLinkButton, "Link copied");
  });

  copyResumeButton.addEventListener("click", () => {
    copyText(session.resumeCommand, copyResumeButton, "Command copied");
  });

  openTranscriptButton.addEventListener("click", () => {
    window.open(buildTranscriptUrl(session.sessionFile), "_blank", "noopener");
  });

  els.detail.querySelectorAll("[data-open-transcript-entry]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const entryNumber = Number.parseInt(button.dataset.openTranscriptEntry || "", 10);
      window.open(buildTranscriptUrl(session.sessionFile, Number.isFinite(entryNumber) ? entryNumber : undefined), "_blank", "noopener");
    });
  });

  copyNoteButton.addEventListener("click", () => {
    copyText(session.noteMarkdown, copyNoteButton, "Note copied");
  });

  saveNoteButton.addEventListener("click", async () => {
    await flashButton(saveNoteButton, "Saving…", async () => {
      const result = await fetchJson("/api/note", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: session.sessionFile }),
      });
      saveNoteButton.textContent = `Saved ${result.fileName}`;
    });
  });

  clearFocusButton?.addEventListener("click", () => {
    state.focusedTreeNodeId = null;
    renderDetail(session);
  });

  els.detail.querySelectorAll("[data-conversation-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.conversationMode = button.dataset.conversationMode || "timeline";
      renderDetail(session);
      if (state.conversationMode === "branches" && state.focusedTreeNodeId) {
        requestAnimationFrame(() => scrollTreeNodeIntoView(state.focusedTreeNodeId));
      }
    });
  });

  els.detail.querySelectorAll("[data-tree-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.treeMode = button.dataset.treeMode || "all";
      renderDetail(session);
      if (state.focusedTreeNodeId) {
        requestAnimationFrame(() => scrollTreeNodeIntoView(state.focusedTreeNodeId));
      }
    });
  });

  els.detail.querySelectorAll("[data-jump-node]").forEach((button) => {
    button.addEventListener("click", () => {
      focusTreeNode(button.dataset.jumpNode, { conversationMode: "branches", treeMode: "branches" });
    });
  });

  els.detail.querySelectorAll("[data-tree-node]").forEach((element) => {
    element.addEventListener("click", () => {
      focusTreeNode(element.dataset.treeNode, { scroll: false });
    });
  });
}

let debounceHandle;
els.search.addEventListener("input", () => {
  clearTimeout(debounceHandle);
  debounceHandle = setTimeout(async () => {
    const previousQuery = state.query;
    const nextQuery = els.search.value.trim();
    state.query = nextQuery;
    if (!previousQuery && nextQuery) {
      state.selectedProject = null;
    }
    await Promise.all([loadProjects(), loadSessions()]);
  }, 150);
});

els.sessionSort.addEventListener("change", async () => {
  state.sessionSort = els.sessionSort.value || "smart";
  await loadSessions();
});

els.changeNotesDir.addEventListener("click", async () => {
  if (!state.configInfo) await loadConfig();
  openNotesDirDialog();
});

els.notesDirCancel.addEventListener("click", () => {
  els.notesDirDialog.close();
});

els.notesDirForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveNotesDirFromDialog();
});

els.refresh.addEventListener("click", async () => {
  await flashButton(els.refresh, "Refreshing…", async () => {
    await fetchJson("/api/refresh", { method: "POST" });
    await Promise.all([loadTheme(), loadStats(), loadConfig(), loadProjects(), loadSessions()]);
    if (state.selectedSessionFile) {
      await selectSession(state.selectedSessionFile);
    }
  });
});

window.addEventListener("hashchange", async () => {
  const fromHash = getHashSession();
  if (!fromHash) return;
  const sessionFile = decodeURIComponent(fromHash);
  if (sessionFile !== state.selectedSessionFile) {
    await selectSession(sessionFile);
  }
});

await Promise.all([loadTheme(), loadStats(), loadConfig(), loadProjects()]);
await loadSessions();

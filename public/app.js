const state = {
  projects: [],
  sessions: [],
  selectedProject: null,
  selectedSessionFile: null,
  selectedSessionDetail: null,
  query: "",
  distillDir: "",
  treeMode: "all",
  focusedTreeNodeId: null,
};

const els = {
  search: document.querySelector("#search"),
  refresh: document.querySelector("#refresh"),
  stats: document.querySelector("#stats"),
  projects: document.querySelector("#projects"),
  sessions: document.querySelector("#sessions"),
  sessionCount: document.querySelector("#session-count"),
  detail: document.querySelector("#detail"),
  detailEmpty: document.querySelector("#detail-empty"),
};

function escapeHtml(text = "") {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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
  renderDetail(state.selectedSessionDetail);
  if (options.scroll !== false) {
    requestAnimationFrame(() => scrollTreeNodeIntoView(nodeId));
  }
}

function renderTreeNodes(nodes) {
  if (!nodes?.length) {
    return '<p class="muted small">No visible tree nodes available for this filter.</p>';
  }

  return `
    <ul class="tree-list">
      ${nodes.map((node) => {
        const badges = [];
        if ((node.children?.length ?? 0) > 1) {
          badges.push(`<span class="tag">branch ×${node.children.length}</span>`);
        }
        for (const label of node.labels ?? []) {
          badges.push(`<span class="tag">${escapeHtml(label)}</span>`);
        }

        return `
          <li>
            <div class="tree-node ${node.active ? "active" : ""} ${state.focusedTreeNodeId === node.id ? "focused" : ""} ${(node.children?.length ?? 0) > 1 ? "branching" : ""}" data-tree-node="${escapeHtml(node.id)}">
              <div class="tree-node-header">
                <span class="tree-kind">${escapeHtml(node.label)}</span>
                ${node.timestamp ? `<time>${escapeHtml(formatDate(node.timestamp))}</time>` : ""}
              </div>
              <div class="tree-text">${escapeHtml(node.text)}</div>
              ${badges.length ? `<div class="tag-row">${badges.join("")}</div>` : ""}
            </div>
            ${node.children?.length ? renderTreeNodes(node.children) : ""}
          </li>
        `;
      }).join("")}
    </ul>
  `;
}

async function loadStats() {
  const data = await fetchJson("/api/health");
  state.distillDir = data.distillDir || "";
  els.stats.textContent = `${data.sessions} sessions · ${data.indexedDocs} indexed docs · ${data.projects} projects`;
}

async function loadProjects() {
  const data = await fetchJson("/api/projects");
  state.projects = data.projects;
  renderProjects();
}

async function loadSessions() {
  const params = new URLSearchParams();
  if (state.selectedProject) params.set("project", state.selectedProject);
  if (state.query) params.set("q", state.query);
  params.set("limit", "250");
  const data = await fetchJson(`/api/sessions?${params.toString()}`);
  state.sessions = data.sessions;
  els.sessionCount.textContent = `${state.sessions.length} shown`;
  renderSessions();

  const fromHash = getHashSession();
  if (fromHash && !state.selectedSessionFile) {
    await selectSession(decodeURIComponent(fromHash));
    return;
  }

  if (state.selectedSessionFile && state.sessions.some((session) => session.sessionFile === state.selectedSessionFile)) {
    renderSessions();
    if (state.selectedSessionDetail?.sessionFile === state.selectedSessionFile) {
      renderDetail(state.selectedSessionDetail);
    }
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
  const items = [
    {
      projectId: null,
      projectLabel: "All sessions",
      sessionCount: state.projects.reduce((acc, project) => acc + project.sessionCount, 0),
      latestUpdatedAt: state.projects[0]?.latestUpdatedAt,
    },
    ...state.projects,
  ];

  els.projects.innerHTML = items
    .map((project) => {
      const active = project.projectId === state.selectedProject;
      return `
        <button class="list-item ${active ? "active" : ""}" data-project="${project.projectId ?? ""}">
          <div class="project-row">
            <strong>${escapeHtml(project.projectLabel)}</strong>
            <span class="project-count">${project.sessionCount}</span>
          </div>
          <div class="small muted">${project.latestUpdatedAt ? formatDate(project.latestUpdatedAt) : ""}</div>
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

function renderSessions() {
  els.sessions.innerHTML = state.sessions
    .map((session) => {
      const active = session.sessionFile === state.selectedSessionFile;
      const score = state.query && session.score ? `<span class="tag">score ${session.score}</span>` : "";
      return `
        <article class="list-item ${active ? "active" : ""}" data-session="${session.sessionFile}">
          <div class="session-card-title">${escapeHtml(session.sessionName || session.firstUserPrompt || session.projectLabel)}</div>
          <div class="session-card-meta">${escapeHtml(session.projectLabel)} · ${formatDate(session.updatedAt)}</div>
          <div class="small muted">${session.userMessageCount} user · ${session.assistantMessageCount} assistant · ${session.branchPointCount} branches</div>
          ${session.firstUserPrompt ? `<div class="session-card-body">${escapeHtml(session.firstUserPrompt)}</div>` : ""}
          ${session.matchSnippet ? `<div class="snippet muted">${escapeHtml(session.matchSnippet)}</div>` : ""}
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
  const data = await fetchJson(`/api/session?path=${encodeURIComponent(sessionFile)}`);
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

  els.detailEmpty.classList.add("hidden");
  els.detail.classList.remove("hidden");

  els.detail.innerHTML = `
    <h2>${escapeHtml(session.sessionName || session.firstUserPrompt || session.projectLabel)}</h2>
    <p class="muted">${escapeHtml(session.projectLabel)} · ${formatDate(session.updatedAt)}</p>

    <div class="actions">
      <button id="copy-link">Copy link</button>
      <button id="copy-resume">Copy resume command</button>
      <button id="copy-handoff">Copy handoff markdown</button>
      <button id="save-distill">Save distill</button>
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
        <div class="metric-label">Tree stats</div>
        <div>${escapeHtml(formatTreeStats(session))}</div>
      </div>
      <div class="metric">
        <div class="metric-label">Distill target</div>
        <div class="code-block">${escapeHtml(state.distillDir ? `${state.distillDir}/${session.distillFileName}` : session.distillFileName)}</div>
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
              ${label.targetId ? `<button class="mini-button" data-jump-node="${escapeHtml(label.targetId)}">Jump to tree</button>` : ""}
            </section>
          `).join("")}
        </div>
      </section>
    ` : ""}

    <section class="detail-section">
      <h3>Session tree</h3>
      <p class="muted small">Visible user/assistant flow with summaries and labels. Click a node to focus it. Active path is highlighted.</p>
      <div class="tree-toolbar">
        <div class="segmented-control">
          <button class="segmented-button ${state.treeMode === "all" ? "active" : ""}" data-tree-mode="all">All</button>
          <button class="segmented-button ${state.treeMode === "active" ? "active" : ""}" data-tree-mode="active">Active path</button>
          <button class="segmented-button ${state.treeMode === "branches" ? "active" : ""}" data-tree-mode="branches">Branches + labels</button>
        </div>
        <div class="small muted">${visibleTreeNodes}/${totalTreeNodes} nodes shown</div>
      </div>
      ${focusedNode ? `
        <div class="focus-banner">
          <div class="small"><strong>Focused node:</strong> ${escapeHtml(focusedNode.label)} — ${escapeHtml(focusedNode.text)}</div>
          <button id="clear-tree-focus" class="mini-button">Clear focus</button>
        </div>
      ` : ""}
      ${renderTreeNodes(filteredTree)}
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

    <section class="detail-section">
      <h3>Preview</h3>
      ${session.omittedEntryCount > 0 ? `<p class="muted small">Omitted ${session.omittedEntryCount} middle entries from this preview.</p>` : ""}
      <div class="preview-list">
        ${session.previewEntries.map((entry) => `
          <section class="preview-entry">
            <div class="preview-entry-role">${escapeHtml(entry.role)} ${entry.timestamp ? `<time>${escapeHtml(formatDate(entry.timestamp))}</time>` : ""}</div>
            <div>${escapeHtml(entry.text)}</div>
          </section>
        `).join("")}
      </div>
    </section>
  `;

  const copyLinkButton = els.detail.querySelector("#copy-link");
  const copyResumeButton = els.detail.querySelector("#copy-resume");
  const copyHandoffButton = els.detail.querySelector("#copy-handoff");
  const saveDistillButton = els.detail.querySelector("#save-distill");
  const clearFocusButton = els.detail.querySelector("#clear-tree-focus");

  copyLinkButton.addEventListener("click", () => {
    copyText(`${window.location.origin}${session.deepLinkPath}`, copyLinkButton, "Link copied");
  });

  copyResumeButton.addEventListener("click", () => {
    copyText(session.resumeCommand, copyResumeButton, "Command copied");
  });

  copyHandoffButton.addEventListener("click", () => {
    copyText(session.handoffMarkdown, copyHandoffButton, "Handoff copied");
  });

  saveDistillButton.addEventListener("click", async () => {
    await flashButton(saveDistillButton, "Saving…", async () => {
      const result = await fetchJson("/api/distill", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: session.sessionFile }),
      });
      saveDistillButton.textContent = `Saved ${result.fileName}`;
    });
  });

  clearFocusButton?.addEventListener("click", () => {
    state.focusedTreeNodeId = null;
    renderDetail(session);
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
      focusTreeNode(button.dataset.jumpNode, { treeMode: "branches" });
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
    state.query = els.search.value.trim();
    await loadSessions();
  }, 150);
});

els.refresh.addEventListener("click", async () => {
  await flashButton(els.refresh, "Refreshing…", async () => {
    await fetchJson("/api/refresh", { method: "POST" });
    await Promise.all([loadStats(), loadProjects(), loadSessions()]);
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

await Promise.all([loadStats(), loadProjects()]);
await loadSessions();

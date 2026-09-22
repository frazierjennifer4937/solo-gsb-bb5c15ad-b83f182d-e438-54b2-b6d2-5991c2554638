/* 配置变更回放台 — 前端逻辑（原生 JS） */
"use strict";

const state = {
  filter: "",        // 当前资源筛选，"" 表示全部
  resources: [],     // /api/resources 统计
  events: [],        // 当前筛选下的事件（含 conflicts）
  replayIndex: 0,    // 回放进度：0 = 初始状态，i = 已应用前 i 个事件
  playing: false,
  playTimer: null,
};

const $ = (sel) => document.querySelector(sel);

/* ---------- 工具 ---------- */

async function api(path, options) {
  const resp = await fetch(path, options);
  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      const body = await resp.json();
      if (body.errors) detail = body.errors.join("；");
    } catch (_) { /* ignore */ }
    throw new Error(detail);
  }
  return resp.json();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function fmtTime(iso) {
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString();
}

function deepMerge(target, source) {
  const out = Array.isArray(target) ? target.slice() : Object.assign({}, target);
  for (const key of Object.keys(source || {})) {
    const sv = source[key];
    const tv = out[key];
    if (sv && typeof sv === "object" && !Array.isArray(sv) &&
        tv && typeof tv === "object" && !Array.isArray(tv)) {
      out[key] = deepMerge(tv, sv);
    } else {
      out[key] = sv;
    }
  }
  return out;
}

function conflictChipsHtml(conflicts) {
  return (conflicts || []).map((c) =>
    `<div class="conflict-chip"><span class="type">⚠ ${escapeHtml(c.label)}</span>${escapeHtml(c.detail)}</div>`
  ).join("");
}

/* ---------- 资源列表 / 筛选器 ---------- */

async function loadResources() {
  state.resources = await api("/api/resources");
  renderResourceList();
  renderFilterOptions();
}

function renderFilterOptions() {
  const sel = $("#resource-filter");
  const current = state.filter;
  sel.innerHTML = '<option value="">全部资源</option>' +
    state.resources.map((r) =>
      `<option value="${escapeHtml(r.resource)}">${escapeHtml(r.resource)}</option>`
    ).join("");
  sel.value = state.resources.some((r) => r.resource === current) ? current : "";
  state.filter = sel.value;

  $("#resource-datalist").innerHTML = state.resources.map((r) =>
    `<option value="${escapeHtml(r.resource)}">`).join("");
}

function renderResourceList() {
  const ul = $("#resource-list");
  $("#resource-empty").hidden = state.resources.length > 0;
  ul.innerHTML = state.resources.map((r) => {
    const active = r.resource === state.filter ? " active" : "";
    const conflict = r.conflict_count > 0
      ? `<span class="badge conflict">⚠ ${r.conflict_count} 冲突</span>` : "";
    return `<li class="${active}" data-resource="${escapeHtml(r.resource)}">
      <span class="name">${escapeHtml(r.resource)}</span>
      <span class="badges">
        <span class="badge">${r.event_count} 事件</span>
        <span class="badge">v${r.max_version}</span>
        ${conflict}
      </span>
    </li>`;
  }).join("");
  ul.querySelectorAll("li").forEach((li) => {
    li.addEventListener("click", () => {
      $("#resource-filter").value = li.dataset.resource;
      onFilterChange();
    });
  });
}

/* ---------- 事件表格 ---------- */

async function loadEvents() {
  const q = state.filter ? `?resource=${encodeURIComponent(state.filter)}` : "";
  state.events = await api(`/api/events${q}`);
  renderEventsTable();
}

function renderEventsTable() {
  const tbody = $("#events-tbody");
  $("#events-count").textContent = `（${state.events.length} 条）`;
  $("#events-empty").hidden = state.events.length > 0;
  tbody.innerHTML = state.events.map((e) => {
    const hasConflict = e.conflicts && e.conflicts.length > 0;
    const conflictCell = hasConflict
      ? e.conflicts.map((c) =>
          `<span class="tag" title="${escapeHtml(c.detail)}">⚠ ${escapeHtml(c.label)}</span>`
        ).join("")
      : '<span class="tag ok">正常</span>';
    return `<tr class="${hasConflict ? "row-conflict" : ""}">
      <td class="mono">#${e.id}</td>
      <td class="mono">${escapeHtml(e.resource)}</td>
      <td class="mono">v${e.version}</td>
      <td>${escapeHtml(e.author || "—")}</td>
      <td>${escapeHtml(e.message || "—")}</td>
      <td class="mono">${fmtTime(e.created_at)}</td>
      <td>${conflictCell}</td>
    </tr>`;
  }).join("");
}

/* ---------- 回放 ---------- */

function cumulativeStates(events) {
  const states = [{}];
  for (const e of events) states.push(deepMerge(states[states.length - 1], e.payload));
  return states;
}

function renderReplay() {
  const panel = $("#replay-panel");
  const empty = $("#replay-empty");
  const events = state.filter ? state.events : [];

  $("#replay-resource-name").textContent = state.filter ? `— ${state.filter}` : "";
  if (!state.filter || events.length === 0) {
    panel.hidden = true;
    empty.hidden = false;
    empty.textContent = state.filter
      ? "该资源暂无事件，先在左侧提交一个变更事件吧。"
      : "在上方「资源筛选」中选择一个资源，即可回放它的变更历史。";
    stopPlay();
    return;
  }
  empty.hidden = true;
  panel.hidden = false;

  const n = events.length;
  state.replayIndex = Math.min(state.replayIndex, n);
  const slider = $("#rp-slider");
  slider.max = n;
  slider.value = state.replayIndex;
  $("#rp-position").textContent = `${state.replayIndex} / ${n}`;

  // 时间线
  const tl = $("#timeline");
  tl.innerHTML = events.map((e, i) => {
    const idx = i + 1;
    const cls = [
      idx <= state.replayIndex ? "applied" : "",
      idx === state.replayIndex ? "current" : "",
      e.conflicts.length ? "has-conflict" : "",
    ].join(" ").trim();
    const conflictLine = e.conflicts.length
      ? `<div class="t-conflict">⚠ ${escapeHtml(e.conflicts.map((c) => c.label).join("；"))}</div>` : "";
    return `<li class="${cls}" data-index="${idx}">
      <div class="t-head">
        <span class="t-version">v${e.version}</span>
        <span class="t-author">${escapeHtml(e.author || "匿名")}</span>
      </div>
      <div class="t-msg">${escapeHtml(e.message || "（无说明）")}</div>
      <div class="t-time">#${e.id} · ${fmtTime(e.created_at)}</div>
      ${conflictLine}
    </li>`;
  }).join("");
  tl.querySelectorAll("li").forEach((li) => {
    li.addEventListener("click", () => setReplayIndex(Number(li.dataset.index)));
  });

  // 状态视图
  const states = cumulativeStates(events);
  $("#state-json").textContent = JSON.stringify(states[state.replayIndex], null, 2);
  if (state.replayIndex === 0) {
    $("#state-version").textContent = "（初始状态）";
    $("#step-diff").textContent = "—";
    $("#step-conflicts").innerHTML = "";
  } else {
    const e = events[state.replayIndex - 1];
    $("#state-version").textContent = `（已应用到 v${e.version} · 事件 #${e.id}）`;
    $("#step-diff").textContent = JSON.stringify(e.payload, null, 2);
    $("#step-conflicts").innerHTML = conflictChipsHtml(e.conflicts);
  }
}

function setReplayIndex(i) {
  const n = state.filter ? state.events.length : 0;
  state.replayIndex = Math.max(0, Math.min(i, n));
  renderReplay();
}

function stopPlay() {
  state.playing = false;
  if (state.playTimer) clearInterval(state.playTimer);
  state.playTimer = null;
  $("#rp-play").textContent = "▶";
}

function togglePlay() {
  if (state.playing) { stopPlay(); return; }
  const n = state.events.length;
  if (state.replayIndex >= n) state.replayIndex = 0;
  state.playing = true;
  $("#rp-play").textContent = "⏸";
  state.playTimer = setInterval(() => {
    if (state.replayIndex >= state.events.length) { stopPlay(); return; }
    setReplayIndex(state.replayIndex + 1);
  }, 1200);
}

/* ---------- 表单 ---------- */

function showFeedback(kind, html) {
  const box = $("#form-feedback");
  box.className = `feedback ${kind}`;
  box.innerHTML = html;
  box.hidden = false;
}

async function submitEvent(ev) {
  ev.preventDefault();
  const form = ev.target;
  const payloadText = form.payload.value.trim();
  let payload = {};
  if (payloadText) {
    try {
      payload = JSON.parse(payloadText);
    } catch (err) {
      showFeedback("error", `配置变更不是合法 JSON：${escapeHtml(err.message)}`);
      return;
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      showFeedback("error", "配置变更必须是 JSON 对象（{...}）。");
      return;
    }
  }
  const body = {
    resource: form.resource.value.trim(),
    version: Number(form.version.value),
    author: form.author.value.trim(),
    message: form.message.value.trim(),
    payload,
  };
  try {
    const created = await api("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (created.conflicts && created.conflicts.length) {
      showFeedback("warn",
        `事件 #${created.id} 已提交，但检测到冲突：<br>${conflictChipsHtml(created.conflicts)}`);
    } else {
      showFeedback("ok", `✓ 事件 #${created.id} 已提交（${escapeHtml(created.resource)} v${created.version}），无冲突。`);
    }
    form.message.value = "";
    await refresh();
    suggestNextVersion(created.resource);
  } catch (err) {
    showFeedback("error", `提交失败：${escapeHtml(err.message)}`);
  }
}

function suggestNextVersion(resource) {
  const r = state.resources.find((x) => x.resource === resource);
  if (r) {
    const form = $("#event-form");
    form.version.value = r.max_version + 1;
  }
}

/* ---------- 全局刷新与事件绑定 ---------- */

async function refresh() {
  await loadResources();
  await loadEvents();
  renderReplay();
}

function onFilterChange() {
  state.filter = $("#resource-filter").value;
  state.replayIndex = 0;
  stopPlay();
  refresh();
}

function bindEvents() {
  $("#resource-filter").addEventListener("change", onFilterChange);
  $("#event-form").addEventListener("submit", submitEvent);
  $("#event-form").resource.addEventListener("change", (e) => suggestNextVersion(e.target.value.trim()));

  $("#btn-export").addEventListener("click", () => {
    const q = state.filter ? `?resource=${encodeURIComponent(state.filter)}` : "";
    window.location.href = `/api/export${q}`;
  });
  $("#btn-seed").addEventListener("click", async () => {
    await api("/api/seed", { method: "POST" });
    state.replayIndex = 0;
    await refresh();
  });
  $("#btn-reset").addEventListener("click", async () => {
    if (!confirm("确定要清空全部事件数据吗？")) return;
    await api("/api/reset", { method: "POST" });
    state.replayIndex = 0;
    await refresh();
  });

  $("#rp-first").addEventListener("click", () => setReplayIndex(0));
  $("#rp-prev").addEventListener("click", () => setReplayIndex(state.replayIndex - 1));
  $("#rp-next").addEventListener("click", () => setReplayIndex(state.replayIndex + 1));
  $("#rp-last").addEventListener("click", () => setReplayIndex(state.events.length));
  $("#rp-play").addEventListener("click", togglePlay);
  $("#rp-slider").addEventListener("input", (e) => setReplayIndex(Number(e.target.value)));
}

bindEvents();
refresh().catch((err) => console.error("初始化加载失败:", err));

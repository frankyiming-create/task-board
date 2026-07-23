"use strict";

/* =========================================================================
 * 数据层
 * ========================================================================= */

const LOCAL_KEY = "kanban_state_v2";
const DEFAULT_STATE = () => ({
  people: ["我自己"],
  columns: [
    { id: "col-todo", name: "待办", color: "#9aa1ab" },
    { id: "col-doing", name: "进行中", color: "#378ADD" },
    { id: "col-feedback", name: "待反馈", color: "#BA7517" },
    { id: "col-closing", name: "项目收尾", color: "#639922" },
  ],
  folders: [],
  tags: [
    { id: "tag-comm", name: "沟通对接", color: "#378ADD" },
    { id: "tag-doc", name: "材料撰写", color: "#D85A30" },
    { id: "tag-data", name: "数据分析", color: "#1D9E75" },
    { id: "tag-out", name: "外出对接", color: "#BA7517" },
  ],
  tasks: [],
  user: { name: "我自己", dept: "" },
  settings: { notifyEnabled: false },
});

const Store = {
  serverMode: false,

  async init() {
    try {
      const res = await fetch("/api/state", { cache: "no-store" });
      if (res.ok) {
        this.serverMode = true;
        return await res.json();
      }
    } catch (e) {}
    this.serverMode = false;
    return this.loadLocal();
  },

  loadLocal() {
    try {
      const raw = localStorage.getItem(LOCAL_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return DEFAULT_STATE();
  },

  async save(state) {
    if (this.serverMode) {
      try {
        await fetch("/api/state", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(state),
        });
        return;
      } catch (e) {}
    }
    localStorage.setItem(LOCAL_KEY, JSON.stringify(state));
  },

  async refreshFromServer() {
    if (!this.serverMode) return null;
    try {
      const res = await fetch("/api/state", { cache: "no-store" });
      if (res.ok) return await res.json();
    } catch (e) {}
    return null;
  },
};

/* =========================================================================
 * 全局状态
 * ========================================================================= */

let state = DEFAULT_STATE();
let editingTaskId = null;
let currentView = "board";
let currentFolder = null; // null = 全部事项, "__archive__" = 已完成归档, 否则 folderId
let searchQuery = "";
let filterTagIds = new Set();
let filterPriority = new Set();
let filterStatus = new Set();
let filterDateFrom = "";
let filterDateTo = "";
let onlyOverdue = false;
let selectionMode = false;
let selectedIds = new Set();
let sidebarCollapsed = false;
let calendarMode = "month";
let calendarCursor = new Date();
let calendarSelectedDay = null;
let contextMenuTaskId = null;
let editingSubtasks = [];
let isAlwaysOnTop = false;

const DAY_WIDTH = 40;

/* =========================================================================
 * 工具函数
 * ========================================================================= */

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function pad(n) { return String(n).padStart(2, "0"); }
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function dateFromStr(str) {
  if (!str) return null;
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function fmt(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function formatShort(str) {
  if (!str) return "";
  const [, m, d] = str.split("-");
  return `${m}/${d}`;
}
function daysBetween(a, b) {
  const MS = 24 * 60 * 60 * 1000;
  return Math.round((b - a) / MS);
}
function addDays(str, n) {
  const d = dateFromStr(str);
  d.setDate(d.getDate() + n);
  return fmt(d);
}
function addMonths(str, n) {
  const d = dateFromStr(str);
  d.setMonth(d.getMonth() + n);
  return fmt(d);
}
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function colFor(status) {
  return state.columns.find((c) => c.id === status) || state.columns[0];
}
function isDoneStatus(status) {
  return state.columns.length > 0 && status === state.columns[state.columns.length - 1].id;
}
function tagFor(id) { return state.tags.find((t) => t.id === id); }
function folderFor(id) { return state.folders.find((f) => f.id === id); }
function sortTasks(tasks) {
  return [...tasks].sort((a, b) => {
    const ad = a.dueDate || "9999-99-99";
    const bd = b.dueDate || "9999-99-99";
    if (ad !== bd) return ad < bd ? -1 : 1;
    return (a.createdAt || "").localeCompare(b.createdAt || "");
  });
}
async function persist() { await Store.save(state); }

/* =========================================================================
 * 初始化 / 数据规整
 * ========================================================================= */

document.addEventListener("DOMContentLoaded", async () => {
  state = await Store.init();
  ensureShape();
  bindGlobalUI();
  renderAll();
  updateSyncHint();
  restoreNotifySetting();

  setInterval(checkReminders, 30 * 1000);
  checkReminders();

  if (Store.serverMode) {
    setInterval(async () => {
      const fresh = await Store.refreshFromServer();
      if (fresh && !isAnyModalOpen()) {
        state = fresh;
        ensureShape();
        renderAll();
      }
    }, 8000);
  }
});

function ensureShape() {
  if (!Array.isArray(state.people)) state.people = [];
  if (!Array.isArray(state.columns) || state.columns.length === 0) {
    state.columns = DEFAULT_STATE().columns;
  }
  // 兼容旧版本（列为纯字符串）
  state.columns = state.columns.map((c, i) =>
    typeof c === "string" ? { id: "col-" + i + "-" + c, name: c, color: "#9aa1ab" } : c
  );
  if (!Array.isArray(state.folders)) state.folders = [];
  if (!Array.isArray(state.tags)) state.tags = DEFAULT_STATE().tags;
  if (!Array.isArray(state.tasks)) state.tasks = [];
  if (!state.user) state.user = { name: "我自己", dept: "" };
  if (!state.settings) state.settings = { notifyEnabled: false };

  state.tasks.forEach((t) => {
    if (!Array.isArray(t.tagIds)) t.tagIds = [];
    if (!Array.isArray(t.subtasks)) t.subtasks = [];
    if (!Array.isArray(t.reminders)) t.reminders = [];
    if (!Array.isArray(t.notifiedOffsets)) t.notifiedOffsets = [];
    if (!Array.isArray(t.ganttLabels)) t.ganttLabels = [];
    if (t.folderId === undefined) t.folderId = null;
    if (t.archived === undefined) t.archived = false;
    if (t.recurrence === undefined) t.recurrence = "";
    if (t.dueTime === undefined) t.dueTime = "";
    if (!Array.isArray(t.assignees)) t.assignees = [];
  });
}

function isAnyModalOpen() {
  return (
    !document.getElementById("task-modal").classList.contains("hidden") ||
    !document.getElementById("settings-modal").classList.contains("hidden")
  );
}

function renderAll() {
  renderSidebar();
  renderOverdueBanner();
  renderBoard();
  renderGantt();
  renderCalendar();
  renderBatchBar();
}

/* =========================================================================
 * 筛选
 * ========================================================================= */

function getScopedTasks() {
  // 按文件夹 / 归档 划定基础范围
  if (currentFolder === "__archive__") {
    return state.tasks.filter((t) => t.archived);
  }
  let list = state.tasks.filter((t) => !t.archived);
  if (currentFolder) list = list.filter((t) => t.folderId === currentFolder);
  return list;
}

function getFilteredTasks() {
  let list = getScopedTasks();
  const q = searchQuery.trim().toLowerCase();
  if (q) {
    list = list.filter(
      (t) => (t.title || "").toLowerCase().includes(q) || (t.notes || "").toLowerCase().includes(q)
    );
  }
  if (filterTagIds.size > 0) {
    list = list.filter((t) => t.tagIds.some((id) => filterTagIds.has(id)));
  }
  if (filterPriority.size > 0) {
    list = list.filter((t) => filterPriority.has(t.priority || "low"));
  }
  if (filterStatus.size > 0) {
    list = list.filter((t) => filterStatus.has(t.status));
  }
  if (filterDateFrom) list = list.filter((t) => !t.dueDate || t.dueDate >= filterDateFrom);
  if (filterDateTo) list = list.filter((t) => !t.dueDate || t.dueDate <= filterDateTo);
  if (onlyOverdue) {
    const today = todayStr();
    list = list.filter((t) => t.dueDate && t.dueDate < today && !isDoneStatus(t.status));
  }
  return list;
}

function isFilterActive() {
  return (
    searchQuery.trim() !== "" ||
    filterTagIds.size > 0 ||
    filterPriority.size > 0 ||
    filterStatus.size > 0 ||
    !!filterDateFrom ||
    !!filterDateTo
  );
}

/* =========================================================================
 * 顶部栏 / 全局交互绑定
 * ========================================================================= */

function bindGlobalUI() {
  document.querySelectorAll(".switch-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".switch-btn").forEach((b) => {
        b.classList.remove("active");
        b.setAttribute("aria-selected", "false");
      });
      btn.classList.add("active");
      btn.setAttribute("aria-selected", "true");
      currentView = btn.dataset.view;
      document.getElementById("view-board").classList.toggle("active", currentView === "board");
      document.getElementById("view-gantt").classList.toggle("active", currentView === "gantt");
      document.getElementById("view-calendar").classList.toggle("active", currentView === "calendar");
      if (currentView === "gantt") renderGantt();
      if (currentView === "calendar") renderCalendar();
    });
  });

  document.getElementById("btn-new-task").addEventListener("click", () => openTaskModal(null));
  document.getElementById("btn-settings").addEventListener("click", openSettingsModal);

  document.querySelectorAll("[data-close-modal]").forEach((el) => {
    el.addEventListener("click", closeAllModals);
  });
  document.querySelectorAll(".modal-backdrop").forEach((el) => {
    el.addEventListener("click", (e) => { if (e.target === el) closeAllModals(); });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeAllModals(); hideContextMenu(); }
  });
  document.addEventListener("click", (e) => {
    const menu = document.getElementById("context-menu");
    if (!menu.classList.contains("hidden") && !menu.contains(e.target)) hideContextMenu();
  });

  document.getElementById("btn-save-task").addEventListener("click", saveTaskFromForm);
  document.getElementById("btn-delete-task").addEventListener("click", () => {
    if (editingTaskId && confirm("确定删除这个任务吗？")) {
      deleteTask(editingTaskId);
      closeAllModals();
    }
  });
  document.getElementById("btn-add-subtask").addEventListener("click", () => {
    editingSubtasks.push({ id: uid(), title: "", done: false, startDate: "", dueDate: "" });
    renderSubtasksEditor();
  });

  // 侧边栏
  document.getElementById("btn-collapse-sidebar").addEventListener("click", () => setSidebarCollapsed(true));
  document.getElementById("btn-expand-sidebar").addEventListener("click", () => setSidebarCollapsed(false));
  document.getElementById("btn-add-folder").addEventListener("click", () => {
    const name = prompt("文件夹名称：");
    if (name && name.trim()) {
      state.folders.push({ id: uid(), name: name.trim() });
      persist();
      renderSidebar();
    }
  });
  document.getElementById("btn-archive-folder").addEventListener("click", () => {
    currentFolder = "__archive__";
    renderSidebar();
    renderAll();
  });

  // 搜索 / 筛选
  document.getElementById("search-input").addEventListener("input", (e) => {
    searchQuery = e.target.value;
    renderAll();
  });
  document.getElementById("btn-filter").addEventListener("click", () => {
    document.getElementById("filter-panel").classList.toggle("hidden");
  });
  document.getElementById("filter-date-from").addEventListener("change", (e) => {
    filterDateFrom = e.target.value; renderAll();
  });
  document.getElementById("filter-date-to").addEventListener("change", (e) => {
    filterDateTo = e.target.value; renderAll();
  });
  document.getElementById("btn-clear-filter").addEventListener("click", () => {
    filterTagIds.clear(); filterPriority.clear(); filterStatus.clear();
    filterDateFrom = ""; filterDateTo = "";
    document.getElementById("filter-date-from").value = "";
    document.getElementById("filter-date-to").value = "";
    renderFilterPanel();
    renderAll();
  });

  // 批量模式
  document.getElementById("btn-batch-mode").addEventListener("click", () => {
    selectionMode = !selectionMode;
    if (!selectionMode) selectedIds.clear();
    document.getElementById("btn-batch-mode").classList.toggle("active", selectionMode);
    renderBoard();
    renderBatchBar();
  });
  document.getElementById("batch-cancel").addEventListener("click", () => {
    selectionMode = false; selectedIds.clear();
    document.getElementById("btn-batch-mode").classList.remove("active");
    renderBoard(); renderBatchBar();
  });
  document.getElementById("batch-due-date").addEventListener("change", (e) => {
    if (!e.target.value) return;
    selectedIds.forEach((id) => {
      const t = state.tasks.find((x) => x.id === id);
      if (t) t.dueDate = e.target.value;
    });
    persist(); renderAll();
  });
  document.getElementById("batch-complete").addEventListener("click", () => {
    selectedIds.forEach((id) => setTaskStatus(id, state.columns[state.columns.length - 1].id));
    renderAll();
  });
  document.getElementById("batch-delete").addEventListener("click", () => {
    if (!confirm(`确定删除选中的 ${selectedIds.size} 项任务吗？`)) return;
    state.tasks = state.tasks.filter((t) => !selectedIds.has(t.id));
    selectedIds.clear();
    persist(); renderAll();
  });

  // 窗口置顶
  document.getElementById("btn-pin").addEventListener("click", togglePin);

  // 甘特图 / 日历导航
  document.getElementById("gantt-prev").addEventListener("click", () => {
    document.getElementById("gantt-wrap").scrollBy({ left: -7 * DAY_WIDTH, behavior: "smooth" });
  });
  document.getElementById("gantt-next").addEventListener("click", () => {
    document.getElementById("gantt-wrap").scrollBy({ left: 7 * DAY_WIDTH, behavior: "smooth" });
  });
  document.getElementById("cal-prev").addEventListener("click", () => shiftCalendar(-1));
  document.getElementById("cal-next").addEventListener("click", () => shiftCalendar(1));
  document.querySelectorAll(".cal-mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      calendarMode = btn.dataset.mode;
      document.querySelectorAll(".cal-mode-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      renderCalendar();
    });
  });

  // 设置弹窗内交互
  document.getElementById("add-person").addEventListener("click", () => {
    const input = document.getElementById("new-person");
    const name = input.value.trim();
    if (!name) return;
    if (!state.people.includes(name)) { state.people.push(name); persist(); renderPeopleSettingsList(); }
    input.value = "";
  });
  document.getElementById("add-column").addEventListener("click", () => {
    const input = document.getElementById("new-column");
    const colorInput = document.getElementById("new-column-color");
    const name = input.value.trim();
    if (!name) return;
    if (state.columns.length >= 6) { alert("最多支持 6 个状态列"); return; }
    state.columns.push({ id: uid(), name, color: colorInput.value });
    persist(); renderColumnsSettingsList(); renderAll();
    input.value = "";
  });
  document.getElementById("add-tag").addEventListener("click", () => {
    const input = document.getElementById("new-tag");
    const colorInput = document.getElementById("new-tag-color");
    const name = input.value.trim();
    if (!name) return;
    state.tags.push({ id: uid(), name, color: colorInput.value });
    persist(); renderTagsSettingsList(); renderSidebar();
    input.value = "";
  });
  document.getElementById("settings-username").addEventListener("input", (e) => {
    state.user.name = e.target.value; persist(); renderSidebar();
  });
  document.getElementById("settings-userdept").addEventListener("input", (e) => {
    state.user.dept = e.target.value; persist(); renderSidebar();
  });
  document.getElementById("settings-notify-enabled").addEventListener("change", async (e) => {
    if (e.target.checked) {
      const granted = await requestNotifyPermission();
      if (!granted) { e.target.checked = false; alert("未获得系统通知权限，无法开启提醒"); return; }
    }
    state.settings.notifyEnabled = e.target.checked;
    persist();
  });
  document.getElementById("btn-export-xlsx").addEventListener("click", exportXlsx);
  document.getElementById("btn-import-xlsx").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) importXlsx(file);
    e.target.value = "";
  });
}

function closeAllModals() {
  document.getElementById("task-modal").classList.add("hidden");
  document.getElementById("settings-modal").classList.add("hidden");
  editingTaskId = null;
  editingSubtasks = [];
}

function setSidebarCollapsed(collapsed) {
  sidebarCollapsed = collapsed;
  document.getElementById("sidebar").classList.toggle("collapsed", collapsed);
  document.getElementById("btn-expand-sidebar").classList.toggle("hidden", !collapsed);
}

/* =========================================================================
 * 侧边栏
 * ========================================================================= */

function renderSidebar() {
  document.getElementById("user-name").textContent = state.user.name || "我自己";
  document.getElementById("user-dept").textContent = state.user.dept || "点击设置填写部门";
  document.getElementById("user-avatar").textContent = (state.user.name || "我").slice(0, 1);

  const folderList = document.getElementById("folder-list");
  folderList.innerHTML = "";
  const allItem = document.createElement("div");
  allItem.className = "sidebar-item" + (currentFolder === null ? " active" : "");
  allItem.innerHTML = `<span>全部事项</span><span class="count">${state.tasks.filter((t) => !t.archived).length}</span>`;
  allItem.addEventListener("click", () => { currentFolder = null; renderSidebar(); renderAll(); });
  folderList.appendChild(allItem);

  state.folders.forEach((f) => {
    const count = state.tasks.filter((t) => !t.archived && t.folderId === f.id).length;
    const el = document.createElement("div");
    el.className = "sidebar-item" + (currentFolder === f.id ? " active" : "");
    el.innerHTML = `<span>${escapeHtml(f.name)}</span><span class="count">${count}</span>`;
    el.addEventListener("click", () => { currentFolder = f.id; renderSidebar(); renderAll(); });
    folderList.appendChild(el);
  });

  const tagList = document.getElementById("tag-filter-list");
  tagList.innerHTML = "";
  state.tags.forEach((tag) => {
    const el = document.createElement("div");
    el.className = "sidebar-item" + (filterTagIds.has(tag.id) ? " active" : "");
    el.innerHTML = `<span class="dot" style="background:${tag.color}"></span><span>${escapeHtml(tag.name)}</span>`;
    el.addEventListener("click", () => {
      if (filterTagIds.has(tag.id)) filterTagIds.delete(tag.id); else filterTagIds.add(tag.id);
      renderSidebar(); renderAll();
    });
    tagList.appendChild(el);
  });

  document.getElementById("btn-archive-folder").classList.toggle("active", currentFolder === "__archive__");
}

/* =========================================================================
 * 逾期横幅
 * ========================================================================= */

function renderOverdueBanner() {
  const banner = document.getElementById("overdue-banner");
  const today = todayStr();
  const overdue = state.tasks.filter((t) => !t.archived && t.dueDate && t.dueDate < today && !isDoneStatus(t.status));
  if (overdue.length === 0) {
    banner.classList.add("hidden");
    onlyOverdue = false;
    return;
  }
  banner.classList.remove("hidden");
  banner.textContent = `${overdue.length} 项任务已逾期未完成${onlyOverdue ? "（点击取消筛选）" : "，点击查看"}`;
  banner.onclick = () => { onlyOverdue = !onlyOverdue; renderAll(); };
}

/* =========================================================================
 * 看板视图
 * ========================================================================= */

function renderBoard() {
  const container = document.getElementById("board-columns");
  container.innerHTML = "";
  const tasks = getFilteredTasks();

  const columns = currentFolder === "__archive__" ? [{ id: "__all__", name: "已完成归档", color: "#9aa1ab" }] : state.columns;

  columns.forEach((col) => {
    const colTasks = sortTasks(currentFolder === "__archive__" ? tasks : tasks.filter((t) => t.status === col.id));

    const colEl = document.createElement("div");
    colEl.className = "board-column";

    const header = document.createElement("div");
    header.className = "board-column-header";
    header.innerHTML = `<span class="board-column-dot" style="background:${col.color}"></span><span class="board-column-title">${escapeHtml(col.name)}</span><span class="board-column-count">${colTasks.length}</span>`;
    colEl.appendChild(header);

    const body = document.createElement("div");
    body.className = "board-column-body";
    body.dataset.column = col.id;

    if (currentFolder !== "__archive__") {
      body.addEventListener("dragover", (e) => { e.preventDefault(); body.classList.add("drag-over"); });
      body.addEventListener("dragleave", () => body.classList.remove("drag-over"));
      body.addEventListener("drop", (e) => {
        e.preventDefault();
        body.classList.remove("drag-over");
        const taskId = e.dataTransfer.getData("text/plain");
        setTaskStatus(taskId, col.id);
      });
    }

    if (colTasks.length === 0) {
      const hint = document.createElement("div");
      hint.className = "empty-column-hint";
      hint.textContent = "暂无任务";
      body.appendChild(hint);
    }
    colTasks.forEach((task) => body.appendChild(renderCard(task)));

    colEl.appendChild(body);
    container.appendChild(colEl);
  });
}

function renderCard(task) {
  const card = document.createElement("div");
  card.className = `task-card priority-${task.priority || "low"}` + (selectedIds.has(task.id) ? " selected" : "");
  card.draggable = !selectionMode && currentFolder !== "__archive__";
  card.dataset.id = task.id;

  card.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", task.id);
    card.classList.add("is-dragging");
  });
  card.addEventListener("dragend", () => card.classList.remove("is-dragging"));

  card.addEventListener("click", (e) => {
    if (e.target.closest(".task-card-expand")) return;
    if (selectionMode) {
      if (selectedIds.has(task.id)) selectedIds.delete(task.id); else selectedIds.add(task.id);
      renderBoard(); renderBatchBar();
      return;
    }
    openTaskModal(task.id);
  });
  card.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showContextMenu(task.id, e.clientX, e.clientY);
  });

  const top = document.createElement("div");
  top.className = "task-card-top";
  if (selectionMode) {
    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "task-card-check";
    check.checked = selectedIds.has(task.id);
    check.addEventListener("click", (e) => e.stopPropagation());
    check.addEventListener("change", () => {
      if (check.checked) selectedIds.add(task.id); else selectedIds.delete(task.id);
      renderBatchBar();
      card.classList.toggle("selected", check.checked);
    });
    top.appendChild(check);
  }
  const title = document.createElement("p");
  title.className = "task-card-title";
  title.textContent = task.title;
  top.appendChild(title);
  card.appendChild(top);

  if (task.tagIds.length) {
    const row = document.createElement("div");
    row.className = "task-tag-row";
    task.tagIds.forEach((tid) => {
      const tag = tagFor(tid);
      if (!tag) return;
      const chip = document.createElement("span");
      chip.className = "task-tag-chip";
      chip.style.background = tag.color + "22";
      chip.style.color = tag.color;
      chip.textContent = tag.name;
      row.appendChild(chip);
    });
    card.appendChild(row);
  }

  if (task.subtasks.length) {
    const done = task.subtasks.filter((s) => s.done).length;
    const pct = Math.round((done / task.subtasks.length) * 100);
    const progRow = document.createElement("div");
    progRow.className = "task-progress-row";
    progRow.innerHTML = `<button type="button" class="task-card-expand">${task._expanded ? "▾" : "▸"}</button><div class="task-progress-bar"><div class="task-progress-fill" style="width:${pct}%"></div></div><span class="task-progress-label">${done}/${task.subtasks.length}</span>`;
    progRow.querySelector(".task-card-expand").addEventListener("click", (e) => {
      e.stopPropagation();
      task._expanded = !task._expanded;
      renderBoard();
    });
    card.appendChild(progRow);

    if (task._expanded) {
      const list = document.createElement("div");
      list.className = "task-subtasks-list";
      task.subtasks.forEach((s) => {
        const row = document.createElement("div");
        row.className = "task-subtask-item" + (s.done ? " done" : "");
        row.innerHTML = `<i>${s.done ? "☑" : "☐"}</i><span>${escapeHtml(s.title || "未命名子任务")}</span>`;
        row.addEventListener("click", (e) => {
          e.stopPropagation();
          s.done = !s.done;
          persist();
          renderBoard();
          if (currentView === "gantt") renderGantt();
        });
        list.appendChild(row);
      });
      card.appendChild(list);
    }
  }

  const meta = document.createElement("div");
  meta.className = "task-card-meta";
  if (task.dueDate) {
    const pill = document.createElement("span");
    pill.className = "due-pill" + duePillClass(task);
    pill.textContent = "截止 " + formatShort(task.dueDate);
    meta.appendChild(pill);
  }
  if (task.assignees && task.assignees.length) {
    const chips = document.createElement("span");
    chips.className = "assignee-chips";
    task.assignees.forEach((name) => {
      const c = document.createElement("span");
      c.className = "assignee-chip";
      c.title = name;
      c.textContent = name.slice(0, 1);
      chips.appendChild(c);
    });
    meta.appendChild(chips);
  }
  card.appendChild(meta);
  return card;
}

function duePillClass(task) {
  if (isDoneStatus(task.status)) return " done";
  if (!task.dueDate) return "";
  const today = todayStr();
  if (task.dueDate < today) return " overdue";
  if (task.dueDate === today) return " today";
  return "";
}

function setTaskStatus(taskId, newStatus) {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return;
  const wasDone = isDoneStatus(task.status);
  task.status = newStatus;
  const nowDone = isDoneStatus(newStatus);
  task.completedAt = nowDone ? task.completedAt || new Date().toISOString() : null;
  if (nowDone && !wasDone && task.recurrence) spawnNextRecurrence(task);
  persist();
  renderAll();
}

function deleteTask(taskId) {
  state.tasks = state.tasks.filter((t) => t.id !== taskId);
  persist();
  renderAll();
}

/* =========================================================================
 * 右键菜单
 * ========================================================================= */

function showContextMenu(taskId, x, y) {
  contextMenuTaskId = taskId;
  const menu = document.getElementById("context-menu");
  menu.style.left = x + "px";
  menu.style.top = y + "px";
  menu.classList.remove("hidden");
}
function hideContextMenu() {
  document.getElementById("context-menu").classList.add("hidden");
  contextMenuTaskId = null;
}
document.getElementById("context-menu").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn || !contextMenuTaskId) return;
  const task = state.tasks.find((t) => t.id === contextMenuTaskId);
  const action = btn.dataset.action;
  if (task) {
    if (action === "edit") openTaskModal(task.id);
    else if (action === "duplicate") {
      const copy = JSON.parse(JSON.stringify(task));
      copy.id = uid();
      copy.title = task.title + "（副本）";
      copy.createdAt = new Date().toISOString();
      copy.completedAt = null;
      copy.notifiedOffsets = [];
      state.tasks.push(copy);
      persist(); renderAll();
    } else if (action === "postpone") {
      if (task.dueDate) task.dueDate = addDays(task.dueDate, 1);
      persist(); renderAll();
    } else if (action === "archive") {
      task.archived = true;
      persist(); renderAll();
    } else if (action === "delete") {
      if (confirm("确定删除这个任务吗？")) deleteTask(task.id);
    }
  }
  hideContextMenu();
});

/* =========================================================================
 * 批量操作条
 * ========================================================================= */

function renderBatchBar() {
  const bar = document.getElementById("batch-bar");
  bar.classList.toggle("hidden", !selectionMode);
  if (!selectionMode) return;
  document.getElementById("batch-count").textContent = `已选 ${selectedIds.size} 项`;
  const sel = document.getElementById("batch-status-select");
  sel.innerHTML = state.columns.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
  sel.onchange = () => {
    selectedIds.forEach((id) => setTaskStatus(id, sel.value));
  };
}

/* =========================================================================
 * 任务弹窗
 * ========================================================================= */

function openTaskModal(taskId) {
  editingTaskId = taskId;
  const task = taskId ? state.tasks.find((t) => t.id === taskId) : null;
  editingSubtasks = task ? JSON.parse(JSON.stringify(task.subtasks)) : [];

  document.getElementById("task-modal-title").textContent = task ? "编辑任务" : "新建任务";
  document.getElementById("btn-delete-task").classList.toggle("hidden", !task);

  document.getElementById("f-title").value = task ? task.title : "";
  document.getElementById("f-notes").value = task ? task.notes || "" : "";
  document.getElementById("f-start").value = task ? task.startDate || "" : todayStr();
  document.getElementById("f-due").value = task ? task.dueDate || "" : "";
  document.getElementById("f-due-time").value = task ? task.dueTime || "" : "";
  document.getElementById("f-recurrence").value = task ? task.recurrence || "" : "";
  ["10", "60", "1440"].forEach((v) => {
    document.getElementById("f-remind-" + v).checked = task ? task.reminders.includes(Number(v)) : false;
  });

  renderStatusChips(task ? task.status : state.columns[0].id);
  renderPriorityChips(task ? task.priority : "low");
  renderFolderSelect(task ? task.folderId : currentFolder && currentFolder !== "__archive__" ? currentFolder : null);
  renderTagsChips(task ? task.tagIds : []);
  renderPeopleCheckboxes(task ? task.assignees || [] : []);
  renderSubtasksEditor();

  document.getElementById("task-modal").classList.remove("hidden");
  document.getElementById("f-title").focus();
}

function renderStatusChips(selected) {
  const group = document.getElementById("f-status-group");
  group.innerHTML = "";
  state.columns.forEach((col) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip" + (col.id === selected ? " selected" : "");
    btn.textContent = col.name;
    btn.dataset.value = col.id;
    btn.addEventListener("click", () => {
      group.querySelectorAll(".chip").forEach((c) => c.classList.remove("selected"));
      btn.classList.add("selected");
    });
    group.appendChild(btn);
  });
}
function renderPriorityChips(selected) {
  const group = document.querySelector('.chip-group[data-role="priority"]');
  group.querySelectorAll(".chip").forEach((btn) => {
    btn.classList.toggle("selected", btn.dataset.value === (selected || "low"));
    btn.onclick = () => {
      group.querySelectorAll(".chip").forEach((c) => c.classList.remove("selected"));
      btn.classList.add("selected");
    };
  });
}
function renderFolderSelect(selectedId) {
  const sel = document.getElementById("f-folder");
  sel.innerHTML = '<option value="">（不归入文件夹）</option>' +
    state.folders.map((f) => `<option value="${f.id}">${escapeHtml(f.name)}</option>`).join("");
  sel.value = selectedId || "";
}
function renderTagsChips(selectedIds2) {
  const group = document.getElementById("f-tags-group");
  group.innerHTML = "";
  state.tags.forEach((tag) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip" + (selectedIds2.includes(tag.id) ? " selected" : "");
    btn.textContent = tag.name;
    btn.dataset.value = tag.id;
    if (btn.classList.contains("selected")) { btn.style.background = tag.color; btn.style.borderColor = tag.color; }
    btn.addEventListener("click", () => {
      btn.classList.toggle("selected");
      if (btn.classList.contains("selected")) { btn.style.background = tag.color; btn.style.borderColor = tag.color; }
      else { btn.style.background = ""; btn.style.borderColor = ""; }
    });
    group.appendChild(btn);
  });
}
function renderPeopleCheckboxes(selectedNames) {
  const group = document.getElementById("f-people-group");
  group.innerHTML = "";
  if (state.people.length === 0) {
    group.innerHTML = '<span class="hint muted">还没有协作人，可在右上角"设置"中添加</span>';
    return;
  }
  state.people.forEach((name) => {
    const id = "person-" + name.replace(/\s+/g, "_");
    const wrap = document.createElement("label");
    wrap.className = "checkbox-item";
    wrap.innerHTML = `<input type="checkbox" id="${id}" value="${escapeHtml(name)}" ${selectedNames.includes(name) ? "checked" : ""} /> <span>${escapeHtml(name)}</span>`;
    group.appendChild(wrap);
  });
}
function renderSubtasksEditor() {
  const wrap = document.getElementById("f-subtasks-list");
  wrap.innerHTML = "";
  editingSubtasks.forEach((s, idx) => {
    const row = document.createElement("div");
    row.className = "subtask-row";
    row.innerHTML = `
      <input type="checkbox" ${s.done ? "checked" : ""} data-role="done" />
      <input type="text" placeholder="子任务名称" maxlength="40" value="${escapeHtml(s.title)}" data-role="title" />
      <input type="date" value="${s.startDate || ""}" data-role="start" title="开始日期" />
      <input type="date" value="${s.dueDate || ""}" data-role="due" title="截止日期" />
      <button type="button" data-role="remove">✕</button>
    `;
    row.querySelector('[data-role="done"]').addEventListener("change", (e) => { s.done = e.target.checked; });
    row.querySelector('[data-role="title"]').addEventListener("input", (e) => { s.title = e.target.value; });
    row.querySelector('[data-role="start"]').addEventListener("change", (e) => { s.startDate = e.target.value; });
    row.querySelector('[data-role="due"]').addEventListener("change", (e) => { s.dueDate = e.target.value; });
    row.querySelector('[data-role="remove"]').addEventListener("click", () => {
      editingSubtasks.splice(idx, 1);
      renderSubtasksEditor();
    });
    wrap.appendChild(row);
  });
}

function saveTaskFromForm() {
  const title = document.getElementById("f-title").value.trim();
  if (!title) { alert("请填写任务标题"); return; }
  const startDate = document.getElementById("f-start").value || null;
  const dueDate = document.getElementById("f-due").value || null;
  if (startDate && dueDate && dueDate < startDate) { alert("截止日期不能早于开始日期"); return; }
  const dueTime = document.getElementById("f-due-time").value || "";
  const notes = document.getElementById("f-notes").value.trim();
  const folderId = document.getElementById("f-folder").value || null;
  const recurrence = document.getElementById("f-recurrence").value || "";

  const statusBtn = document.querySelector("#f-status-group .chip.selected");
  const status = statusBtn ? statusBtn.dataset.value : state.columns[0].id;
  const priorityBtn = document.querySelector('.chip-group[data-role="priority"] .chip.selected');
  const priority = priorityBtn ? priorityBtn.dataset.value : "low";
  const tagIds = Array.from(document.querySelectorAll("#f-tags-group .chip.selected")).map((el) => el.dataset.value);
  const assignees = Array.from(document.querySelectorAll('#f-people-group input[type="checkbox"]:checked')).map((el) => el.value);
  const reminders = ["10", "60", "1440"].filter((v) => document.getElementById("f-remind-" + v).checked).map(Number);
  const subtasks = editingSubtasks.filter((s) => s.title.trim() !== "");

  if (editingTaskId) {
    const task = state.tasks.find((t) => t.id === editingTaskId);
    const wasDone = isDoneStatus(task.status);
    Object.assign(task, { title, notes, startDate, dueDate, dueTime, status, priority, tagIds, assignees, folderId, recurrence, reminders, subtasks });
    const nowDone = isDoneStatus(status);
    task.completedAt = nowDone ? task.completedAt || new Date().toISOString() : null;
    if (nowDone && !wasDone && recurrence) spawnNextRecurrence(task);
  } else {
    const newTask = {
      id: uid(), title, notes, startDate, dueDate, dueTime, status, priority, tagIds, assignees, folderId, recurrence, reminders,
      subtasks, ganttLabels: [], archived: false, notifiedOffsets: [],
      createdAt: new Date().toISOString(),
      completedAt: isDoneStatus(status) ? new Date().toISOString() : null,
    };
    state.tasks.push(newTask);
    if (isDoneStatus(status) && recurrence) spawnNextRecurrence(newTask);
  }
  persist();
  renderAll();
  closeAllModals();
}

/* =========================================================================
 * 重复任务
 * ========================================================================= */

function spawnNextRecurrence(task) {
  const shift = (str) => {
    if (!str) return str;
    if (task.recurrence === "daily") return addDays(str, 1);
    if (task.recurrence === "weekly") return addDays(str, 7);
    if (task.recurrence === "monthly") return addMonths(str, 1);
    return str;
  };
  const next = JSON.parse(JSON.stringify(task));
  next.id = uid();
  next.status = state.columns[0].id;
  next.startDate = shift(task.startDate);
  next.dueDate = shift(task.dueDate);
  next.completedAt = null;
  next.notifiedOffsets = [];
  next.ganttLabels = [];
  next.createdAt = new Date().toISOString();
  next.subtasks = (task.subtasks || []).map((s) => ({
    ...s, id: uid(), done: false, startDate: shift(s.startDate), dueDate: shift(s.dueDate),
  }));
  state.tasks.push(next);
}

/* =========================================================================
 * 设置弹窗
 * ========================================================================= */

function openSettingsModal() {
  document.getElementById("settings-username").value = state.user.name || "";
  document.getElementById("settings-userdept").value = state.user.dept || "";
  document.getElementById("settings-notify-enabled").checked = !!state.settings.notifyEnabled;
  renderPeopleSettingsList();
  renderColumnsSettingsList();
  renderTagsSettingsList();
  renderFoldersManageList();
  document.getElementById("settings-modal").classList.remove("hidden");
}

function renderPeopleSettingsList() {
  const list = document.getElementById("people-list");
  list.innerHTML = "";
  state.people.forEach((name) => {
    const pill = document.createElement("span");
    pill.className = "tag-pill";
    pill.innerHTML = `<span>${escapeHtml(name)}</span>`;
    const del = document.createElement("button");
    del.textContent = "✕";
    del.addEventListener("click", () => {
      state.people = state.people.filter((p) => p !== name);
      state.tasks.forEach((t) => { t.assignees = (t.assignees || []).filter((a) => a !== name); });
      persist(); renderPeopleSettingsList(); renderAll();
    });
    pill.appendChild(del);
    list.appendChild(pill);
  });
}

function renderColumnsSettingsList() {
  const list = document.getElementById("columns-list");
  list.innerHTML = "";
  state.columns.forEach((col) => {
    const pill = document.createElement("span");
    pill.className = "tag-pill";
    pill.innerHTML = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${col.color};margin-right:4px;"></span><span>${escapeHtml(col.name)}</span>`;
    const del = document.createElement("button");
    del.textContent = "✕";
    del.addEventListener("click", () => {
      if (state.columns.length <= 1) { alert("至少保留一个状态列"); return; }
      const fallback = state.columns.find((c) => c.id !== col.id);
      state.tasks.forEach((t) => { if (t.status === col.id) t.status = fallback.id; });
      state.columns = state.columns.filter((c) => c.id !== col.id);
      persist(); renderColumnsSettingsList(); renderAll();
    });
    pill.appendChild(del);
    list.appendChild(pill);
  });
}

function renderTagsSettingsList() {
  const list = document.getElementById("tags-manage-list");
  list.innerHTML = "";
  state.tags.forEach((tag) => {
    const pill = document.createElement("span");
    pill.className = "tag-pill";
    pill.innerHTML = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${tag.color};margin-right:4px;"></span><span>${escapeHtml(tag.name)}</span>`;
    const del = document.createElement("button");
    del.textContent = "✕";
    del.addEventListener("click", () => {
      state.tags = state.tags.filter((t) => t.id !== tag.id);
      state.tasks.forEach((t) => { t.tagIds = t.tagIds.filter((id) => id !== tag.id); });
      filterTagIds.delete(tag.id);
      persist(); renderTagsSettingsList(); renderSidebar(); renderAll();
    });
    pill.appendChild(del);
    list.appendChild(pill);
  });
}

function renderFoldersManageList() {
  const list = document.getElementById("folders-manage-list");
  list.innerHTML = "";
  state.folders.forEach((f) => {
    const pill = document.createElement("span");
    pill.className = "tag-pill";
    pill.innerHTML = `<span>${escapeHtml(f.name)}</span>`;
    const del = document.createElement("button");
    del.textContent = "✕";
    del.addEventListener("click", () => {
      state.folders = state.folders.filter((x) => x.id !== f.id);
      state.tasks.forEach((t) => { if (t.folderId === f.id) t.folderId = null; });
      if (currentFolder === f.id) currentFolder = null;
      persist(); renderFoldersManageList(); renderSidebar(); renderAll();
    });
    pill.appendChild(del);
    list.appendChild(pill);
  });
}

async function updateSyncHint() {
  const hint = document.getElementById("lan-url-hint");
  if (!Store.serverMode) {
    hint.textContent = "当前为浏览器本地模式（数据仅保存在这台设备）。安装桌面版并启动后，会在这里显示手机可访问的局域网地址。";
    return;
  }
  try {
    const res = await fetch("/api/server-info", { cache: "no-store" });
    if (res.ok) { const info = await res.json(); hint.textContent = `手机浏览器访问： ${info.url}`; return; }
  } catch (e) {}
  hint.textContent = `手机浏览器访问： ${location.origin}`;
}

/* =========================================================================
 * 甘特图视图（含子任务分支线）
 * ========================================================================= */

function renderGantt() {
  const chart = document.getElementById("gantt-chart");
  const label = document.getElementById("gantt-range-label");
  chart.innerHTML = "";

  const tasks = sortTasks(getFilteredTasks().filter((t) => t.startDate || t.dueDate));

  if (tasks.length === 0) {
    label.textContent = "";
    chart.style.gridTemplateColumns = "1fr";
    chart.innerHTML = '<div class="gantt-empty">还没有带日期的任务。给任务设置开始/截止日期后，会在这里显示时间轴。</div>';
    return;
  }

  let minDate = null, maxDate = null;
  tasks.forEach((t) => {
    const s = dateFromStr(t.startDate || t.dueDate);
    const d = dateFromStr(t.dueDate || t.startDate);
    if (!minDate || s < minDate) minDate = s;
    if (!maxDate || d > maxDate) maxDate = d;
    (t.subtasks || []).forEach((st) => {
      if (st.startDate) { const sd = dateFromStr(st.startDate); if (sd < minDate) minDate = sd; }
      if (st.dueDate) { const dd = dateFromStr(st.dueDate); if (dd > maxDate) maxDate = dd; }
    });
  });
  minDate.setDate(minDate.getDate() - 3);
  maxDate.setDate(maxDate.getDate() + 3);
  const totalDays = Math.max(1, daysBetween(minDate, maxDate));
  label.textContent = `${fmt(minDate)} ~ ${fmt(maxDate)}（共 ${totalDays} 天）`;
  chart.style.gridTemplateColumns = `220px ${totalDays * DAY_WIDTH}px`;

  const spacer = document.createElement("div");
  spacer.className = "gantt-header-spacer";
  chart.appendChild(spacer);

  const headerTrack = document.createElement("div");
  headerTrack.className = "gantt-header-track";
  headerTrack.style.width = totalDays * DAY_WIDTH + "px";
  for (let i = 0; i <= totalDays; i += 1) {
    const d = new Date(minDate); d.setDate(d.getDate() + i);
    if (d.getDate() === 1 || i === 0 || d.getDay() === 1) {
      const tick = document.createElement("div");
      tick.className = "gantt-header-tick";
      tick.style.left = i * DAY_WIDTH + "px";
      tick.textContent = `${d.getMonth() + 1}/${d.getDate()}`;
      headerTrack.appendChild(tick);
    }
  }
  addTodayLine(headerTrack, minDate, totalDays);
  chart.appendChild(headerTrack);

  tasks.forEach((task) => {
    const rowLabel = document.createElement("div");
    rowLabel.className = "gantt-row-label";
    rowLabel.innerHTML = `<span class="task-title">${escapeHtml(task.title)}</span>`;
    rowLabel.addEventListener("click", () => openTaskModal(task.id));
    chart.appendChild(rowLabel);

    const rowTrack = document.createElement("div");
    rowTrack.className = "gantt-row-track";
    rowTrack.style.width = totalDays * DAY_WIDTH + "px";

    for (let i = 0; i <= totalDays; i += 7) {
      const line = document.createElement("div");
      line.className = "gantt-grid-line";
      line.style.left = i * DAY_WIDTH + "px";
      rowTrack.appendChild(line);
    }
    addTodayLine(rowTrack, minDate, totalDays);

    const s = dateFromStr(task.startDate || task.dueDate);
    const d = dateFromStr(task.dueDate || task.startDate);
    const left = daysBetween(minDate, s) * DAY_WIDTH;
    const width = Math.max(DAY_WIDTH * 0.6, (daysBetween(s, d) + 1) * DAY_WIDTH - 6);

    const done = isDoneStatus(task.status);
    const bar = document.createElement("div");
    bar.className = `gantt-bar priority-${task.priority || "low"}` + (done ? " done" : "");
    bar.style.left = left + "px";
    bar.style.width = width + "px";
    bar.style.top = "9px";
    bar.textContent = task.title;
    bar.title = `${task.title}\n${task.startDate || "?"} → ${task.dueDate || "?"}`;
    bar.addEventListener("click", (e) => { e.stopPropagation(); openTaskModal(task.id); });
    rowTrack.appendChild(bar);

    if (task.dueDate) {
      const milestone = document.createElement("div");
      milestone.className = "gantt-milestone";
      milestone.style.top = "12px";
      milestone.style.left = daysBetween(minDate, dateFromStr(task.dueDate)) * DAY_WIDTH + DAY_WIDTH / 2 + "px";
      milestone.style.background = done ? "#16a34a" : "#9aa1ab";
      milestone.title = (done ? "已完成节点 " : "计划完成节点 ") + task.dueDate;
      rowTrack.appendChild(milestone);
    }

    (task.ganttLabels || []).forEach((lbl) => {
      const bubble = document.createElement("div");
      bubble.className = "gantt-label-bubble";
      bubble.style.left = daysBetween(minDate, dateFromStr(lbl.date)) * DAY_WIDTH + "px";
      bubble.textContent = lbl.text;
      bubble.title = "点击删除节点标签";
      bubble.addEventListener("click", (e) => {
        e.stopPropagation();
        if (confirm(`删除节点标签"${lbl.text}"？`)) {
          task.ganttLabels = task.ganttLabels.filter((x) => x.id !== lbl.id);
          persist(); renderGantt();
        }
      });
      rowTrack.appendChild(bubble);
    });

    // 子任务分支线
    if (task.subtasks && task.subtasks.length) {
      rowTrack.style.height = "84px";
      const svgNS = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(svgNS, "svg");
      svg.setAttribute("class", "gantt-branch-svg");
      const mainY = 21;
      const subY = 55;
      task.subtasks.forEach((st) => {
        const stStart = dateFromStr(st.startDate || task.startDate || task.dueDate);
        const stDue = dateFromStr(st.dueDate || st.startDate || task.dueDate || task.startDate);
        const x0 = daysBetween(minDate, stStart) * DAY_WIDTH + 4;
        const x1 = daysBetween(minDate, stDue) * DAY_WIDTH + DAY_WIDTH - 4;
        const color = st.done ? "#1D9E75" : "#BA7517";
        const path = document.createElementNS(svgNS, "path");
        let d2;
        if (st.done) {
          d2 = `M${x0},${mainY} C${x0 + 14},${mainY} ${x0 + 14},${subY} ${x0 + 28},${subY} L${x1 - 28},${subY} C${x1 - 14},${subY} ${x1 - 14},${mainY} ${x1},${mainY}`;
          path.setAttribute("stroke-dasharray", "none");
        } else {
          d2 = `M${x0},${mainY} C${x0 + 14},${mainY} ${x0 + 14},${subY} ${x0 + 28},${subY} L${x1},${subY}`;
          path.setAttribute("stroke-dasharray", "2,6");
        }
        path.setAttribute("d", d2);
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", color);
        path.setAttribute("stroke-width", "4");
        path.setAttribute("stroke-linecap", "round");
        svg.appendChild(path);

        const text = document.createElementNS(svgNS, "text");
        text.setAttribute("x", (x0 + x1) / 2);
        text.setAttribute("y", subY + 15);
        text.setAttribute("font-size", "10");
        text.setAttribute("fill", "var(--text-dim)");
        text.setAttribute("text-anchor", "middle");
        text.textContent = st.title;
        svg.appendChild(text);
      });
      rowTrack.appendChild(svg);
    }

    rowTrack.addEventListener("click", (e) => {
      if (e.target.closest(".gantt-bar") || e.target.closest(".gantt-label-bubble")) return;
      const rect = rowTrack.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const dayIndex = Math.round(x / DAY_WIDTH);
      const clickedDate = new Date(minDate);
      clickedDate.setDate(clickedDate.getDate() + dayIndex);
      const text = prompt("为这个日期添加节点标签文字：");
      if (text && text.trim()) {
        task.ganttLabels.push({ id: uid(), date: fmt(clickedDate), text: text.trim() });
        persist(); renderGantt();
      }
    });

    chart.appendChild(rowTrack);
  });
}

function addTodayLine(container, minDate, totalDays) {
  const offset = daysBetween(minDate, dateFromStr(todayStr()));
  if (offset < 0 || offset > totalDays) return;
  const line = document.createElement("div");
  line.className = "gantt-today-line";
  line.style.left = offset * DAY_WIDTH + "px";
  container.appendChild(line);
}

/* =========================================================================
 * 日历视图
 * ========================================================================= */

function shiftCalendar(dir) {
  if (calendarMode === "year") calendarCursor.setFullYear(calendarCursor.getFullYear() + dir);
  else if (calendarMode === "month") calendarCursor.setMonth(calendarCursor.getMonth() + dir);
  else calendarCursor.setDate(calendarCursor.getDate() + dir * 7);
  renderCalendar();
}

function tasksOnDay(dateStr) {
  return getFilteredTasks().filter((t) => t.startDate && t.dueDate && t.startDate <= dateStr && t.dueDate >= dateStr || (!t.startDate && t.dueDate === dateStr));
}

function renderCalendar() {
  const label = document.getElementById("cal-label");
  const body = document.getElementById("calendar-body");
  body.innerHTML = "";

  if (calendarMode === "month") {
    label.textContent = `${calendarCursor.getFullYear()} 年 ${calendarCursor.getMonth() + 1} 月`;
    renderCalendarMonth(body, calendarCursor.getFullYear(), calendarCursor.getMonth());
  } else if (calendarMode === "year") {
    label.textContent = `${calendarCursor.getFullYear()} 年`;
    renderCalendarYear(body, calendarCursor.getFullYear());
  } else {
    renderCalendarWeek(body, calendarCursor);
    label.textContent = "";
  }
}

function renderCalendarMonth(body, year, month) {
  const grid = document.createElement("div");
  grid.className = "calendar-grid";
  ["一", "二", "三", "四", "五", "六", "日"].forEach((w) => {
    const el = document.createElement("div");
    el.className = "calendar-weekday";
    el.textContent = w;
    grid.appendChild(el);
  });
  const first = new Date(year, month, 1);
  const startOffset = (first.getDay() + 6) % 7; // 周一为第一列
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = todayStr();

  for (let i = 0; i < 42; i++) {
    const dayNum = i - startOffset + 1;
    const cell = document.createElement("div");
    let cellDateStr = null;
    if (dayNum < 1 || dayNum > daysInMonth) {
      cell.className = "calendar-cell out-month";
    } else {
      const d = new Date(year, month, dayNum);
      cellDateStr = fmt(d);
      cell.className = "calendar-cell" + (cellDateStr === today ? " today" : "") + (cellDateStr === calendarSelectedDay ? " selected" : "");
      const num = document.createElement("div");
      num.textContent = String(dayNum);
      cell.appendChild(num);
      const dayTasks = tasksOnDay(cellDateStr);
      if (dayTasks.length) {
        const dots = document.createElement("div");
        dots.className = "calendar-cell-dots";
        dayTasks.slice(0, 4).forEach((t) => {
          const dot = document.createElement("span");
          dot.className = "calendar-cell-dot";
          dot.style.background = colFor(t.status).color;
          dots.appendChild(dot);
        });
        cell.appendChild(dots);
      }
      cell.addEventListener("click", () => {
        calendarSelectedDay = cellDateStr;
        renderCalendar();
        renderCalendarDayDetail(cellDateStr);
      });
    }
    grid.appendChild(cell);
  }
  body.appendChild(grid);
  if (calendarSelectedDay) renderCalendarDayDetail(calendarSelectedDay);
  else document.getElementById("calendar-day-detail").classList.add("hidden");
}

function renderCalendarDayDetail(dateStr) {
  const box = document.getElementById("calendar-day-detail");
  const tasks = tasksOnDay(dateStr);
  box.classList.remove("hidden");
  box.innerHTML = `<p class="calendar-day-detail-title">${dateStr} 的任务（${tasks.length}）</p>`;
  if (tasks.length === 0) {
    box.innerHTML += '<p class="hint muted">这一天没有任务</p>';
    return;
  }
  tasks.forEach((t) => {
    const row = document.createElement("div");
    row.className = "sidebar-item";
    row.style.cursor = "pointer";
    row.innerHTML = `<span class="dot" style="background:${colFor(t.status).color}"></span><span>${escapeHtml(t.title)}</span>`;
    row.addEventListener("click", () => openTaskModal(t.id));
    box.appendChild(row);
  });
}

function renderCalendarYear(body, year) {
  const grid = document.createElement("div");
  grid.className = "calendar-year-grid";
  for (let m = 0; m < 12; m++) {
    const box = document.createElement("div");
    box.className = "calendar-year-month";
    box.addEventListener("click", () => {
      calendarCursor = new Date(year, m, 1);
      calendarMode = "month";
      document.querySelectorAll(".cal-mode-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === "month"));
      renderCalendar();
    });
    const title = document.createElement("div");
    title.className = "calendar-year-month-title";
    title.textContent = `${m + 1} 月`;
    box.appendChild(title);
    const mini = document.createElement("div");
    mini.className = "calendar-year-mini-grid";
    const first = new Date(year, m, 1);
    const startOffset = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(year, m + 1, 0).getDate();
    for (let i = 0; i < 35; i++) {
      const dayNum = i - startOffset + 1;
      const cell = document.createElement("div");
      if (dayNum >= 1 && dayNum <= daysInMonth) {
        const ds = fmt(new Date(year, m, dayNum));
        const has = tasksOnDay(ds).length > 0;
        cell.className = "calendar-year-mini-cell" + (has ? " has-task" : "");
        cell.textContent = String(dayNum);
      } else {
        cell.className = "calendar-year-mini-cell";
      }
      mini.appendChild(cell);
    }
    box.appendChild(mini);
    grid.appendChild(box);
  }
  body.appendChild(grid);
}

function renderCalendarWeek(body, cursor) {
  const dow = (cursor.getDay() + 6) % 7;
  const monday = new Date(cursor);
  monday.setDate(cursor.getDate() - dow);
  const headerRow = document.createElement("div");
  headerRow.className = "calendar-week-row";
  headerRow.appendChild(document.createElement("div"));
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    days.push(d);
    const h = document.createElement("div");
    h.className = "calendar-week-header";
    h.textContent = `${d.getMonth() + 1}/${d.getDate()}`;
    headerRow.appendChild(h);
  }
  body.appendChild(headerRow);

  const contentRow = document.createElement("div");
  contentRow.className = "calendar-week-row";
  const label = document.createElement("div");
  label.className = "calendar-week-header";
  label.textContent = "任务";
  contentRow.appendChild(label);
  days.forEach((d) => {
    const ds = fmt(d);
    const cell = document.createElement("div");
    cell.className = "calendar-week-cell";
    tasksOnDay(ds).forEach((t) => {
      const item = document.createElement("div");
      item.className = "sidebar-item";
      item.style.cursor = "pointer";
      item.innerHTML = `<span class="dot" style="background:${colFor(t.status).color}"></span><span>${escapeHtml(t.title)}</span>`;
      item.addEventListener("click", () => openTaskModal(t.id));
      cell.appendChild(item);
    });
    contentRow.appendChild(cell);
  });
  body.appendChild(contentRow);
  document.getElementById("cal-label").textContent = `${fmt(monday)} ~ ${fmt(days[6])}`;
}

/* =========================================================================
 * 桌面通知提醒
 * ========================================================================= */

function restoreNotifySetting() {
  document.getElementById("settings-notify-enabled").checked = !!state.settings.notifyEnabled;
}

async function requestNotifyPermission() {
  if (window.__TAURI__ && window.__TAURI__.notification) {
    const n = window.__TAURI__.notification;
    let granted = await n.isPermissionGranted();
    if (!granted) {
      const perm = await n.requestPermission();
      granted = perm === "granted";
    }
    return granted;
  }
  if (typeof Notification !== "undefined") {
    if (Notification.permission === "granted") return true;
    const perm = await Notification.requestPermission();
    return perm === "granted";
  }
  return false;
}

function sendNotification(title, body) {
  if (window.__TAURI__ && window.__TAURI__.notification) {
    window.__TAURI__.notification.sendNotification({ title, body });
    return;
  }
  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    new Notification(title, { body });
  }
}

function checkReminders() {
  if (!state.settings || !state.settings.notifyEnabled) return;
  const now = Date.now();
  let changed = false;
  state.tasks.forEach((task) => {
    if (task.archived || isDoneStatus(task.status)) return;
    if (!task.dueDate || !task.dueTime || !task.reminders || task.reminders.length === 0) return;
    const due = new Date(`${task.dueDate}T${task.dueTime}:00`);
    task.reminders.forEach((offset) => {
      if (task.notifiedOffsets.includes(offset)) return;
      const target = due.getTime() - offset * 60 * 1000;
      if (now >= target && now < target + 2 * 60 * 1000) {
        sendNotification("任务即将到期：" + task.title, `截止时间 ${task.dueDate} ${task.dueTime}`);
        task.notifiedOffsets.push(offset);
        changed = true;
      }
    });
  });
  if (changed) persist();
}

/* =========================================================================
 * 窗口置顶
 * ========================================================================= */

async function togglePin() {
  isAlwaysOnTop = !isAlwaysOnTop;
  const btn = document.getElementById("btn-pin");
  btn.classList.toggle("active", isAlwaysOnTop);
  try {
    if (window.__TAURI__ && window.__TAURI__.window) {
      const win = window.__TAURI__.window.getCurrentWindow();
      await win.setAlwaysOnTop(isAlwaysOnTop);
    }
  } catch (e) {}
}

/* =========================================================================
 * Excel 导入导出
 * ========================================================================= */

const XLSX_COLUMNS = ["标题", "状态", "优先级", "开始日期", "截止日期", "协作人", "标签", "文件夹", "进展说明"];

function exportXlsx() {
  const from = document.getElementById("export-date-from").value;
  const to = document.getElementById("export-date-to").value;
  let tasks = state.tasks.filter((t) => !t.archived);
  if (from) tasks = tasks.filter((t) => !t.dueDate || t.dueDate >= from);
  if (to) tasks = tasks.filter((t) => !t.dueDate || t.dueDate <= to);

  const rows = [XLSX_COLUMNS];
  tasks.forEach((t) => {
    rows.push([
      t.title,
      colFor(t.status) ? colFor(t.status).name : t.status,
      { low: "不急", medium: "一般", high: "紧急" }[t.priority] || "不急",
      t.startDate || "",
      t.dueDate || "",
      (t.assignees || []).join("、"),
      (t.tagIds || []).map((id) => (tagFor(id) ? tagFor(id).name : "")).filter(Boolean).join("、"),
      t.folderId ? (folderFor(t.folderId) ? folderFor(t.folderId).name : "") : "",
      t.notes || "",
    ]);
  });

  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "任务");
  XLSX.writeFile(wb, `任务看板导出_${todayStr()}.xlsx`);
}

function importXlsx(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = new Uint8Array(e.target.result);
      const wb = XLSX.read(data, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
      let imported = 0;
      rows.slice(1).forEach((row) => {
        if (!row || !row[0]) return;
        const [title, statusName, priorityName, startDate, dueDate, assigneesStr, tagsStr, folderName, notes] = row;
        const col = state.columns.find((c) => c.name === statusName) || state.columns[0];
        const priority = { 不急: "low", 一般: "medium", 紧急: "high" }[priorityName] || "low";
        const assignees = (assigneesStr ? String(assigneesStr).split(/[、,，]/) : []).map((s) => s.trim()).filter(Boolean);
        assignees.forEach((a) => { if (!state.people.includes(a)) state.people.push(a); });
        const tagNames = (tagsStr ? String(tagsStr).split(/[、,，]/) : []).map((s) => s.trim()).filter(Boolean);
        const tagIds = tagNames.map((name) => {
          let tag = state.tags.find((t) => t.name === name);
          if (!tag) { tag = { id: uid(), name, color: "#378ADD" }; state.tags.push(tag); }
          return tag.id;
        });
        let folderId = null;
        if (folderName) {
          let folder = state.folders.find((f) => f.name === folderName);
          if (!folder) { folder = { id: uid(), name: folderName }; state.folders.push(folder); }
          folderId = folder.id;
        }
        state.tasks.push({
          id: uid(), title: String(title), notes: notes ? String(notes) : "",
          startDate: startDate ? String(startDate) : null, dueDate: dueDate ? String(dueDate) : null, dueTime: "",
          status: col.id, priority, tagIds, assignees, folderId, recurrence: "", reminders: [],
          subtasks: [], ganttLabels: [], archived: false, notifiedOffsets: [],
          createdAt: new Date().toISOString(), completedAt: isDoneStatus(col.id) ? new Date().toISOString() : null,
        });
        imported++;
      });
      persist(); renderAll(); renderSidebar();
      alert(`成功导入 ${imported} 条任务`);
    } catch (err) {
      alert("导入失败，请确认文件是本工具导出的 Excel 格式：" + err.message);
    }
  };
  reader.readAsArrayBuffer(file);
}

/* =========================================================================
 * 筛选面板渲染
 * ========================================================================= */

function renderFilterPanel() {
  const pri = document.getElementById("filter-priority");
  pri.innerHTML = "";
  [["low", "不急"], ["medium", "一般"], ["high", "紧急"]].forEach(([val, name]) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip" + (filterPriority.has(val) ? " selected" : "");
    btn.textContent = name;
    btn.addEventListener("click", () => {
      if (filterPriority.has(val)) filterPriority.delete(val); else filterPriority.add(val);
      renderFilterPanel(); renderAll();
    });
    pri.appendChild(btn);
  });

  const stat = document.getElementById("filter-status");
  stat.innerHTML = "";
  state.columns.forEach((col) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip" + (filterStatus.has(col.id) ? " selected" : "");
    btn.textContent = col.name;
    btn.addEventListener("click", () => {
      if (filterStatus.has(col.id)) filterStatus.delete(col.id); else filterStatus.add(col.id);
      renderFilterPanel(); renderAll();
    });
    stat.appendChild(btn);
  });

  const tags = document.getElementById("filter-tags");
  tags.innerHTML = "";
  state.tags.forEach((tag) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip" + (filterTagIds.has(tag.id) ? " selected" : "");
    btn.textContent = tag.name;
    btn.addEventListener("click", () => {
      if (filterTagIds.has(tag.id)) filterTagIds.delete(tag.id); else filterTagIds.add(tag.id);
      renderFilterPanel(); renderSidebar(); renderAll();
    });
    tags.appendChild(btn);
  });
}

const _origRenderAll = renderAll;
renderAll = function () {
  _origRenderAll();
  renderFilterPanel();
};

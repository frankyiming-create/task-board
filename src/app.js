"use strict";

/* =========================================================================
 * 数据层：优先通过内置服务 /api/state 读写（桌面端与手机端共用同一份数据）；
 * 若服务不可达（例如直接用浏览器打开静态文件做预览），退回 localStorage，
 * 保证页面在任何环境下都能独立工作。
 * ========================================================================= */

const LOCAL_KEY = "kanban_state_v1";
const DEFAULT_STATE = () => ({
  people: ["我自己"],
  columns: ["待办", "进行中", "已完成"],
  tasks: [],
});

const Store = {
  serverMode: false,
  serverChecked: false,

  async init() {
    try {
      const res = await fetch("/api/state", { cache: "no-store" });
      if (res.ok) {
        this.serverMode = true;
        this.serverChecked = true;
        return await res.json();
      }
    } catch (e) {
      /* server not reachable */
    }
    this.serverMode = false;
    this.serverChecked = true;
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
      } catch (e) {
        // 网络中断时退回本地存储，避免丢数据
      }
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

/* =========================================================================
 * 工具函数
 * ========================================================================= */

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function dateFromStr(str) {
  // "YYYY-MM-DD" -> Date at local midnight
  if (!str) return null;
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function daysBetween(a, b) {
  const MS = 24 * 60 * 60 * 1000;
  return Math.round((b - a) / MS);
}

function formatShort(str) {
  if (!str) return "";
  const [y, m, d] = str.split("-");
  return `${m}/${d}`;
}

function isDoneStatus(status) {
  return state.columns.length > 0 && status === state.columns[state.columns.length - 1];
}

function sortTasks(tasks) {
  return [...tasks].sort((a, b) => {
    const ad = a.dueDate || "9999-99-99";
    const bd = b.dueDate || "9999-99-99";
    if (ad !== bd) return ad < bd ? -1 : 1;
    return (a.createdAt || "").localeCompare(b.createdAt || "");
  });
}

async function persist() {
  await Store.save(state);
}

/* =========================================================================
 * 初始化
 * ========================================================================= */

document.addEventListener("DOMContentLoaded", async () => {
  state = await Store.init();
  ensureShape();
  bindGlobalUI();
  renderAll();
  updateSyncHint();

  if (Store.serverMode) {
    setInterval(async () => {
      const fresh = await Store.refreshFromServer();
      if (fresh && !isModalOpen()) {
        state = fresh;
        ensureShape();
        renderAll();
      }
    }, 8000);
  }
});

function ensureShape() {
  if (!Array.isArray(state.people)) state.people = [];
  if (!Array.isArray(state.columns) || state.columns.length === 0) state.columns = ["待办", "进行中", "已完成"];
  if (!Array.isArray(state.tasks)) state.tasks = [];
}

function isModalOpen() {
  return !document.getElementById("task-modal").classList.contains("hidden") ||
    !document.getElementById("settings-modal").classList.contains("hidden");
}

function renderAll() {
  renderBoard();
  renderGantt();
}

/* =========================================================================
 * 顶部栏 / 视图切换
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

      const view = btn.dataset.view;
      document.getElementById("view-board").classList.toggle("active", view === "board");
      document.getElementById("view-gantt").classList.toggle("active", view === "gantt");
      if (view === "gantt") renderGantt();
    });
  });

  document.getElementById("btn-new-task").addEventListener("click", () => openTaskModal(null));
  document.getElementById("btn-settings").addEventListener("click", openSettingsModal);

  document.querySelectorAll("[data-close-modal]").forEach((el) => {
    el.addEventListener("click", closeAllModals);
  });
  document.querySelectorAll(".modal-backdrop").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target === el) closeAllModals();
    });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAllModals();
  });

  document.getElementById("btn-save-task").addEventListener("click", saveTaskFromForm);
  document.getElementById("btn-delete-task").addEventListener("click", () => {
    if (editingTaskId && confirm("确定删除这个任务吗？")) {
      state.tasks = state.tasks.filter((t) => t.id !== editingTaskId);
      persist();
      renderAll();
      closeAllModals();
    }
  });

  document.getElementById("add-person").addEventListener("click", () => {
    const input = document.getElementById("new-person");
    const name = input.value.trim();
    if (!name) return;
    if (!state.people.includes(name)) {
      state.people.push(name);
      persist();
      renderPeopleSettingsList();
    }
    input.value = "";
  });

  document.getElementById("add-column").addEventListener("click", () => {
    const input = document.getElementById("new-column");
    const name = input.value.trim();
    if (!name) return;
    if (!state.columns.includes(name)) {
      state.columns.push(name);
      persist();
      renderColumnsSettingsList();
      renderAll();
    }
    input.value = "";
  });

  document.getElementById("gantt-prev").addEventListener("click", () => {
    document.getElementById("gantt-wrap").scrollBy({ left: -7 * DAY_WIDTH, behavior: "smooth" });
  });
  document.getElementById("gantt-next").addEventListener("click", () => {
    document.getElementById("gantt-wrap").scrollBy({ left: 7 * DAY_WIDTH, behavior: "smooth" });
  });
}

function closeAllModals() {
  document.getElementById("task-modal").classList.add("hidden");
  document.getElementById("settings-modal").classList.add("hidden");
  editingTaskId = null;
}

/* =========================================================================
 * 看板视图
 * ========================================================================= */

function renderBoard() {
  const container = document.getElementById("board-columns");
  container.innerHTML = "";

  state.columns.forEach((col) => {
    const colTasks = sortTasks(state.tasks.filter((t) => t.status === col));

    const colEl = document.createElement("div");
    colEl.className = "board-column";

    const header = document.createElement("div");
    header.className = "board-column-header";
    header.innerHTML = `<span class="board-column-title">${escapeHtml(col)}</span><span class="board-column-count">${colTasks.length}</span>`;
    colEl.appendChild(header);

    const body = document.createElement("div");
    body.className = "board-column-body";
    body.dataset.column = col;

    body.addEventListener("dragover", (e) => {
      e.preventDefault();
      body.classList.add("drag-over");
    });
    body.addEventListener("dragleave", () => body.classList.remove("drag-over"));
    body.addEventListener("drop", (e) => {
      e.preventDefault();
      body.classList.remove("drag-over");
      const taskId = e.dataTransfer.getData("text/plain");
      const task = state.tasks.find((t) => t.id === taskId);
      if (task && task.status !== col) {
        task.status = col;
        if (isDoneStatus(col)) task.completedAt = new Date().toISOString();
        else task.completedAt = null;
        persist();
        renderAll();
      }
    });

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
  card.className = `task-card priority-${task.priority || "low"}`;
  card.draggable = true;
  card.dataset.id = task.id;

  card.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", task.id);
    card.classList.add("is-dragging");
  });
  card.addEventListener("dragend", () => card.classList.remove("is-dragging"));
  card.addEventListener("click", () => openTaskModal(task.id));

  const title = document.createElement("p");
  title.className = "task-card-title";
  title.textContent = task.title;
  card.appendChild(title);

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

/* =========================================================================
 * 任务弹窗（新建 / 编辑）
 * ========================================================================= */

function openTaskModal(taskId) {
  editingTaskId = taskId;
  const task = taskId ? state.tasks.find((t) => t.id === taskId) : null;

  document.getElementById("task-modal-title").textContent = task ? "编辑任务" : "新建任务";
  document.getElementById("btn-delete-task").classList.toggle("hidden", !task);

  document.getElementById("f-title").value = task ? task.title : "";
  document.getElementById("f-notes").value = task ? task.notes || "" : "";
  document.getElementById("f-start").value = task ? task.startDate || "" : todayStr();
  document.getElementById("f-due").value = task ? task.dueDate || "" : "";

  renderStatusChips(task ? task.status : state.columns[0]);
  renderPriorityChips(task ? task.priority : "low");
  renderPeopleCheckboxes(task ? task.assignees || [] : []);

  document.getElementById("task-modal").classList.remove("hidden");
  document.getElementById("f-title").focus();
}

function renderStatusChips(selected) {
  const group = document.getElementById("f-status-group");
  group.innerHTML = "";
  state.columns.forEach((col) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip" + (col === selected ? " selected" : "");
    btn.textContent = col;
    btn.dataset.value = col;
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

function saveTaskFromForm() {
  const title = document.getElementById("f-title").value.trim();
  if (!title) {
    alert("请填写任务标题");
    return;
  }
  const startDate = document.getElementById("f-start").value || null;
  const dueDate = document.getElementById("f-due").value || null;
  if (startDate && dueDate && dueDate < startDate) {
    alert("截止日期不能早于开始日期");
    return;
  }
  const notes = document.getElementById("f-notes").value.trim();

  const statusBtn = document.querySelector('#f-status-group .chip.selected');
  const status = statusBtn ? statusBtn.dataset.value : state.columns[0];

  const priorityBtn = document.querySelector('.chip-group[data-role="priority"] .chip.selected');
  const priority = priorityBtn ? priorityBtn.dataset.value : "low";

  const assignees = Array.from(document.querySelectorAll('#f-people-group input[type="checkbox"]:checked')).map((el) => el.value);

  if (editingTaskId) {
    const task = state.tasks.find((t) => t.id === editingTaskId);
    Object.assign(task, { title, notes, startDate, dueDate, status, priority, assignees });
    task.completedAt = isDoneStatus(status) ? task.completedAt || new Date().toISOString() : null;
  } else {
    state.tasks.push({
      id: uid(),
      title,
      notes,
      startDate,
      dueDate,
      status,
      priority,
      assignees,
      createdAt: new Date().toISOString(),
      completedAt: isDoneStatus(status) ? new Date().toISOString() : null,
    });
  }

  persist();
  renderAll();
  closeAllModals();
}

/* =========================================================================
 * 设置弹窗
 * ========================================================================= */

function openSettingsModal() {
  renderPeopleSettingsList();
  renderColumnsSettingsList();
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
      state.tasks.forEach((t) => {
        t.assignees = (t.assignees || []).filter((a) => a !== name);
      });
      persist();
      renderPeopleSettingsList();
      renderAll();
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
    pill.innerHTML = `<span>${escapeHtml(col)}</span>`;
    const del = document.createElement("button");
    del.textContent = "✕";
    del.addEventListener("click", () => {
      if (state.columns.length <= 1) {
        alert("至少保留一个状态列");
        return;
      }
      const fallback = state.columns.find((c) => c !== col);
      state.tasks.forEach((t) => {
        if (t.status === col) t.status = fallback;
      });
      state.columns = state.columns.filter((c) => c !== col);
      persist();
      renderColumnsSettingsList();
      renderAll();
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
    if (res.ok) {
      const info = await res.json();
      hint.textContent = `手机浏览器访问： ${info.url}`;
      return;
    }
  } catch (e) {}
  hint.textContent = `手机浏览器访问： ${location.origin}`;
}

/* =========================================================================
 * 甘特图视图
 * ========================================================================= */

const DAY_WIDTH = 36;

function renderGantt() {
  const chart = document.getElementById("gantt-chart");
  const label = document.getElementById("gantt-range-label");
  chart.innerHTML = "";

  const tasks = sortTasks(state.tasks.filter((t) => t.startDate || t.dueDate));

  if (tasks.length === 0) {
    label.textContent = "";
    chart.style.gridTemplateColumns = "1fr";
    chart.innerHTML = '<div class="gantt-empty">还没有带日期的任务。给任务设置开始/截止日期后，会在这里显示时间轴。</div>';
    return;
  }

  let minDate = null;
  let maxDate = null;
  tasks.forEach((t) => {
    const s = dateFromStr(t.startDate || t.dueDate);
    const d = dateFromStr(t.dueDate || t.startDate);
    if (!minDate || s < minDate) minDate = s;
    if (!maxDate || d > maxDate) maxDate = d;
  });
  // 前后各留 3 天余量
  minDate.setDate(minDate.getDate() - 3);
  maxDate.setDate(maxDate.getDate() + 3);
  const totalDays = Math.max(1, daysBetween(minDate, maxDate));

  label.textContent = `${fmt(minDate)} ~ ${fmt(maxDate)}（共 ${totalDays} 天）`;

  chart.style.gridTemplateColumns = `220px ${totalDays * DAY_WIDTH}px`;

  // 表头占位
  const spacer = document.createElement("div");
  spacer.className = "gantt-header-spacer";
  chart.appendChild(spacer);

  const headerTrack = document.createElement("div");
  headerTrack.className = "gantt-header-track";
  headerTrack.style.width = totalDays * DAY_WIDTH + "px";
  for (let i = 0; i <= totalDays; i += 1) {
    const d = new Date(minDate);
    d.setDate(d.getDate() + i);
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

    const bar = document.createElement("div");
    const done = isDoneStatus(task.status);
    bar.className = `gantt-bar priority-${task.priority || "low"}` + (done ? " done" : "");
    bar.style.left = left + "px";
    bar.style.width = width + "px";
    bar.textContent = task.title;
    bar.title = `${task.title}\n${task.startDate || "?"} → ${task.dueDate || "?"}`;
    bar.addEventListener("click", () => openTaskModal(task.id));
    rowTrack.appendChild(bar);

    if (task.dueDate) {
      const milestone = document.createElement("div");
      milestone.className = "gantt-milestone";
      milestone.style.left = daysBetween(minDate, dateFromStr(task.dueDate)) * DAY_WIDTH + DAY_WIDTH / 2 + "px";
      milestone.style.background = done ? "#16a34a" : "#9aa1ab";
      milestone.title = (done ? "已完成节点 " : "计划完成节点 ") + task.dueDate;
      rowTrack.appendChild(milestone);
    }

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

function fmt(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/* =========================================================================
 * 杂项
 * ========================================================================= */

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

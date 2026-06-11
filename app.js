const storageKey = "mobile-worklog-pwa-tasks";

const state = {
  tasks: loadTasks(),
  filter: "all",
  query: "",
  deferredPrompt: null
};

const elements = {
  taskForm: document.getElementById("taskForm"),
  taskId: document.getElementById("taskId"),
  titleInput: document.getElementById("titleInput"),
  detailInput: document.getElementById("detailInput"),
  priorityInput: document.getElementById("priorityInput"),
  statusInput: document.getElementById("statusInput"),
  remindAtInput: document.getElementById("remindAtInput"),
  saveButton: document.getElementById("saveButton"),
  resetButton: document.getElementById("resetButton"),
  installButton: document.getElementById("installButton"),
  seedButton: document.getElementById("seedButton"),
  exportButton: document.getElementById("exportButton"),
  backupButton: document.getElementById("backupButton"),
  replaceButton: document.getElementById("replaceButton"),
  importInput: document.getElementById("importInput"),
  searchInput: document.getElementById("searchInput"),
  filterButtons: Array.from(document.querySelectorAll(".filter-chip")),
  taskList: document.getElementById("taskList"),
  emptyState: document.getElementById("emptyState"),
  totalCount: document.getElementById("totalCount"),
  pendingCount: document.getElementById("pendingCount"),
  completedCount: document.getElementById("completedCount"),
  highCount: document.getElementById("highCount"),
  taskTemplate: document.getElementById("taskTemplate")
};

init();

function init() {
  elements.taskForm.addEventListener("submit", handleSubmit);
  elements.taskForm.addEventListener("reset", handleReset);
  elements.seedButton.addEventListener("click", fillSample);
  elements.exportButton.addEventListener("click", exportCsv);
  elements.backupButton.addEventListener("click", exportBackup);
  elements.replaceButton.addEventListener("click", replaceWithSample);
  elements.importInput.addEventListener("change", importBackup);
  elements.searchInput.addEventListener("input", handleSearch);
  elements.installButton.addEventListener("click", installApp);
  elements.filterButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.filter = button.dataset.filter;
      updateFilterUi();
      render();
    });
  });

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.deferredPrompt = event;
    elements.installButton.classList.remove("hidden");
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {});
  }

  render();
}

function handleSubmit(event) {
  event.preventDefault();

  const title = elements.titleInput.value.trim();
  if (!title) {
    window.alert("请先填写工作内容。");
    return;
  }

  const existingId = elements.taskId.value;
  const previous = existingId ? findTask(existingId) : null;
  const task = {
    id: existingId || crypto.randomUUID(),
    title,
    detail: elements.detailInput.value.trim(),
    priority: elements.priorityInput.value,
    status: elements.statusInput.value,
    remindAt: elements.remindAtInput.value,
    createdAt: previous?.createdAt || new Date().toISOString(),
    completedAt: elements.statusInput.value === "completed"
      ? previous?.completedAt || new Date().toISOString()
      : ""
  };

  if (existingId) {
    state.tasks = state.tasks.map((item) => (item.id === existingId ? task : item));
  } else {
    state.tasks.unshift(task);
  }

  persistTasks();
  resetForm();
  render();
}

function handleReset() {
  setTimeout(resetForm, 0);
}

function resetForm() {
  elements.taskId.value = "";
  elements.titleInput.value = "";
  elements.detailInput.value = "";
  elements.priorityInput.value = "medium";
  elements.statusInput.value = "pending";
  elements.remindAtInput.value = "";
  elements.saveButton.textContent = "保存记录";
}

function fillSample() {
  elements.titleInput.value = "跟进客户报价确认";
  elements.detailInput.value = "把未回消息客户重新整理，晚上前确认报价版本。";
  elements.priorityInput.value = "high";
  elements.statusInput.value = "pending";
  elements.remindAtInput.value = suggestReminderValue();
}

function replaceWithSample() {
  if (!window.confirm("确认用示例任务覆盖当前数据吗？")) {
    return;
  }

  state.tasks = sampleTasks();
  persistTasks();
  resetForm();
  render();
}

function handleSearch(event) {
  state.query = event.target.value.trim().toLowerCase();
  render();
}

function installApp() {
  if (!state.deferredPrompt) {
    window.alert("当前浏览器暂时没有提供安装提示。你也可以用浏览器菜单选择“添加到主屏幕”。");
    return;
  }

  state.deferredPrompt.prompt();
  state.deferredPrompt = null;
  elements.installButton.classList.add("hidden");
}

function render() {
  const tasks = getVisibleTasks();
  elements.taskList.innerHTML = "";

  tasks.forEach((task) => {
    const node = elements.taskTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector(".task-id").textContent = `任务 ${task.id.slice(0, 8)}`;
    node.querySelector(".task-title").textContent = task.title;
    node.querySelector(".task-detail").textContent = task.detail || "暂无补充说明";

    const priorityBadge = node.querySelector(".priority-badge");
    priorityBadge.textContent = priorityText(task.priority);
    priorityBadge.classList.add(priorityClass(task.priority));

    const statusBadge = node.querySelector(".status-badge");
    statusBadge.textContent = task.status === "completed" ? "已完成" : "未完成";
    statusBadge.classList.add(task.status === "completed" ? "status-completed" : "status-pending");

    node.querySelector(".task-meta").innerHTML = [
      `<span>创建于 ${formatDateTime(task.createdAt)}</span>`,
      task.completedAt ? `<span>完成于 ${formatDateTime(task.completedAt)}</span>` : "",
      task.remindAt ? `<span>提醒 ${formatLocalInput(task.remindAt)}</span>` : ""
    ].filter(Boolean).join("");

    node.querySelector(".edit-button").addEventListener("click", () => editTask(task.id));
    node.querySelector(".toggle-button").textContent = task.status === "completed" ? "改回未完成" : "标记完成";
    node.querySelector(".toggle-button").addEventListener("click", () => toggleTask(task.id));
    node.querySelector(".delete-button").addEventListener("click", () => deleteTask(task.id));

    elements.taskList.appendChild(node);
  });

  elements.emptyState.hidden = tasks.length > 0;
  renderStats();
}

function renderStats() {
  const total = state.tasks.length;
  const pending = state.tasks.filter((task) => task.status === "pending").length;
  const completed = state.tasks.filter((task) => task.status === "completed").length;
  const high = state.tasks.filter((task) => task.status === "pending" && task.priority === "high").length;

  elements.totalCount.textContent = String(total);
  elements.pendingCount.textContent = String(pending);
  elements.completedCount.textContent = String(completed);
  elements.highCount.textContent = String(high);
}

function getVisibleTasks() {
  return state.tasks.filter((task) => {
    const text = [task.title, task.detail, task.remindAt].join(" ").toLowerCase();
    const keywordMatch = !state.query || text.includes(state.query);
    if (!keywordMatch) {
      return false;
    }

    switch (state.filter) {
      case "pending":
        return task.status === "pending";
      case "completed":
        return task.status === "completed";
      case "high":
        return task.status === "pending" && task.priority === "high";
      case "reminder":
        return Boolean(task.remindAt);
      default:
        return true;
    }
  });
}

function updateFilterUi() {
  elements.filterButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.filter === state.filter);
  });
}

function editTask(id) {
  const task = findTask(id);
  if (!task) {
    return;
  }

  elements.taskId.value = task.id;
  elements.titleInput.value = task.title;
  elements.detailInput.value = task.detail;
  elements.priorityInput.value = task.priority;
  elements.statusInput.value = task.status;
  elements.remindAtInput.value = task.remindAt;
  elements.saveButton.textContent = "保存修改";
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function toggleTask(id) {
  state.tasks = state.tasks.map((task) => {
    if (task.id !== id) {
      return task;
    }

    const nextStatus = task.status === "completed" ? "pending" : "completed";
    return {
      ...task,
      status: nextStatus,
      completedAt: nextStatus === "completed" ? new Date().toISOString() : ""
    };
  });

  persistTasks();
  render();
}

function deleteTask(id) {
  if (!window.confirm("确认删除这条记录吗？")) {
    return;
  }

  state.tasks = state.tasks.filter((task) => task.id !== id);
  persistTasks();
  render();
}

function exportCsv() {
  if (!state.tasks.length) {
    window.alert("当前没有可导出的记录。");
    return;
  }

  const rows = [
    ["标题", "说明", "优先级", "状态", "提醒时间", "创建时间", "完成时间"],
    ...state.tasks.map((task) => [
      task.title,
      task.detail,
      priorityText(task.priority),
      task.status === "completed" ? "已完成" : "未完成",
      task.remindAt ? formatLocalInput(task.remindAt) : "",
      formatDateTime(task.createdAt),
      task.completedAt ? formatDateTime(task.completedAt) : ""
    ])
  ];

  downloadFile(
    rows.map((row) => row.map(escapeCsvField).join(",")).join("\n"),
    `mobile-worklog-${new Date().toISOString().slice(0, 10)}.csv`,
    "text/csv;charset=utf-8;",
    true
  );
}

function exportBackup() {
  const backup = {
    exportedAt: new Date().toISOString(),
    version: 1,
    tasks: state.tasks
  };

  downloadFile(
    JSON.stringify(backup, null, 2),
    `mobile-worklog-backup-${new Date().toISOString().slice(0, 10)}.json`,
    "application/json;charset=utf-8;"
  );
}

async function importBackup(event) {
  const file = event.target.files[0];
  if (!file) {
    return;
  }

  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const tasks = Array.isArray(parsed) ? parsed : parsed.tasks;

    if (!Array.isArray(tasks)) {
      throw new Error("invalid");
    }

    state.tasks = tasks
      .filter((task) => task && task.id && task.title)
      .map((task) => ({
        id: String(task.id),
        title: String(task.title),
        detail: String(task.detail || ""),
        priority: normalizePriority(task.priority),
        status: task.status === "completed" ? "completed" : "pending",
        remindAt: String(task.remindAt || ""),
        createdAt: task.createdAt || new Date().toISOString(),
        completedAt: task.status === "completed" ? String(task.completedAt || "") : ""
      }));

    persistTasks();
    resetForm();
    render();
    window.alert("导入恢复成功。");
  } catch {
    window.alert("导入失败，请确认你选择的是本工具导出的 JSON 备份文件。");
  } finally {
    elements.importInput.value = "";
  }
}

function loadTasks() {
  try {
    return JSON.parse(localStorage.getItem(storageKey)) || [];
  } catch {
    return [];
  }
}

function persistTasks() {
  localStorage.setItem(storageKey, JSON.stringify(state.tasks));
}

function findTask(id) {
  return state.tasks.find((task) => task.id === id);
}

function priorityText(priority) {
  return {
    high: "高优先级",
    medium: "中优先级",
    low: "低优先级"
  }[priority] || "中优先级";
}

function priorityClass(priority) {
  return {
    high: "priority-high",
    medium: "priority-medium",
    low: "priority-low"
  }[priority] || "priority-medium";
}

function normalizePriority(priority) {
  return ["high", "medium", "low"].includes(priority) ? priority : "medium";
}

function formatDateTime(value) {
  const date = new Date(value);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatLocalInput(value) {
  if (!value) {
    return "";
  }
  return value.replace("T", " ");
}

function suggestReminderValue() {
  const next = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}T09:00`;
}

function escapeCsvField(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function downloadFile(content, filename, type, prependBom = false) {
  const body = prependBom ? "\uFEFF" + content : content;
  const blob = new Blob([body], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function sampleTasks() {
  const now = Date.now();
  return [
    {
      id: crypto.randomUUID(),
      title: "整理本周客户跟进清单",
      detail: "把未回消息和待报价客户重新分类。",
      priority: "high",
      status: "pending",
      remindAt: suggestReminderValue(),
      createdAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
      completedAt: ""
    },
    {
      id: crypto.randomUUID(),
      title: "补充项目阶段总结",
      detail: "重点补齐风险项和下一步安排。",
      priority: "medium",
      status: "pending",
      remindAt: "",
      createdAt: new Date(now - 8 * 60 * 60 * 1000).toISOString(),
      completedAt: ""
    },
    {
      id: crypto.randomUUID(),
      title: "提交日报初稿",
      detail: "已经发给自己复核。",
      priority: "low",
      status: "completed",
      remindAt: "",
      createdAt: new Date(now - 28 * 60 * 60 * 1000).toISOString(),
      completedAt: new Date(now - 20 * 60 * 60 * 1000).toISOString()
    }
  ];
}

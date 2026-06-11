const storageKey = "mobile-worklog-pwa-tasks";
const summaryStorageKey = "mobile-worklog-pwa-daily-summary";

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
  saveButton: document.getElementById("saveButton"),
  resetButton: document.getElementById("resetButton"),
  installButton: document.getElementById("installButton"),
  dailySummaryInput: document.getElementById("dailySummaryInput"),
  searchInput: document.getElementById("searchInput"),
  filterButtons: Array.from(document.querySelectorAll(".filter-chip")),
  taskList: document.getElementById("taskList"),
  emptyState: document.getElementById("emptyState"),
  taskTemplate: document.getElementById("taskTemplate")
};

init();

function init() {
  elements.taskForm.addEventListener("submit", handleSubmit);
  elements.taskForm.addEventListener("reset", handleReset);
  elements.dailySummaryInput.addEventListener("input", handleSummaryInput);
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

  updateFilterUi();
  elements.dailySummaryInput.value = loadSummary();
  render();
}

function handleSubmit(event) {
  event.preventDefault();

  const title = elements.titleInput.value.trim();
  if (!title) {
    window.alert("请先填写工作内容。");
    return;
  }

  if (trySmartComplete(title)) {
    resetForm();
    render();
    return;
  }

  const existingId = elements.taskId.value;
  const previous = existingId ? findTask(existingId) : null;

  const task = {
    id: existingId || crypto.randomUUID(),
    title,
    status: previous?.status || "pending",
    createdAt: previous?.createdAt || new Date().toISOString()
  };

  if (existingId) {
    state.tasks = state.tasks.map((item) => (item.id === existingId ? task : item));
  } else {
    state.tasks.push(task);
  }

  persistTasks();
  resetForm();
  render();
}

function trySmartComplete(input) {
  const match = input.match(/^(完成|已完成|done)\s+(.+)$/i);
  if (!match) {
    return false;
  }

  const keyword = match[2].trim().toLowerCase();
  if (!keyword) {
    window.alert("请在“完成”后面补上任务关键词。");
    return true;
  }

  const pendingTasks = state.tasks.filter((task) => task.status === "pending");
  const target = pendingTasks
    .map((task) => ({
      task,
      score: getMatchScore(task.title.toLowerCase(), keyword)
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)[0];

  if (!target) {
    window.alert(`没有找到包含“${match[2].trim()}”的未完成任务。`);
    return true;
  }

  state.tasks = state.tasks.map((task) => {
    if (task.id !== target.task.id) {
      return task;
    }

    return {
      ...task,
      status: "completed"
    };
  });

  persistTasks();
  window.alert(`已自动完成：${target.task.title}`);
  return true;
}

function handleReset() {
  setTimeout(resetForm, 0);
}

function handleSearch(event) {
  state.query = event.target.value.trim().toLowerCase();
  render();
}

function handleSummaryInput(event) {
  localStorage.setItem(summaryStorageKey, event.target.value);
}

function installApp() {
  if (!state.deferredPrompt) {
    window.alert("当前浏览器暂时没有弹出安装提示。你也可以用浏览器菜单选择“添加到主屏幕”。");
    return;
  }

  state.deferredPrompt.prompt();
  state.deferredPrompt = null;
  elements.installButton.classList.add("hidden");
}

function resetForm() {
  elements.taskForm.reset();
  elements.taskId.value = "";
  elements.saveButton.textContent = "保存记录";
  requestAnimationFrame(() => {
    elements.titleInput.focus();
  });
}

function render() {
  const tasks = getVisibleTasks();
  elements.taskList.innerHTML = "";

  tasks.forEach((task) => {
    const node = elements.taskTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector(".task-title").textContent = task.title;

    node.querySelector(".edit-button").addEventListener("click", () => editTask(task.id));
    node.querySelector(".toggle-button").textContent = task.status === "completed" ? "改回未完成" : "标记完成";
    node.querySelector(".toggle-button").addEventListener("click", () => toggleTask(task.id));
    node.querySelector(".delete-button").addEventListener("click", () => deleteTask(task.id));

    elements.taskList.appendChild(node);
  });

  elements.emptyState.hidden = tasks.length > 0;
}

function getVisibleTasks() {
  return state.tasks.filter((task) => {
    const keywordMatch = !state.query || task.title.toLowerCase().includes(state.query);
    if (!keywordMatch) {
      return false;
    }

    switch (state.filter) {
      case "pending":
        return task.status === "pending";
      case "completed":
        return task.status === "completed";
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
  elements.saveButton.textContent = "保存修改";
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function toggleTask(id) {
  state.tasks = state.tasks.map((task) => {
    if (task.id !== id) {
      return task;
    }

    return {
      ...task,
      status: task.status === "completed" ? "pending" : "completed"
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

function loadTasks() {
  try {
    const tasks = JSON.parse(localStorage.getItem(storageKey)) || [];
    return tasks
      .filter((task) => task && task.title)
      .map((task) => ({
        id: String(task.id || crypto.randomUUID()),
        title: String(task.title),
        status: task.status === "completed" ? "completed" : "pending",
        createdAt: task.createdAt || new Date().toISOString()
      }));
  } catch {
    return [];
  }
}

function loadSummary() {
  try {
    return localStorage.getItem(summaryStorageKey) || "";
  } catch {
    return "";
  }
}

function persistTasks() {
  localStorage.setItem(storageKey, JSON.stringify(state.tasks));
}

function findTask(id) {
  return state.tasks.find((task) => task.id === id);
}

function getMatchScore(title, keyword) {
  if (title === keyword) {
    return 100;
  }

  if (title.includes(keyword)) {
    return 80 + keyword.length;
  }

  const words = keyword.split(/\s+/).filter(Boolean);
  if (!words.length) {
    return 0;
  }

  let score = 0;
  words.forEach((word) => {
    if (title.includes(word)) {
      score += 20 + word.length;
    }
  });

  return score;
}

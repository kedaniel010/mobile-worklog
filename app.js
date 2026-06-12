const localStorageKey = "mobile-worklog-local-tasks";
const reminderStorageKey = "mobile-worklog-reminders";
const TABLE_NAME = "work_tasks";

const config = window.WORKLOG_SUPABASE || {};
const hasCloudConfig = Boolean(config.url && config.anonKey && window.supabase);
const supabaseClient = hasCloudConfig
  ? window.supabase.createClient(config.url, config.anonKey)
  : null;

const state = {
  tasks: [],
  reminders: [],
  filter: "pending",
  query: "",
  deferredPrompt: null,
  session: null,
  loading: true,
  editingTaskId: "",
  reminderTimer: null
};

const elements = {
  authScreen: document.getElementById("authScreen"),
  appContent: document.getElementById("appContent"),
  taskForm: document.getElementById("taskForm"),
  taskId: document.getElementById("taskId"),
  titleInput: document.getElementById("titleInput"),
  saveButton: document.getElementById("saveButton"),
  resetButton: document.getElementById("resetButton"),
  installButton: document.getElementById("installButton"),
  searchInput: document.getElementById("searchInput"),
  filterButtons: Array.from(document.querySelectorAll(".filter-chip")),
  taskList: document.getElementById("taskList"),
  emptyState: document.getElementById("emptyState"),
  taskTemplate: document.getElementById("taskTemplate"),
  reminderList: document.getElementById("reminderList"),
  reminderEmpty: document.getElementById("reminderEmpty"),
  reminderTemplate: document.getElementById("reminderTemplate"),
  summaryIntro: document.getElementById("summaryIntro"),
  summaryList: document.getElementById("summaryList"),
  summaryEmpty: document.getElementById("summaryEmpty"),
  emailInput: document.getElementById("emailInput"),
  sendMagicLinkButton: document.getElementById("sendMagicLinkButton"),
  signOutButton: document.getElementById("signOutButton"),
  authStatus: document.getElementById("authStatus"),
  sessionText: document.getElementById("sessionText")
};

init();

async function init() {
  elements.taskForm.addEventListener("submit", handleSubmit);
  elements.taskForm.addEventListener("reset", handleReset);
  elements.searchInput.addEventListener("input", handleSearch);
  elements.installButton.addEventListener("click", installApp);
  elements.sendMagicLinkButton.addEventListener("click", sendMagicLink);
  elements.signOutButton.addEventListener("click", signOut);

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

  if (!hasCloudConfig) {
    state.tasks = loadLocalTasks();
    state.reminders = loadReminders();
    state.loading = false;
    elements.authScreen.classList.add("hidden");
    elements.appContent.classList.remove("hidden");
    updateAuthUi("当前是本地版，暂未接入云同步。");
    startReminderWatcher();
    render();
    focusTitleInput();
    return;
  }

  const { data } = await supabaseClient.auth.getSession();
  state.session = data.session || null;

  supabaseClient.auth.onAuthStateChange(async (_event, session) => {
    state.session = session || null;
    state.editingTaskId = "";
    await loadTasks();
    state.reminders = loadReminders();
    updateAuthUi();
    updateViewMode();
    startReminderWatcher();
    render();
  });

  await loadTasks();
  state.reminders = loadReminders();
  updateAuthUi();
  updateViewMode();
  startReminderWatcher();
  render();
}

async function loadTasks() {
  if (!hasCloudConfig) {
    state.tasks = loadLocalTasks();
    state.loading = false;
    return;
  }

  if (!state.session?.user) {
    state.tasks = [];
    state.loading = false;
    return;
  }

  const { data, error } = await supabaseClient
    .from(TABLE_NAME)
    .select("id, user_id, title, status, created_at, completed_at")
    .order("created_at", { ascending: true });

  if (error) {
    updateAuthUi(`读取同步数据失败：${error.message}`);
    state.tasks = [];
    state.loading = false;
    return;
  }

  state.tasks = (data || []).map((task) => ({
    id: String(task.id),
    title: String(task.title || ""),
    status: task.status === "completed" ? "completed" : "pending",
    createdAt: task.created_at || new Date().toISOString(),
    completedAt: task.completed_at || ""
  }));
  state.loading = false;
}

async function handleSubmit(event) {
  event.preventDefault();

  const title = elements.titleInput.value.trim();
  if (!title) {
    window.alert("请先填写工作内容。");
    focusTitleInput();
    return;
  }

  if (hasCloudConfig && !state.session?.user) {
    window.alert("请先登录，再保存同步任务。");
    return;
  }

  elements.saveButton.disabled = true;

  try {
    if (await trySmartComplete(title)) {
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
      createdAt: previous?.createdAt || new Date().toISOString(),
      completedAt: previous?.status === "completed" ? previous.completedAt || new Date().toISOString() : ""
    };

    if (hasCloudConfig && state.session?.user) {
      if (existingId) {
        const { error } = await supabaseClient
          .from(TABLE_NAME)
          .update({
            title: task.title,
            status: task.status,
            completed_at: task.completedAt || null
          })
          .eq("id", task.id);

        if (error) {
          window.alert(`保存修改失败：${error.message}`);
          return;
        }
      } else {
        const { error } = await supabaseClient
          .from(TABLE_NAME)
          .insert({
            id: task.id,
            user_id: state.session.user.id,
            title: task.title,
            status: task.status,
            created_at: task.createdAt,
            completed_at: task.completedAt || null
          });

        if (error) {
          window.alert(`新增记录失败：${error.message}`);
          return;
        }
      }

      await loadTasks();
    } else {
      if (existingId) {
        state.tasks = state.tasks.map((item) => (item.id === existingId ? task : item));
      } else {
        state.tasks.push(task);
      }
      persistLocalTasks();
    }

    resetForm();
    render();
  } finally {
    elements.saveButton.disabled = false;
    focusTitleInput(true);
  }
}

async function trySmartComplete(input) {
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

  const nextTask = {
    ...target.task,
    status: "completed",
    completedAt: new Date().toISOString()
  };

  if (hasCloudConfig && state.session?.user) {
    const { error } = await supabaseClient
      .from(TABLE_NAME)
      .update({
        status: "completed",
        completed_at: nextTask.completedAt
      })
      .eq("id", nextTask.id);

    if (error) {
      window.alert(`自动完成失败：${error.message}`);
      return true;
    }

    await loadTasks();
  } else {
    state.tasks = state.tasks.map((task) => (task.id === nextTask.id ? nextTask : task));
    persistLocalTasks();
  }

  window.alert(`已自动完成：${target.task.title}`);
  return true;
}

function handleReset() {
  setTimeout(() => {
    resetForm();
    focusTitleInput();
  }, 0);
}

function handleSearch(event) {
  state.query = event.target.value.trim().toLowerCase();
  render();
}

async function sendMagicLink() {
  if (!hasCloudConfig) {
    window.alert("当前还没有接入云同步。");
    return;
  }

  const email = elements.emailInput.value.trim();
  if (!email) {
    window.alert("请先输入邮箱。");
    return;
  }

  elements.sendMagicLinkButton.disabled = true;

  try {
    const { error } = await supabaseClient.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: window.location.href.split("#")[0]
      }
    });

    if (error) {
      window.alert(`发送登录链接失败：${error.message}`);
      return;
    }

    updateAuthUi(`登录邮件已发送到：${email}。请点击邮箱里的登录链接完成登录。`);
  } finally {
    elements.sendMagicLinkButton.disabled = false;
  }
}

async function signOut() {
  if (!hasCloudConfig) {
    return;
  }

  await supabaseClient.auth.signOut();
}

function installApp() {
  if (!state.deferredPrompt) {
    window.alert("当前浏览器暂时没有弹出安装提示，也可以用浏览器菜单选择“添加到桌面”。");
    return;
  }

  state.deferredPrompt.prompt();
  state.deferredPrompt = null;
  elements.installButton.classList.add("hidden");
}

function updateAuthUi(customText) {
  if (customText) {
    elements.authStatus.textContent = customText;
  } else if (state.session?.user?.email) {
    elements.authStatus.textContent = `当前已登录：${state.session.user.email}`;
  } else {
    elements.authStatus.textContent = "先完成登录，再进入记录页面。";
  }

  elements.sessionText.textContent = state.session?.user?.email
    ? `已登录：${state.session.user.email}`
    : "";
}

function updateViewMode() {
  const loggedIn = Boolean(state.session?.user) || !hasCloudConfig;
  elements.authScreen.classList.toggle("hidden", loggedIn);
  elements.appContent.classList.toggle("hidden", !loggedIn);

  if (loggedIn) {
    focusTitleInput();
  }
}

function resetForm() {
  elements.taskForm.reset();
  elements.taskId.value = "";
  elements.titleInput.value = "";
  elements.saveButton.textContent = "保存记录";
}

function focusTitleInput(selectText = false) {
  requestAnimationFrame(() => {
    elements.titleInput.focus();
    if (selectText) {
      elements.titleInput.select?.();
    }
  });
}

function render() {
  const tasks = getVisibleTasks();
  elements.taskList.innerHTML = "";

  tasks.forEach((task) => {
    const node = elements.taskTemplate.content.firstElementChild.cloneNode(true);
    const viewRow = node.querySelector(".task-view-row");
    const editRow = node.querySelector(".task-edit-row");
    const editInput = node.querySelector(".task-edit-input");
    const isEditing = state.editingTaskId === task.id;

    node.querySelector(".task-title").textContent = task.title;
    node.querySelector(".edit-button").addEventListener("click", () => editTask(task.id));
    const remindButton = node.querySelector(".remind-button");
    remindButton.hidden = task.status === "completed";
    remindButton.addEventListener("click", () => setReminderForTask(task.id));
    node.querySelector(".toggle-button").textContent = task.status === "completed" ? "改回未完成" : "标记完成";
    node.querySelector(".toggle-button").addEventListener("click", () => toggleTask(task.id));
    node.querySelector(".save-edit-button").addEventListener("click", () => saveInlineEdit(task.id, editInput));
    node.querySelector(".cancel-edit-button").addEventListener("click", cancelInlineEdit);

    editInput.value = task.title;
    editInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        saveInlineEdit(task.id, editInput);
      }

      if (event.key === "Escape") {
        event.preventDefault();
        cancelInlineEdit();
      }
    });

    viewRow.classList.toggle("hidden", isEditing);
    editRow.classList.toggle("hidden", !isEditing);

    if (isEditing) {
      requestAnimationFrame(() => {
        editInput.focus();
        editInput.select();
      });
    }

    elements.taskList.appendChild(node);
  });

  elements.emptyState.hidden = tasks.length > 0;
  if (state.loading) {
    elements.emptyState.hidden = false;
    elements.emptyState.textContent = "正在读取数据...";
  } else if (!tasks.length) {
    elements.emptyState.hidden = false;
    elements.emptyState.textContent = "还没有记录，先新增一条吧。";
  }

  renderDailySummary();
  renderReminders();
}

function renderDailySummary() {
  const completedToday = state.tasks.filter((task) => (
    task.status === "completed"
    && task.completedAt
    && isToday(task.completedAt)
  ));

  elements.summaryList.innerHTML = "";

  if (!completedToday.length) {
    elements.summaryIntro.textContent = "今天暂时还没有完成的任务。";
    elements.summaryEmpty.hidden = false;
    return;
  }

  elements.summaryIntro.textContent = `今天已完成 ${completedToday.length} 项工作：`;
  elements.summaryEmpty.hidden = true;

  completedToday.forEach((task) => {
    const item = document.createElement("li");
    item.textContent = task.title;
    elements.summaryList.appendChild(item);
  });
}

function renderReminders() {
  elements.reminderList.innerHTML = "";

  const reminders = getVisibleReminders();

  reminders.forEach((reminder) => {
    const task = findTask(reminder.taskId);
    if (!task) {
      return;
    }

    const node = elements.reminderTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector(".reminder-title").textContent = task.title;
    node.querySelector(".reminder-time").textContent = `提醒时间：${formatReminderTime(reminder.remindAt)}`;
    node.querySelector(".reminder-complete-button").addEventListener("click", () => completeReminderTask(reminder.taskId));
    node.querySelector(".reminder-clear-button").addEventListener("click", () => clearReminder(reminder.taskId));
    elements.reminderList.appendChild(node);
  });

  elements.reminderEmpty.hidden = reminders.length > 0;
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

function getVisibleReminders() {
  return state.reminders
    .map((reminder) => {
      const task = findTask(reminder.taskId);
      return task && task.status === "pending" ? reminder : null;
    })
    .filter(Boolean)
    .sort((a, b) => new Date(a.remindAt).getTime() - new Date(b.remindAt).getTime());
}

function editTask(id) {
  const task = findTask(id);
  if (!task) {
    return;
  }

  state.editingTaskId = id;
  render();
}

async function saveInlineEdit(id, input) {
  const current = findTask(id);
  if (!current) {
    return;
  }

  const nextTitle = input.value.trim();
  if (!nextTitle) {
    window.alert("请先填写工作内容。");
    input.focus();
    return;
  }

  const nextTask = {
    ...current,
    title: nextTitle
  };

  if (hasCloudConfig && state.session?.user) {
    const { error } = await supabaseClient
      .from(TABLE_NAME)
      .update({
        title: nextTask.title
      })
      .eq("id", id);

    if (error) {
      window.alert(`保存修改失败：${error.message}`);
      return;
    }

    await loadTasks();
  } else {
    state.tasks = state.tasks.map((task) => (task.id === id ? nextTask : task));
    persistLocalTasks();
  }

  state.editingTaskId = "";
  render();
}

function cancelInlineEdit() {
  state.editingTaskId = "";
  render();
}

async function toggleTask(id) {
  const current = findTask(id);
  if (!current) {
    return;
  }

  const nextCompleted = current.status !== "completed";
  const nextTask = {
    ...current,
    status: nextCompleted ? "completed" : "pending",
    completedAt: nextCompleted ? new Date().toISOString() : ""
  };

  if (hasCloudConfig && state.session?.user) {
    const { error } = await supabaseClient
      .from(TABLE_NAME)
      .update({
        status: nextTask.status,
        completed_at: nextTask.completedAt || null
      })
      .eq("id", id);

    if (error) {
      window.alert(`更新状态失败：${error.message}`);
      return;
    }

    await loadTasks();
  } else {
    state.tasks = state.tasks.map((task) => (task.id === id ? nextTask : task));
    persistLocalTasks();
  }

  if (nextCompleted) {
    removeReminderByTaskId(id);
  }

  if (state.editingTaskId === id) {
    state.editingTaskId = "";
  }

  render();
}

function loadLocalTasks() {
  try {
    const tasks = JSON.parse(localStorage.getItem(localStorageKey)) || [];
    return tasks
      .filter((task) => task && task.title)
      .map((task) => ({
        id: String(task.id || crypto.randomUUID()),
        title: String(task.title),
        status: task.status === "completed" ? "completed" : "pending",
        createdAt: task.createdAt || new Date().toISOString(),
        completedAt: task.completedAt || ""
      }));
  } catch {
    return [];
  }
}

function persistLocalTasks() {
  localStorage.setItem(localStorageKey, JSON.stringify(state.tasks));
}

function loadReminders() {
  try {
    const reminders = JSON.parse(localStorage.getItem(reminderStorageKey)) || [];
    return reminders
      .filter((item) => item && item.taskId && item.remindAt)
      .map((item) => ({
        taskId: String(item.taskId),
        remindAt: item.remindAt,
        notifiedAt: item.notifiedAt || ""
      }));
  } catch {
    return [];
  }
}

function persistReminders() {
  localStorage.setItem(reminderStorageKey, JSON.stringify(state.reminders));
}

function findTask(id) {
  return state.tasks.find((task) => task.id === id);
}

async function setReminderForTask(id) {
  const task = findTask(id);
  if (!task || task.status === "completed") {
    return;
  }

  const existing = state.reminders.find((item) => item.taskId === id);
  const defaultValue = existing?.remindAt ? toDateTimeLocalValue(existing.remindAt) : "";
  const rawValue = window.prompt(`给“${task.title}”设置提醒时间。\n请输入格式：2026-06-20 09:30`, defaultValue.replace("T", " "));

  if (rawValue === null) {
    return;
  }

  const remindAt = parseReminderInput(rawValue);
  if (!remindAt) {
    window.alert("提醒时间格式不对，请按 2026-06-20 09:30 这样的格式输入。");
    return;
  }

  if (new Date(remindAt).getTime() <= Date.now()) {
    window.alert("提醒时间需要晚于当前时间。");
    return;
  }

  state.reminders = [
    ...state.reminders.filter((item) => item.taskId !== id),
    {
      taskId: id,
      remindAt,
      notifiedAt: ""
    }
  ];

  persistReminders();
  ensureNotificationPermission();
  startReminderWatcher();
  render();
  window.alert("远期提醒已设置。");
}

function clearReminder(id) {
  removeReminderByTaskId(id);
  render();
}

async function completeReminderTask(id) {
  await toggleTask(id);
}

function removeReminderByTaskId(id) {
  const nextReminders = state.reminders.filter((item) => item.taskId !== id);
  if (nextReminders.length === state.reminders.length) {
    return;
  }

  state.reminders = nextReminders;
  persistReminders();
}

function startReminderWatcher() {
  if (state.reminderTimer) {
    window.clearInterval(state.reminderTimer);
  }

  checkReminders();
  state.reminderTimer = window.setInterval(checkReminders, 30000);
}

function checkReminders() {
  if (!state.reminders.length) {
    return;
  }

  const now = Date.now();
  let changed = false;

  state.reminders = state.reminders.map((reminder) => {
    const task = findTask(reminder.taskId);
    if (!task || task.status === "completed") {
      changed = true;
      return null;
    }

    const remindTime = new Date(reminder.remindAt).getTime();
    if (!Number.isFinite(remindTime)) {
      changed = true;
      return null;
    }

    if (!reminder.notifiedAt && remindTime <= now) {
      notifyReminder(task, reminder.remindAt);
      changed = true;
      return {
        ...reminder,
        notifiedAt: new Date().toISOString()
      };
    }

    return reminder;
  }).filter(Boolean);

  if (changed) {
    persistReminders();
    renderReminders();
  }
}

function notifyReminder(task, remindAt) {
  const title = `工作提醒：${task.title}`;
  const body = `到提醒时间了：${formatReminderTime(remindAt)}`;

  if ("Notification" in window && Notification.permission === "granted") {
    new Notification(title, { body });
  } else {
    window.alert(`${title}\n${body}`);
  }
}

function ensureNotificationPermission() {
  if (!("Notification" in window)) {
    return;
  }

  if (Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
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

function isToday(value) {
  const date = new Date(value);
  const now = new Date();
  return date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
}

function parseReminderInput(input) {
  const normalized = input.trim().replace(/\//g, "-").replace("T", " ");
  const match = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (!match) {
    return "";
  }

  const [, year, month, day, hour, minute] = match;
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    0,
    0
  );

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toISOString();
}

function formatReminderTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "未设置";
  }

  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function toDateTimeLocalValue(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

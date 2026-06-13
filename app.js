const localStorageKey = "mobile-worklog-local-tasks";
const TABLE_NAME = "work_tasks";
const URGENT_PREFIX = "__WORKLOG_URGENT__::";

const config = window.WORKLOG_SUPABASE || {};
const hasCloudConfig = Boolean(config.url && config.anonKey && window.supabase);
const supabaseClient = hasCloudConfig
  ? window.supabase.createClient(config.url, config.anonKey)
  : null;

const state = {
  tasks: [],
  filter: "pending",
  query: "",
  deferredPrompt: null,
  session: null,
  loading: true,
  editingTaskId: "",
  reminderTimer: null,
  cloudSyncTimer: null,
  realtimeChannel: null
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

  window.addEventListener("focus", () => {
    syncTasksInBackground();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      syncTasksInBackground();
    }
  });

  updateFilterUi();

  if (!hasCloudConfig) {
    state.tasks = loadLocalTasks();
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
    updateAuthUi();
    updateViewMode();
    startReminderWatcher();
    startCloudSyncWatcher();
    startRealtimeSyncWatcher();
    render();
  });

  await loadTasks();
  updateAuthUi();
  updateViewMode();
  startReminderWatcher();
  startCloudSyncWatcher();
  startRealtimeSyncWatcher();
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
    title: getDisplayTitle(task.title),
    urgent: isUrgentTitle(task.title),
    status: task.status === "completed" ? "completed" : (task.status === "reminder" ? "reminder" : "pending"),
    createdAt: task.created_at || new Date().toISOString(),
    completedAt: task.status === "completed" ? (task.completed_at || "") : "",
    remindAt: task.status === "reminder" ? (task.completed_at || "") : ""
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
      urgent: previous?.urgent || false,
      status: previous?.status || "pending",
      createdAt: previous?.createdAt || new Date().toISOString(),
      completedAt: previous?.status === "completed" ? previous.completedAt || new Date().toISOString() : "",
      remindAt: previous?.status === "reminder" ? previous.remindAt || "" : ""
    };

    if (hasCloudConfig && state.session?.user) {
      if (existingId) {
        const { error } = await supabaseClient
          .from(TABLE_NAME)
          .update({
            title: toStoredTitle(task.title, task.urgent),
            status: task.status,
            completed_at: getCloudTimeValue(task)
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
            title: toStoredTitle(task.title, task.urgent),
            status: task.status,
            created_at: task.createdAt,
            completed_at: getCloudTimeValue(task)
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
    window.setTimeout(() => focusTitleInput(false), 40);
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

  const pendingTasks = state.tasks.filter((task) => task.status !== "completed");
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
    completedAt: new Date().toISOString(),
    remindAt: ""
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
    elements.titleInput.focus({ preventScroll: true });
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
    node.querySelector(".task-title").classList.toggle("danger-text", Boolean(task.urgent));
    node.querySelector(".edit-button").addEventListener("click", () => editTask(task.id));
    const urgentButton = node.querySelector(".urgent-button");
    urgentButton.textContent = task.urgent ? "取消紧急" : "紧急";
    urgentButton.classList.toggle("danger-text", Boolean(task.urgent));
    urgentButton.addEventListener("click", () => toggleUrgent(task.id));
    const remindButton = node.querySelector(".remind-button");
    remindButton.hidden = task.status !== "pending";
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
        editInput.focus({ preventScroll: true });
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

  reminders.forEach((task) => {
    const node = elements.reminderTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector(".reminder-title").textContent = task.title;
    node.querySelector(".reminder-time").textContent = `提醒时间：${formatReminderTime(task.remindAt)}`;
    node.querySelector(".reminder-complete-button").addEventListener("click", () => completeReminderTask(task.id));
    node.querySelector(".reminder-clear-button").addEventListener("click", () => clearReminder(task.id));
    elements.reminderList.appendChild(node);
  });

  elements.reminderEmpty.hidden = reminders.length > 0;
}

function getVisibleTasks() {
  const reminderTitleKeys = new Set(
    state.tasks
      .filter((task) => task.status === "reminder")
      .map((task) => getTaskTitleKey(task.title))
  );

  return state.tasks.filter((task) => {
    if (task.status === "reminder") {
      return false;
    }

    if (task.status === "pending" && reminderTitleKeys.has(getTaskTitleKey(task.title))) {
      return false;
    }

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
  }).sort(compareTasksForList);
}

function updateFilterUi() {
  elements.filterButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.filter === state.filter);
  });
}

function getVisibleReminders() {
  return state.tasks
    .filter((task) => task.status === "reminder" && task.remindAt)
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
        title: toStoredTitle(nextTask.title, nextTask.urgent)
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
    completedAt: nextCompleted ? new Date().toISOString() : "",
    remindAt: ""
  };

  if (hasCloudConfig && state.session?.user) {
    const { error } = await supabaseClient
      .from(TABLE_NAME)
      .update({
        status: nextTask.status,
        completed_at: getCloudTimeValue(nextTask)
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

  if (state.editingTaskId === id) {
    state.editingTaskId = "";
  }

  render();
}

async function toggleUrgent(id) {
  const current = findTask(id);
  if (!current) {
    return;
  }

  const nextTask = {
    ...current,
    urgent: !current.urgent
  };

  if (hasCloudConfig && state.session?.user) {
    const { error } = await supabaseClient
      .from(TABLE_NAME)
      .update({
        title: toStoredTitle(nextTask.title, nextTask.urgent)
      })
      .eq("id", id);

    if (error) {
      window.alert(`更新紧急状态失败：${error.message}`);
      return;
    }

    await loadTasks();
  } else {
    state.tasks = state.tasks.map((task) => (task.id === id ? nextTask : task));
    persistLocalTasks();
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
        title: getDisplayTitle(task.title),
        urgent: isUrgentTitle(task.title),
        status: task.status === "completed" ? "completed" : (task.status === "reminder" ? "reminder" : "pending"),
        createdAt: task.createdAt || new Date().toISOString(),
        completedAt: task.status === "completed" ? (task.completedAt || "") : "",
        remindAt: task.status === "reminder" ? (task.remindAt || "") : ""
      }));
  } catch {
    return [];
  }
}

function persistLocalTasks() {
  localStorage.setItem(localStorageKey, JSON.stringify(state.tasks));
}

function findTask(id) {
  return state.tasks.find((task) => task.id === id);
}

async function setReminderForTask(id) {
  const task = findTask(id);
  if (!task || task.status === "completed") {
    return;
  }

  const defaultValue = task.remindAt ? toDateTimeLocalValue(task.remindAt) : "";
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

  const nextTask = {
    ...task,
    status: "reminder",
    completedAt: "",
    remindAt
  };

  if (hasCloudConfig && state.session?.user) {
    const { error } = await supabaseClient
      .from(TABLE_NAME)
      .update({
        status: "reminder",
        completed_at: remindAt
      })
      .eq("id", id);

    if (error) {
      window.alert(`设置提醒失败：${error.message}`);
      return;
    }

    await loadTasks();
  } else {
    state.tasks = state.tasks.map((item) => (item.id === id ? nextTask : item));
    persistLocalTasks();
  }

  ensureNotificationPermission();
  startReminderWatcher();
  render();
  window.alert("远期提醒已设置。");
}

async function clearReminder(id) {
  const task = findTask(id);
  if (!task) {
    return;
  }

  const nextTask = {
    ...task,
    status: "pending",
    completedAt: "",
    remindAt: ""
  };

  if (hasCloudConfig && state.session?.user) {
    const { error } = await supabaseClient
      .from(TABLE_NAME)
      .update({
        status: "pending",
        completed_at: null
      })
      .eq("id", id);

    if (error) {
      window.alert(`取消提醒失败：${error.message}`);
      return;
    }

    await loadTasks();
  } else {
    state.tasks = state.tasks.map((item) => (item.id === id ? nextTask : item));
    persistLocalTasks();
  }

  render();
}

async function completeReminderTask(id) {
  await toggleTask(id);
}

function startReminderWatcher() {
  if (state.reminderTimer) {
    window.clearInterval(state.reminderTimer);
  }

  checkReminders();
  state.reminderTimer = window.setInterval(checkReminders, 30000);
}

function startCloudSyncWatcher() {
  if (state.cloudSyncTimer) {
    window.clearInterval(state.cloudSyncTimer);
    state.cloudSyncTimer = null;
  }

  if (!hasCloudConfig || !state.session?.user) {
    return;
  }

  state.cloudSyncTimer = window.setInterval(() => {
    syncTasksInBackground();
  }, 15000);
}

function startRealtimeSyncWatcher() {
  if (state.realtimeChannel) {
    supabaseClient.removeChannel(state.realtimeChannel);
    state.realtimeChannel = null;
  }

  if (!hasCloudConfig || !state.session?.user) {
    return;
  }

  state.realtimeChannel = supabaseClient
    .channel(`worklog-sync-${state.session.user.id}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: TABLE_NAME,
        filter: `user_id=eq.${state.session.user.id}`
      },
      async () => {
        await syncTasksInBackground();
      }
    )
    .subscribe();
}

async function syncTasksInBackground() {
  if (!hasCloudConfig || !state.session?.user) {
    return;
  }

  if (state.editingTaskId) {
    return;
  }

  await loadTasks();
  render();
}

function checkReminders() {
  const reminders = getVisibleReminders();
  if (!reminders.length) {
    return;
  }

  const now = Date.now();

  reminders.forEach((task) => {
    const remindTime = new Date(task.remindAt).getTime();
    if (!Number.isFinite(remindTime)) {
      return;
    }

    const notifyKey = `reminder-notified-${task.id}-${task.remindAt}`;
    if (remindTime <= now && !sessionStorage.getItem(notifyKey)) {
      notifyReminder(task, task.remindAt);
      sessionStorage.setItem(notifyKey, "1");
    }
  });
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

function compareTasksForList(a, b) {
  if (Boolean(a.urgent) !== Boolean(b.urgent)) {
    return a.urgent ? -1 : 1;
  }

  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
}

function isUrgentTitle(value) {
  return String(value || "").startsWith(URGENT_PREFIX);
}

function getDisplayTitle(value) {
  const text = String(value || "");
  return isUrgentTitle(text) ? text.slice(URGENT_PREFIX.length) : text;
}

function toStoredTitle(title, urgent) {
  const cleanTitle = getDisplayTitle(title).trim();
  return urgent ? `${URGENT_PREFIX}${cleanTitle}` : cleanTitle;
}

function getTaskTitleKey(title) {
  return String(title || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，。！？,.!?:：;；、"'“”‘’\-_/\\()（）【】\[\]]/g, "");
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

function getCloudTimeValue(task) {
  if (task.status === "completed") {
    return task.completedAt || null;
  }

  if (task.status === "reminder") {
    return task.remindAt || null;
  }

  return null;
}

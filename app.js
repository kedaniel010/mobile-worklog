const localStorageKey = "mobile-worklog-local-tasks";
const TABLE_NAME = "work_tasks";

const config = window.WORKLOG_SUPABASE || {};
const hasCloudConfig = Boolean(config.url && config.anonKey && window.supabase);
const supabaseClient = hasCloudConfig
  ? window.supabase.createClient(config.url, config.anonKey)
  : null;

const state = {
  tasks: [],
  filter: "all",
  query: "",
  deferredPrompt: null,
  session: null,
  loading: true
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
    state.loading = false;
    elements.authScreen.classList.add("hidden");
    elements.appContent.classList.remove("hidden");
    updateAuthUi("当前是本地版，暂未接入云同步。");
    render();
    return;
  }

  const { data } = await supabaseClient.auth.getSession();
  state.session = data.session || null;

  supabaseClient.auth.onAuthStateChange(async (_event, session) => {
    state.session = session || null;
    await loadTasks();
    updateAuthUi();
    updateViewMode();
    render();
  });

  await loadTasks();
  updateAuthUi();
  updateViewMode();
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
    title: String(task.title),
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
    return;
  }

  if (hasCloudConfig && !state.session?.user) {
    window.alert("请先登录，再保存同步任务。");
    return;
  }

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
    completedAt: previous?.status === "completed" ? previous?.completedAt || new Date().toISOString() : ""
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
  setTimeout(resetForm, 0);
}

function handleSearch(event) {
  state.query = event.target.value.trim().toLowerCase();
  render();
}

async function sendMagicLink() {
  if (!hasCloudConfig) {
    window.alert("当前还没接入云同步。");
    return;
  }

  const email = elements.emailInput.value.trim();
  if (!email) {
    window.alert("请先输入邮箱。");
    return;
  }

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

  updateAuthUi(`登录邮件已发送到：${email}。请点击邮件里的登录链接完成登录。`);
}

async function signOut() {
  if (!hasCloudConfig) {
    return;
  }

  await supabaseClient.auth.signOut();
}

function installApp() {
  if (!state.deferredPrompt) {
    window.alert("当前浏览器暂时没有弹出安装提示，也可以用浏览器菜单选择“添加到主屏幕”。");
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
    ? `当前已登录：${state.session.user.email}`
    : "";
}

function updateViewMode() {
  const loggedIn = Boolean(state.session?.user) || !hasCloudConfig;
  elements.authScreen.classList.toggle("hidden", loggedIn);
  elements.appContent.classList.toggle("hidden", !loggedIn);

  if (loggedIn) {
    requestAnimationFrame(() => {
      elements.titleInput.focus();
    });
  }
}

function resetForm() {
  elements.taskForm.reset();
  elements.taskId.value = "";
  elements.saveButton.textContent = "保存记录";
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
}

function renderDailySummary() {
  const completedToday = state.tasks.filter((task) => (
    task.status === "completed" &&
    task.completedAt &&
    isToday(task.completedAt)
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

function isToday(value) {
  const date = new Date(value);
  const now = new Date();
  return date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
}

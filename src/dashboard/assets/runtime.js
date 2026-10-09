(() => {
  const region = document.querySelector("[data-runtime-status]");
  const title = document.querySelector("[data-runtime-title]");
  const message = document.querySelector("[data-runtime-message]");
  const actionButton = document.querySelector("[data-runtime-recover]");
  if (!region || !title || !message || !actionButton) return;

  const defaultSite = region.dataset.site || 'boss';
  const selectedSite = () => document.querySelector('[data-platform-selector]')?.value || defaultSite;
  let requestInFlight = false;
  let selectionRevision = 0;
  let queuedRefresh = false;
  let pollTimer = null;
  let actionEndpoint = "";
  let actionSite = defaultSite;

  function runtimeView(payload = {}, site = defaultSite) {
    const siteLabel = site === 'zhaopin' ? '智联' : 'BOSS';
    const browser = payload.browser;
    const workspace = payload.workspace || { status: "unchecked" };
    if (!browser) {
      return {
        state: "local",
        title: "工作台已就绪",
        message: "浏览器会在需要岗位页面时单独检查。",
        button: "",
        endpoint: ""
      };
    }
    if (!browser.ready) {
      const stopped = browser.status === "stopped";
      const recoverable = ["unavailable", "stopped"].includes(browser.status);
      const needsAttention = ["conflict", "needs_attention"].includes(browser.status);
      return {
        state: recoverable ? "attention" : "waiting",
        title: stopped
          ? "专用 Edge 已关闭"
          : recoverable
            ? "专用 Edge 暂时不可用"
            : needsAttention
              ? "专用 Edge 需要处理"
              : "正在准备专用 Edge…",
        message: String(browser.message || "工作台可继续使用，浏览器功能暂时不可用。"),
        button: recoverable ? "恢复专用 Edge" : "",
        endpoint: recoverable ? "/api/runtime/browser/recover" : ""
      };
    }
    if (workspace.status === "ready") {
      return {
        state: "ready",
        title: `专用 Edge 和${siteLabel}已就绪`,
        message: "需要浏览器的岗位操作现在可以开始。",
        button: "",
        endpoint: ""
      };
    }
    if (workspace.status === "preparing") {
      return {
        state: "waiting",
        title: "招聘平台选择已保存",
        message: "正在准备专用 Edge 页面，你可以继续填写本地资料。",
        button: "",
        endpoint: ""
      };
    }
    const loginRequired = workspace.status === "login_required";
    return {
      state: loginRequired ? "attention" : "waiting",
      title: loginRequired ? `请在专用 Edge 登录${siteLabel}` : "专用 Edge 已就绪",
      message: loginRequired
        ? "登录完成后，回到这里重新检查。"
        : String(workspace.message || `${siteLabel}工作区尚未确认；本地资料仍可正常查看。`),
      button: `重新检查${siteLabel}工作区`,
      endpoint: "/api/runtime/workspace/reconcile"
    };
  }

  function render(payload, site = defaultSite) {
    applyView(runtimeView(payload, site), site);
  }

  function applyView(view, site) {
    region.dataset.state = view.state;
    title.textContent = view.title;
    message.textContent = view.message;
    actionEndpoint = view.endpoint;
    actionSite = site;
    actionButton.textContent = view.button;
    actionButton.hidden = !view.button;
  }

  function schedulePoll() {
    if (document.hidden) return;
    pollTimer = setTimeout(poll, 5000);
  }

  async function request(url, options = {}, site = selectedSite()) {
    if (requestInFlight || document.hidden) return;
    requestInFlight = true;
    const revision = selectionRevision;
    actionButton.disabled = true;
    try {
      const targets = url ? [site] : site === 'both' ? ['boss', 'zhaopin'] : [site];
      const views = [];
      for (const target of targets) {
        const response = await fetch(url || '/api/runtime-status?site=' + encodeURIComponent(target), {
          ...options,
          headers: { accept: "application/json", ...(options.headers || {}) }
        });
        const payload = await response.json();
        if (!response.ok) throw Object.assign(
          new Error(String(payload?.error || "请求没有完成。")),
          { payload }
        );
        if (revision !== selectionRevision) return;
        views.push({ site: target, ...runtimeView(payload, target) });
      }
      if (url && selectedSite() === 'both') {
        queuedRefresh = true;
      } else if (views.length === 2 && views.every(view => view.state === 'ready')) {
        applyView({ ...views[0], title: '专用 Edge 和 BOSS、智联已就绪' }, 'boss');
      } else {
        const view = views.find(view => view.state !== 'ready') || views[0];
        applyView(view, view.site);
      }
    } catch (error) {
      if (revision !== selectionRevision) return;
      render({
        browser: {
          status: "needs_attention",
          ready: false,
          message: String(error?.payload?.error || error?.message || "暂时无法读取本地运行状态，请稍后重试。")
        },
        workspace: { status: "unchecked" }
      }, site === 'both' ? 'boss' : site);
    } finally {
      requestInFlight = false;
      actionButton.disabled = false;
      if (queuedRefresh) {
        queuedRefresh = false;
        void poll();
      } else schedulePoll();
    }
  }

  function poll() {
    pollTimer = null;
    return request(null);
  }

  actionButton.addEventListener("click", async () => {
    if (!actionEndpoint || requestInFlight) return;
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = null;
    await request(actionEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ site: actionSite })
    }, actionSite);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (pollTimer !== null) clearTimeout(pollTimer);
      pollTimer = null;
      return;
    }
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = null;
    void poll();
  });

  window.addEventListener('offergo:conditions', () => {
    selectionRevision += 1;
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = null;
    applyView({ state: 'waiting', title: '正在检查所选平台…', message: '正在确认浏览器和工作区状态。', button: '', endpoint: '' }, defaultSite);
    if (requestInFlight) queuedRefresh = true;
    else void poll();
  });

  void poll();
})();

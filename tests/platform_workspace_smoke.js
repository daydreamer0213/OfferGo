const assert = require("node:assert");
const { preparePlatformWorkspaceTabs } = require("../src/core/platform_workspace");

function browserFixture(initialTabs, created = [], { onListTabs = null } = {}) {
  const state = {
    tabs: initialTabs.map((tab) => ({ ...tab })),
    createCalls: [],
    frontCalls: [],
    closeCalls: [],
    created: created.map((tab) => ({ ...tab })),
    settlePasses: 0
  };
  return {
    state,
    async listTabs() {
      onListTabs?.(state);
      return state.tabs.map((tab) => ({ ...tab }));
    },
    async createTab(openerTabId, url) {
      state.createCalls.push({ openerTabId, url });
      const next = state.created.shift();
      if (!next) throw new Error("unexpected createTab");
      const tab = { ...next, url: next.resolvedUrl || url };
      state.tabs.push(tab);
      return tab.id;
    },
    async bringToFront(tabId) { state.frontCalls.push(tabId); },
    async closeTab(tabId) { state.closeCalls.push(tabId); }
  };
}

(async () => {
  const dashboard = { id: "dashboard", url: "http://127.0.0.1:8787/settings/platforms", windowId: 7, active: true };
  const noSelection = browserFixture([dashboard]);
  const noSelectionResult = await preparePlatformWorkspaceTabs({
    browser: noSelection,
    dashboardUrl: "http://127.0.0.1:8787/",
    enabledPlatforms: []
  });
  assert.strictEqual(noSelectionResult.status, "platform_selection_required");
  assert.deepStrictEqual(noSelection.state.createCalls, []);

  const sleeping = browserFixture([dashboard]);
  const sleepingTabs = [
    { id: "original-search", url: "https://www.zhipin.com/web/geek/jobs?city=101280100&query=AI", windowId: 7, active: false },
    { id: "original-chat", url: "https://www.zhipin.com/web/geek/chat", windowId: 7, active: false }
  ];
  sleeping.restoreDormantTabs = async ({ windowIds, matchesUrl }) => {
    assert.deepStrictEqual(windowIds, [7]);
    const recovered = sleepingTabs.filter(tab => matchesUrl(tab.url));
    sleeping.state.tabs.push(...recovered);
    return recovered.map(tab => tab.id);
  };
  const sleepingResult = await preparePlatformWorkspaceTabs({ browser: sleeping,
    dashboardUrl: dashboard.url, enabledPlatforms: ["boss"] });
  assert.equal(sleepingResult.bossTabId, "original-search");
  assert.equal(sleepingResult.communicationTabId, "original-chat");
  assert.deepStrictEqual(sleeping.state.createCalls, [], "workspace recovery must reuse dormant tabs rather than duplicate them");
  assert.deepStrictEqual(sleeping.state.frontCalls, []);

  const sleepingFiltered = browserFixture([dashboard,
    { id: "zhaopin-default-search", url: "https://www.zhaopin.com/jobs/?pageMode=search", windowId: 7, active: false },
    { id: "zhaopin-chat", url: "https://i.zhaopin.com/im", windowId: 7, active: false }
  ]);
  let filteredRestoreCalls = 0;
  sleepingFiltered.restoreDormantTabs = async ({ windowIds, matchesUrl }) => {
    assert.deepStrictEqual(windowIds, [7]);
    const original = { id: "original-filtered-search", url: "https://www.zhaopin.com/jobs/?jl=763&re=2052&kw=AI", windowId: 7, active: false };
    assert(matchesUrl(original.url));
    filteredRestoreCalls += 1;
    if (!sleepingFiltered.state.tabs.some(tab => tab.id === original.id)) sleepingFiltered.state.tabs.push(original);
    return [original.id];
  };
  await preparePlatformWorkspaceTabs({ browser: sleepingFiltered,
    dashboardUrl: dashboard.url, enabledPlatforms: ["zhaopin"] });
  assert.equal(filteredRestoreCalls, 1, "existing default pages must not hide a dormant page with user filters");
  assert(sleepingFiltered.state.tabs.some(tab => tab.url.includes("re=2052")), "saved regional conditions must remain available to normal search consolidation");
  assert.deepStrictEqual(sleepingFiltered.state.createCalls, []);
  assert.deepStrictEqual(sleepingFiltered.state.frontCalls, []);

  const both = browserFixture([
    dashboard,
    { id: "boss-search-a", url: "https://www.zhipin.com/web/geek/jobs?query=AI", windowId: 7, active: false },
    { id: "boss-search-extra", url: "https://www.zhipin.com/web/geek/jobs?query=Python", windowId: 7, active: false },
    { id: "boss-chat", url: "https://www.zhipin.com/web/geek/chat", windowId: 7, active: false },
    { id: "boss-user-detail", url: "https://www.zhipin.com/job_detail/user.html", windowId: 9, active: true },
    { id: "zhaopin-search", url: "https://www.zhaopin.com/jobs/?pageMode=search&kw=AI", windowId: 7, active: false },
    { id: "unrelated", url: "https://example.com/", windowId: 10, active: true }
  ], [
    { id: "zhaopin-message", windowId: 7, active: false }
  ]);
  const bothResult = await preparePlatformWorkspaceTabs({
    browser: both,
    dashboardUrl: "http://127.0.0.1:8787/",
    enabledPlatforms: ["zhaopin", "boss"]
  });
  assert.strictEqual(bothResult.status, "ready");
  assert.deepStrictEqual(bothResult.enabledPlatforms, ["boss", "zhaopin"]);
  assert.strictEqual(bothResult.bossTabId, "boss-search-a");
  assert.strictEqual(bothResult.communicationTabId, "boss-chat");
  assert.strictEqual(bothResult.zhaopinSearchTabId, "zhaopin-search");
  assert.strictEqual(bothResult.zhaopinMessageTabId, "zhaopin-message");
  assert.deepStrictEqual(both.state.createCalls, [{
    openerTabId: "dashboard",
    url: "https://i.zhaopin.com/im"
  }]);
  assert.deepStrictEqual(both.state.frontCalls, []);
  assert.deepStrictEqual(both.state.closeCalls, []);

  const bossOnly = browserFixture([dashboard], [
    { id: "new-boss-search", windowId: 7, active: false },
    { id: "new-boss-chat", windowId: 7, active: false }
  ]);
  const bossResult = await preparePlatformWorkspaceTabs({
    browser: bossOnly,
    dashboardUrl: dashboard.url,
    enabledPlatforms: ["boss"]
  });
  assert.strictEqual(bossResult.status, "ready");
  assert.deepStrictEqual(bossOnly.state.createCalls, [
    { openerTabId: "dashboard", url: "https://www.zhipin.com/web/geek/jobs" },
    { openerTabId: "dashboard", url: "https://www.zhipin.com/web/geek/chat" }
  ]);

  const redirected = browserFixture([dashboard], [
    { id: "boss-login-search", windowId: 7, active: false, resolvedUrl: "https://www.zhipin.com/" },
    { id: "boss-login-chat", windowId: 7, active: false, resolvedUrl: "https://www.zhipin.com/" }
  ]);
  const redirectedResult = await preparePlatformWorkspaceTabs({
    browser: redirected,
    dashboardUrl: dashboard.url,
    enabledPlatforms: ["boss"]
  });
  assert.strictEqual(redirectedResult.status, "login_required");
  const repeated = await preparePlatformWorkspaceTabs({
    browser: redirected,
    dashboardUrl: dashboard.url,
    enabledPlatforms: ["boss"],
    previousWorkspace: redirectedResult
  });
  assert.strictEqual(repeated.status, "login_required");
  assert.strictEqual(redirected.state.createCalls.length, 2, "login monitoring must not create duplicate tabs");

  const delayedRedirect = browserFixture([dashboard], [
    { id: "delayed-boss-search", windowId: 7, active: false },
    { id: "delayed-boss-chat", windowId: 7, active: false }
  ], {
    onListTabs(state) {
      if (state.settlePasses < 1) return;
      state.tabs = state.tabs.map((tab) => tab.id.startsWith("delayed-boss")
        ? { ...tab, url: "https://www.zhipin.com/web/user/" }
        : tab);
    }
  });
  const delayedRedirectResult = await preparePlatformWorkspaceTabs({
    browser: delayedRedirect,
    dashboardUrl: dashboard.url,
    enabledPlatforms: ["boss"],
    settleDelay: async () => { delayedRedirect.state.settlePasses += 1; }
  });
  assert.strictEqual(delayedRedirectResult.status, "login_required", "a delayed login redirect must not be reported as ready");
  assert.strictEqual(delayedRedirect.state.createCalls.length, 2, "settlement must not create duplicate tabs");

  const roleDrift = browserFixture([
    dashboard,
    { id: "drifted-search", windowId: 7, active: false, url: "https://www.zhipin.com/web/geek/chat" },
    { id: "fixed-message", windowId: 7, active: false, url: "https://www.zhipin.com/web/geek/chat" }
  ], [
    { id: "replacement-search", windowId: 7, active: false }
  ]);
  const recoveredRole = await preparePlatformWorkspaceTabs({
    browser: roleDrift,
    dashboardUrl: dashboard.url,
    enabledPlatforms: ["boss"],
    previousWorkspace: {
      dashboardTabId: dashboard.id,
      platforms: {
        boss: { searchTabId: "drifted-search", messageTabId: "fixed-message" }
      }
    }
  });
  assert.strictEqual(recoveredRole.status, "ready");
  assert.strictEqual(recoveredRole.bossTabId, "replacement-search");
  assert.deepStrictEqual(roleDrift.state.createCalls, [{
    openerTabId: "dashboard",
    url: "https://www.zhipin.com/web/geek/jobs"
  }], "a bound tab that changed roles must be replaced without touching extra tabs");

  console.log("platform_workspace_smoke ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

const BOSS_PAGE_STATE_EXPRESSION = `(() => {
  const url = location.href;
  const path = location.pathname;
  const bodyText = String(document.body?.innerText || "").replace(/\\s+/g, " ").slice(0, 3000);
  const isBoss = /(^|\\.)zhipin\\.com$/i.test(location.hostname);
  const hasVisibleLoginForm = [...document.querySelectorAll(".sign-form, .login-register, [class*='login-form']")].some((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  });
  const isLoginPage = /\\/web\\/user\\//i.test(path) || hasVisibleLoginForm
    || /没有更多职位.{0,20}登录查看全部职位|登录后可查看/.test(bodyText);
  const isRiskPage = /\\/web\\/passport\\/zp\\/(?:verify|403)/i.test(path)
    || new URLSearchParams(location.search).get("code") === "32"
    || /安全验证|访问异常|行为验证|访问受限/.test(document.title || "")
    || /账户存在异常行为|暂时无法访问此页面|请勿频繁提交刷新请求/.test(bodyText);
  const hasUserSurface = Boolean(document.querySelector(".nav-figure, .user-nav, [ka='header-personal'], [ka='header-username'], [class*='user-nav']"));
  const hasJobStructure = Boolean(document.querySelector(".job-list-container, .rec-job-list, .job-card-box, .job-detail-container"));
  const isSearchPage = /\\/web\\/geek\\/jobs/i.test(path);
  return {
    url,
    path,
    title: document.title || "",
    isBoss,
    isLoginPage,
    isRiskPage,
    hasUserSurface,
    loggedIn: isBoss && !isLoginPage && !isRiskPage && (hasUserSurface || hasJobStructure),
    isSearchPage,
    hasJobStructure
  };
})()`;

async function inspectBossPageState(browser, tabId) {
  if (!browser || typeof browser.evalValue !== "function") {
    throw Object.assign(new Error("BOSS page inspection requires browser DOM evaluation"), { code: "BOSS_PAGE_STATE_UNAVAILABLE" });
  }
  return normalizeBossPageState(await browser.evalValue(tabId, BOSS_PAGE_STATE_EXPRESSION));
}

async function inspectBossSessionState(browser, tabs = []) {
  const states = [];
  const errors = [];
  for (const tab of tabs.filter(isBossTab)) {
    try {
      states.push({ tabId: tab.id, tab, ...await inspectBossPageState(browser, tab.id) });
    } catch (error) {
      errors.push({ tabId: tab.id, tab, error });
    }
  }
  const riskControl = states.some((state) => state.state === "risk_control");
  const healthyTabIds = states.filter((state) => state.state === "ready").map((state) => state.tabId);
  return {
    states,
    errors,
    riskControl,
    hasRiskPage: riskControl,
    loginRequired: !riskControl && states.some((state) => state.state === "login_required") && !healthyTabIds.length,
    healthyTabIds
  };
}

function normalizeBossPageState(value) {
  if (!value || typeof value !== "object"
    || typeof value.url !== "string"
    || typeof value.isBoss !== "boolean"
    || typeof value.isLoginPage !== "boolean"
    || typeof value.isRiskPage !== "boolean"
    || typeof value.hasUserSurface !== "boolean"
    || typeof value.hasJobStructure !== "boolean") {
    throw Object.assign(new Error("BOSS page state probe returned an invalid result"), { code: "BOSS_PAGE_STATE_INVALID" });
  }
  const state = value.isRiskPage
    ? "risk_control"
    : value.isLoginPage
      ? "login_required"
      : value.isBoss && (value.hasUserSurface || value.hasJobStructure)
        ? "ready"
        : "unavailable";
  return {
    ...value,
    path: typeof value.path === "string" ? value.path : safePath(value.url),
    state,
    loggedIn: state === "ready",
    isSearchPage: typeof value.isSearchPage === "boolean" ? value.isSearchPage : /\/web\/geek\/jobs/i.test(safePath(value.url))
  };
}

function safePath(value) {
  try { return new URL(value).pathname; } catch { return ""; }
}

function isBossTab(tab) {
  try {
    return /(^|\.)zhipin\.com$/i.test(new URL(String(tab?.url || "")).hostname);
  } catch {
    return false;
  }
}

module.exports = { BOSS_PAGE_STATE_EXPRESSION, normalizeBossPageState, inspectBossPageState, inspectBossSessionState };

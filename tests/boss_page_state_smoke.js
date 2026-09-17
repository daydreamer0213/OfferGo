const assert = require("node:assert/strict");
const {
  BOSS_PAGE_STATE_EXPRESSION,
  normalizeBossPageState,
  inspectBossPageState,
  inspectBossSessionState
} = require("../src/adapters/sites/boss_page_state");

async function main() {
  const stale = normalizeBossPageState({
    url: "https://www.zhipin.com/web/geek/jobs?_security_check=stale",
    path: "/web/geek/jobs",
    isBoss: true,
    isLoginPage: false,
    isRiskPage: false,
    hasUserSurface: true,
    hasJobStructure: true
  });
  assert.equal(stale.state, "ready");
  assert.equal(stale.loggedIn, true);

  const risk = normalizeBossPageState({
    url: "https://www.zhipin.com/web/passport/zp/verify",
    path: "/web/passport/zp/verify",
    isBoss: true,
    isLoginPage: false,
    isRiskPage: true,
    hasUserSurface: false,
    hasJobStructure: false
  });
  assert.equal(risk.state, "risk_control");
  assert.throws(() => normalizeBossPageState({ url: "https://www.zhipin.com" }), error => error.code === "BOSS_PAGE_STATE_INVALID");

  const probes = new Map([[1, stale], [2, risk]]);
  const browser = { evalValue: async (tabId, expression) => {
    assert.equal(expression, BOSS_PAGE_STATE_EXPRESSION);
    return probes.get(tabId);
  } };
  assert.equal((await inspectBossPageState(browser, 1)).state, "ready");
  const session = await inspectBossSessionState(browser, [
    { id: 1, url: stale.url },
    { id: 2, url: risk.url },
    { id: 3, url: "https://i.zhaopin.com/im" }
  ]);
  assert.equal(session.riskControl, true);
  assert.deepEqual(session.healthyTabIds, [1]);
  assert.equal(session.states.length, 2);
}

main().then(() => console.log("boss_page_state_smoke passed")).catch(error => {
  console.error(error.stack);
  process.exitCode = 1;
});

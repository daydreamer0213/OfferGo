const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDb, saveProfileAnalysis } = require("../src/core/storage");
const { createDashboardServer } = require("../src/dashboard/server");

const logger = {
  info() {}, warn() {}, error() {},
  requestId() { return "dashboard-model-runtime-cache-smoke"; },
  listRecent() { return []; }
};

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "offergo-dashboard-model-cache-"));
  const db = openDb(":memory:");
  const owner = saveProfileAnalysis(db, {
    profile: {
      candidate: { name: "缓存测试候选人", city: "广州", targetTitles: ["AI 应用工程师"] },
      skills: [{ name: "Node.js" }],
      projects: [{ name: "知识库" }]
    },
    document: {
      originalFileName: "resume.txt",
      format: "text",
      contentHash: "dashboard-model-runtime-cache",
      text: "参与知识库开发",
      diagnostics: {}
    },
    searchPlan: {
      name: "缓存测试方案",
      cities: ["广州"],
      directions: ["AI 应用工程师"],
      keywords: [{ word: "知识库", priority: "A" }]
    }
  });
  let resolveCalls = 0;
  const server = createDashboardServer({
    db,
    root,
    dataRoot: root,
    logger,
    allowOfflineMock: true,
    browserAuthority: { browserMode: "edge", cdpPort: null, profilePath: "" },
    runtimeModelResolver() {
      resolveCalls += 1;
      return {
        modelConfig: { provider: "mock", providers: { mock: { model: "offline-structured-mock" } } },
        connectionStatus: "verified",
        keyConfigured: true,
        keyReadable: true
      };
    },
    modelReadinessChecker: () => true
  });
  const baseUrl = await listen(server);

  try {
    for (const route of [
      `/resume-optimization?planId=${owner.planId}`,
      `/resume-optimization?planId=${owner.planId}`,
      `/interview?planId=${owner.planId}`,
      `/interview?planId=${owner.planId}`
    ]) {
      const response = await fetch(baseUrl + route);
      assert.equal(response.status, 200, `${route} must render`);
      await response.text();
    }
    assert.equal(resolveCalls, 1, "repeated deep-analysis pages must reuse one decrypted runtime state");

    const saved = await fetch(baseUrl + "/api/settings/model", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        taskProfile: "deep_analysis",
        action: "save_parameters",
        preset: "deepseek",
        model: "deepseek-v4-pro",
        timeoutMs: "30000",
        thinkingMode: "disabled",
        reasoningEffort: "high",
        concurrency: "1",
        credentialMode: "shared"
      }),
      redirect: "manual"
    });
    assert.equal(saved.status, 303, await saved.text());

    const refreshed = await fetch(baseUrl + `/resume-optimization?planId=${owner.planId}`);
    assert.equal(refreshed.status, 200);
    await refreshed.text();
    assert.equal(resolveCalls, 2, "a successful settings save must invalidate the cached runtime state");

    console.log("dashboard_model_runtime_cache_smoke ok");
  } finally {
    await close(server);
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const { MockModelAdapter } = require("../src/adapters/models/mock");
const { openDb, getCandidateMatchingContext, getCandidateProfile, getSearchPlan } = require("../src/core/storage");

const root = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "offergo-agent-headless-"));
const resumePath = path.join(temp, "resume.txt");
fs.writeFileSync(resumePath, [
  "姓名：测试候选人",
  "求职意向：AI 应用开发工程师",
  "项目经历：使用 Python、FastAPI 和 RAG 构建知识检索服务。",
  "专业技能：Python、FastAPI、RAG、SQLite。"
].join("\n"));

async function runAgentOnboard(operationId, { refreshProfile = false } = {}) {
  const argv = [
    "--disable-warning=ExperimentalWarning",
    "src/cli.js",
    "agent-onboard",
    "--resume", resumePath,
    "--operation-id", operationId,
    "--agent",
    "--data-root", temp
  ];
  if (refreshProfile) argv.push("--refresh-profile");
  const child = spawn(process.execPath, argv, { cwd: root, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const mock = new MockModelAdapter();
  const requests = [];
  let completion = null;
  let stderr = "";
  let buffered = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  child.stdout.on("data", (chunk) => {
    buffered += chunk.toString("utf8");
    let newline;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (!line.startsWith("{")) continue;
      const message = JSON.parse(line);
      if (message.type === "model_request") {
        requests.push(message.task);
        Promise.resolve(mock[message.task](message.input)).then((result) => {
          child.stdin.write(`${JSON.stringify({
            protocol: message.protocol,
            version: message.version,
            type: "model_response",
            id: message.id,
            result
          })}\n`);
        });
      } else if (message.type === "command_result") {
        completion = message;
      }
    }
  });

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.strictEqual(exitCode, 0, stderr);
  assert.strictEqual(completion?.command, "agent-onboard");
  assert.strictEqual(completion.result.operationId, operationId);
  return { requests, completion };
}

(async () => {
  const firstOperationId = "00000000-0000-4000-8000-000000000001";
  const secondOperationId = "00000000-0000-4000-8000-000000000002";
  const refreshOperationId = "00000000-0000-4000-8000-000000000003";
  const first = await runAgentOnboard(firstOperationId);
  assert.deepStrictEqual(first.requests, ["analyzeResume", "buildCandidateMatchCard", "recommendSearchPlan"]);
  assert(first.completion.result.profileId > 0);
  assert(first.completion.result.matchingCardId > 0);
  assert(first.completion.result.searchPlanId > 0);

  const db = openDb(path.join(temp, "data", "jobs.sqlite"));
  try {
    assert(getCandidateProfile(db, first.completion.result.profileId));
    assert(getSearchPlan(db, first.completion.result.searchPlanId));
  } finally {
    db.close();
  }

  const repeated = await runAgentOnboard(firstOperationId);
  assert.deepStrictEqual(repeated.requests, [], "same operation id must reuse the completed result");
  assert.strictEqual(repeated.completion.result.profileId, first.completion.result.profileId);
  assert.strictEqual(repeated.completion.result.matchingCardId, first.completion.result.matchingCardId);
  assert.strictEqual(repeated.completion.result.searchPlanId, first.completion.result.searchPlanId);

  const otherResumePath = path.join(temp, "other-resume.txt");
  fs.writeFileSync(otherResumePath, [
    "姓名：另一位候选人",
    "求职意向：产品经理",
    "项目经历：负责企业协作产品的需求分析、用户访谈、方案设计、迭代排期和上线复盘。",
    "专业技能：产品规划、数据分析、原型设计、跨团队沟通、用户研究和项目管理。"
  ].join("\n"));
  const conflicting = spawnSync(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    "src/cli.js",
    "agent-onboard",
    "--resume", otherResumePath,
    "--operation-id", firstOperationId,
    "--agent",
    "--data-root", temp
  ], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 2000 });
  assert.notStrictEqual(conflicting.status, 0);
  assert.match(conflicting.stderr, /已用于另一份简历/);

  const second = await runAgentOnboard(secondOperationId);
  assert.deepStrictEqual(second.requests, [], "unchanged resume must reuse its prepared profile and plan");
  assert.strictEqual(second.completion.result.runId, first.completion.result.runId);
  assert.strictEqual(second.completion.result.reused, true);
  assert.strictEqual(second.completion.result.profileId, first.completion.result.profileId);
  assert.strictEqual(second.completion.result.matchingCardId, first.completion.result.matchingCardId);
  assert.strictEqual(second.completion.result.searchPlanId, first.completion.result.searchPlanId);

  const confirmation = spawnSync(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    "src/cli.js",
    "agent-confirm",
    "--profile", String(second.completion.result.profileId),
    "--card", String(second.completion.result.matchingCardId),
    "--agent",
    "--data-root", temp
  ], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 2000 });
  assert.strictEqual(confirmation.status, 0, confirmation.stderr || confirmation.error?.message);
  const confirmedDb = openDb(path.join(temp, "data", "jobs.sqlite"));
  try {
    assert.strictEqual(
      getCandidateMatchingContext(confirmedDb, second.completion.result.profileId)?.matchingCardId,
      second.completion.result.matchingCardId
    );
  } finally {
    confirmedDb.close();
  }

  const refreshed = await runAgentOnboard(refreshOperationId, { refreshProfile: true });
  assert.deepStrictEqual(refreshed.requests, ["analyzeResume", "buildCandidateMatchCard", "recommendSearchPlan"]);
  assert.strictEqual(refreshed.completion.result.reused, false);
  assert.notStrictEqual(refreshed.completion.result.profileId, first.completion.result.profileId);
  console.log("agent headless cli smoke passed");
})().finally(() => {
  fs.rmSync(temp, { recursive: true, force: true });
}).catch((error) => {
  console.error(error);
  process.exit(1);
});

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDb } = require("../src/core/storage");
const { parseResumeText } = require("../src/core/resume_parser");
const {
  runAgentOnboarding,
  confirmAgentMatchingCard
} = require("../src/application/onboarding/agent_onboarding");
const { requireAgentOperationId } = require("../src/commands/agent_onboarding");
const { createOnboardingRun } = require("../src/storage/onboarding_store");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "offergo-agent-onboarding-service-"));
const db = openDb(path.join(root, "jobs.sqlite"));

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function main() {
  const firstOperationId = "11111111-1111-4111-8111-111111111111";
  const reusedOperationId = "22222222-2222-4222-8222-222222222222";
  const refreshOperationId = "33333333-3333-4333-8333-333333333333";
  const runningOperationId = "44444444-4444-4444-8444-444444444444";
  const failedOperationId = "55555555-5555-4555-8555-555555555555";
  const resume = parseResumeText({
    fileName: "candidate.txt",
    text: [
      "姓名：测试候选人",
      "求职意向：AI 应用开发工程师",
      "项目经历：负责 RAG 知识库接口开发。",
      "专业技能：Node.js、Python、SQLite。",
      "工作经历：参与需求分析、接口联调、自动化测试和线上问题排查，能够独立完成小型功能交付。"
    ].join("\n")
  });
  const differentResume = parseResumeText({
    fileName: "other.txt",
    text: `${resume.text}\n补充经历：负责检索质量评估。`
  });

  assert.strictEqual(requireAgentOperationId(firstOperationId), firstOperationId);
  assert.throws(
    () => requireAgentOperationId("not-a-uuid"),
    (error) => error.code === "AGENT_OPERATION_ID_REQUIRED"
  );

  let stdoutWrites = 0;
  const originalWrite = process.stdout.write;
  process.stdout.write = function interceptedWrite() {
    stdoutWrites += 1;
    return true;
  };
  let first;
  try {
    first = await runAgentOnboarding({
      db,
      operationId: firstOperationId,
      document: resume,
      displayName: "测试候选人",
      modelConfig: {},
      logger: quietLogger(),
      runtimeDependencies: successfulRuntime()
    });
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.strictEqual(stdoutWrites, 0, "application service must not write terminal output");
  assert.strictEqual(first.operationId, firstOperationId);
  assert.strictEqual(first.runId, firstOperationId);
  assert.strictEqual(first.reused, false);
  assert.strictEqual(first.run.status, "completed");
  assert.strictEqual(first.profile.id, first.profileId);
  assert.strictEqual(first.matchingCard.id, first.matchingCardId);
  assert.strictEqual(first.searchPlan.id, first.searchPlanId);

  const sameOperation = await runAgentOnboarding({
    db,
    operationId: firstOperationId,
    document: resume,
    displayName: "测试候选人",
    modelConfig: {},
    logger: quietLogger(),
    runtimeDependencies: failingRuntime("completed operation must not rerun")
  });
  assert.strictEqual(sameOperation.runId, first.runId);
  assert.strictEqual(sameOperation.reused, false);

  await assert.rejects(
    runAgentOnboarding({
      db,
      operationId: firstOperationId,
      document: differentResume,
      displayName: "测试候选人",
      modelConfig: {},
      logger: quietLogger(),
      runtimeDependencies: successfulRuntime()
    }),
    (error) => error.code === "AGENT_OPERATION_ID_CONFLICT"
  );

  const reused = await runAgentOnboarding({
    db,
    operationId: reusedOperationId,
    document: resume,
    displayName: "测试候选人",
    modelConfig: {},
    logger: quietLogger(),
    runtimeDependencies: failingRuntime("unchanged resume must reuse prior analysis")
  });
  assert.strictEqual(reused.operationId, reusedOperationId);
  assert.strictEqual(reused.runId, first.runId);
  assert.strictEqual(reused.reused, true);
  assert.strictEqual(reused.profileId, first.profileId);
  assert.strictEqual(reused.matchingCardId, first.matchingCardId);
  assert.strictEqual(reused.searchPlanId, first.searchPlanId);

  const refreshed = await runAgentOnboarding({
    db,
    operationId: refreshOperationId,
    document: resume,
    displayName: "测试候选人",
    refreshProfile: true,
    modelConfig: {},
    logger: quietLogger(),
    runtimeDependencies: successfulRuntime()
  });
  assert.strictEqual(refreshed.runId, refreshOperationId);
  assert.strictEqual(refreshed.reused, false);
  assert.notStrictEqual(refreshed.profileId, first.profileId);

  createOnboardingRun(db, {
    displayName: "测试候选人",
    document: differentResume,
    operationId: runningOperationId
  });
  db.prepare("UPDATE onboarding_runs SET status = 'running' WHERE id = ?")
    .run(runningOperationId);
  await assert.rejects(
    runAgentOnboarding({
      db,
      operationId: runningOperationId,
      document: differentResume,
      displayName: "测试候选人",
      modelConfig: {},
      logger: quietLogger(),
      runtimeDependencies: successfulRuntime()
    }),
    (error) => error.code === "AGENT_ONBOARDING_ALREADY_RUNNING"
  );

  const failedResume = parseResumeText({
    fileName: "failed.txt",
    text: `${resume.text}\n失败恢复样本：${failedOperationId}`
  });
  await assert.rejects(
    runAgentOnboarding({
      db,
      operationId: failedOperationId,
      document: failedResume,
      displayName: "测试候选人",
      modelConfig: {},
      logger: quietLogger(),
      runtimeDependencies: failingRuntime("temporary analyzer failure")
    }),
    (error) => error.code === "ONBOARDING_RUN_FAILED"
  );
  const recovered = await runAgentOnboarding({
    db,
    operationId: failedOperationId,
    document: failedResume,
    displayName: "测试候选人",
    modelConfig: {},
    logger: quietLogger(),
    runtimeDependencies: successfulRuntime()
  });
  assert.strictEqual(recovered.runId, failedOperationId);
  assert.strictEqual(recovered.run.status, "completed");

  const confirmed = confirmAgentMatchingCard({
    db,
    profileId: first.profileId,
    cardId: first.matchingCardId
  });
  assert.deepStrictEqual(confirmed, {
    profileId: first.profileId,
    matchingCardId: first.matchingCardId,
    status: "confirmed"
  });
  assert.throws(
    () => confirmAgentMatchingCard({
      db,
      profileId: refreshed.profileId,
      cardId: first.matchingCardId
    }),
    (error) => error.code === "MATCHING_CARD_NOT_FOUND"
  );

  console.log("agent_onboarding_service_smoke ok");
}

function successfulRuntime() {
  return {
    analyzeResume: async () => ({
      candidate: {
        name: "候选人",
        city: "广州",
        targetTitles: ["AI 应用开发工程师"],
        expectedSalary: "10-18K"
      },
      education: [],
      experiences: [],
      skills: [{ name: "Node.js", level: "resume", evidence: ["RAG 知识库"] }],
      projects: [],
      credentials: [],
      strengths: [],
      resumeVersions: [],
      riskMessaging: {},
      source: {}
    }),
    buildMatchingCard: async () => ({
      targetDirections: ["AI 应用开发工程师"],
      strongEvidence: [{ label: "Node.js", evidence: "简历：负责接口开发" }],
      transferableCapabilities: [],
      cautionTransitions: []
    }),
    recommendPlan: async () => ({
      name: "Agent 筛选方案",
      cities: ["广州"],
      salary: { minK: 10, maxK: 18 },
      experience: ["经验不限"],
      allowExperienceStretch: true,
      bossActiveDays: 3,
      directions: ["AI 应用开发工程师"],
      keywords: [{ word: "AI 应用开发", priority: "A", reason: "目标岗位" }],
      excludeWords: [],
      hardExcludes: []
    })
  };
}

function failingRuntime(message) {
  return {
    analyzeResume: async () => {
      throw Object.assign(new Error(message), { code: "ONBOARDING_RUN_FAILED" });
    },
    buildMatchingCard: async () => {
      throw new Error(message);
    },
    recommendPlan: async () => {
      throw new Error(message);
    }
  };
}

function quietLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    child() { return this; }
  };
}

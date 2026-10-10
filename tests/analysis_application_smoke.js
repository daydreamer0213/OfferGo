const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const runtimeWarnings = [];
process.on("warning", (warning) => runtimeWarnings.push(warning));
const {
  openDb,
  saveProfileAnalysis,
  createMatchingCardDraft,
  confirmMatchingCard,
  createBatch,
  upsertJob,
  listDecisionPool,
  listReportJobs,
  markCandidateJob,
  archiveCandidateJob,
  createWorkflowRun,
  getWorkflowRun,
  isJobAwaitingAction
} = require("../src/core/storage");
const { matchingCardFromProfile } = require("../src/core/matching_card");
const { listWorkflowInventory, reconcilePlanWorkflowInventory } = require("../src/core/workflow_inventory");
const { PRODUCT_POLICY } = require("../src/core/product_policy");
const {
  retryOneJobAnalysis,
  retryPendingJobAnalyses
} = require("../src/application/analysis");
const { createDashboardServer } = require("../src/dashboard/server");

const root = path.resolve(__dirname, "..");
const tempDir = path.join(root, ".runtime", `analysis-application-${process.pid}-${Date.now()}`);
const dbPath = path.join(tempDir, "jobs.sqlite");
const db = openDb(dbPath);
const logger = { info() {}, warn() {}, error() {} };
let server;

(async () => {
  try {
    await testPausedInventoryRecovery();
    await testDashboardContract();
    await testApplicationBoundary();
    await testUnresolvedMatchCanActuallyRetry();
    await testBulkRecoveryStopsOnQuotaFailure();
    await testUnavailableResumeStopsRecoveryBeforeModel();
    await testRecoveryPreservesInFlightSuccess();
    await testProductionRecoveryStopsOnHttpConfigurationFailure();
    assert(!runtimeWarnings.some((warning) => /circular dependency/i.test(warning.message)), "analysis inventory core ownership must not introduce a circular dependency");
    console.log("analysis_application_smoke ok");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

async function testUnresolvedMatchCanActuallyRetry() {
  const cacheDb = openDb(':memory:');
  try {
    const duties = ['整理客户订单信息并更新记录', '核对客户信息并交接异常订单'];
    const configs = require('../src/config').loadConfigs(root);
    configs.model = { provider: 'fixture', model: 'pending-retry' };
    configs.semanticMatchingMode = 'split';
    configs.candidateProfile = { projects: [{ name: '订单记录', canSay: duties }] };
    let understands = 0, matches = 0;
    const analyze = require('../src/core/job_analysis').createJobAnalysisRunner(configs, [], { db: cacheDb, analyzer: {
      async understandJob() {
        understands++;
        return { industryContext: '客户服务', hiringTracks: [{ id: 'T1', label: '订单记录', roleSummary: duties[0],
          responsibilityEvidence: duties.map(value => `JD：${value}`) }], requirements: [
          { label: '订单记录', trackIds: ['T1'], foundation: true, central: true, indispensable: false, evidence: `JD：${duties[0]}` }
        ], eligibility: [], riskSignals: [] };
      },
      async matchJob() {
        matches++;
        return matches === 1 ? { selectedTrackId: 'T1', roleAlignment: 'insufficient_evidence', roleResumeEvidence: [], roleGaps: ['订单核对职责尚无可判断的经历证据'],
          responsibilityMatches: [], matches: [], eligibility: [] } : {
          selectedTrackId: 'T1', roleAlignment: 'aligned', roleResumeEvidence: [`简历：${duties[0]}`], roleGaps: [],
          responsibilityMatches: duties.map((value,index) => ({ id: 'D'+(index+1), state: 'matched', resumeEvidence: `简历：${value}` })),
          matches: [{ id: 'R1', state: 'matched', resumeEvidence: `简历：${duties[0]}` }], eligibility: []
        };
      }
    } });
    const job = { source: 'boss', sourceId: 'pending-retry', title: '订单记录', location: '广州',
      description: duties.join('。').repeat(8), qualityTags: [] };
    assert.equal((await analyze(job)).decisionStatus, 'needs_retry');
    const retried = await analyze(job);
    assert.equal(retried.decisionStatus, 'decided', '明确重评必须重新执行未完成的匹配，不能永久返回缓存里的待分析结果');
    assert.equal(retried.recommendation, 'primary');
    assert.equal(understands, 1, '有效JD理解继续复用');
    assert.equal(matches, 2, '只重新执行未完成匹配');
    assert.equal((await analyze(job)).recommendation, 'primary');
    assert.equal(matches, 2, '成功匹配仍继续缓存复用');
  } finally { cacheDb.close(); }
}

async function testApplicationBoundary() {
  const legacy = seedPlan("legacy-resume-evidence");
  const legacyProfile = JSON.parse(db.prepare("SELECT profile_json FROM profile_versions WHERE id = ?").get(legacy.profileVersionId).profile_json);
  legacyProfile.candidate.name = "李明";
  db.prepare("UPDATE profile_versions SET profile_json = ? WHERE id = ?").run(JSON.stringify(legacyProfile), legacy.profileVersionId);
  db.prepare("UPDATE resume_documents SET resume_text = ? WHERE id = ?")
    .run("姓名：李明\n联系方式：13800000001｜liming@example.invalid\n不了解云平台部署，没有软件系统开发工作经历。", legacy.resumeDocumentId);
  const legacyJobId = seedFailedJob(legacy, "legacy-evidence-complete");
  const legacyRunner = controlledRunner({ delayMs: 0 });
  await retryOneJobAnalysis({ db, input: { planId: legacy.planId, jobId: legacyJobId }, deps: applicationDeps(legacyRunner) });
  const legacyRuntime = legacyRunner.configs[0];
  assert.match(legacyRuntime.candidateProfile.source.resumeEvidenceText, /不了解云平台部署/,
    "analysis must recover bound legacy source before preparing the runner");
  assert(!/李明|13800000001|liming@example\.invalid/.test(legacyRuntime.candidateProfile.source.resumeEvidenceText));
  assert.notStrictEqual(legacyRuntime.analysisContext.profileVersion,
    require("../src/core/analysis_revision").runtimeAnalysisContext(legacyProfile, legacyRuntime.searchPlan, legacyRuntime.candidateMatchCard).profileVersion,
    "cache identity must include recovered evidence before model execution");

  const single = seedPlan("single");
  const singleJobId = seedFailedJob(single, "single-complete");
  const workflow = createWorkflowRun(db, {
    id: "analysis-retry-inventory",
    profileId: single.profileId,
    planId: single.planId,
    localDay: chinaLocalDay(),
    sequence: 1,
    inventoryCount: 999
  });
  db.prepare("UPDATE workflow_runs SET status = 'review_required' WHERE id = ?").run(workflow.id);
  assert.strictEqual(reconcilePlanWorkflowInventory(db, single.planId), listWorkflowInventory(db, { planId: single.planId }).length);
  const singleRunner = controlledRunner();
  const one = await retryOneJobAnalysis({
    db,
    input: { planId: single.planId, jobId: singleJobId },
    deps: applicationDeps(singleRunner)
  });
  assert.deepStrictEqual(Object.keys(one).sort(), ["batchId", "completed", "concurrency", "failed", "jobIds", "kind", "planId", "requested", "results", "sourcePending"]);
  assert.strictEqual(one.kind, "one");
  assert.strictEqual(one.concurrency, 1);
  assert.strictEqual(one.completed, 1);
  assert.deepStrictEqual(one.jobIds, [singleJobId]);
  assert.strictEqual(singleRunner.peak, 1, "single retry must not run concurrent analyses");
  assert.strictEqual(batch(db, one.batchId).keyword, "analysis-retry");
  assert.deepStrictEqual(batch(db, one.batchId).filterSnapshot.jobIds, [singleJobId]);
  const retriedSingle = job(db, single.planId, singleJobId);
  assert.strictEqual(retriedSingle.analysis.semanticStatus, "complete");
  assert.deepStrictEqual(retriedSingle.analysis.analysisRevision, { fixture: "single-complete", version: "analysis-retry-smoke" });
  assert.strictEqual(getWorkflowRun(db, workflow.id).inventoryCount, listWorkflowInventory(db, { planId: single.planId }).length);

  const messageContext = seedPlan("message-context");
  const messageJobId = seedFailedJob(messageContext, "message-context-complete");
  const messageRawDescription = "Message discovery detail must remain attached to the exact analyzed observation, including responsibilities, requirements, delivery boundaries, and production quality evidence. ".repeat(2).trim();
  const messageRawBatchId = createBatch(db, "boss", "message-discovery-detail", "message discovery raw detail", {
    profileId: messageContext.profileId,
    searchPlanId: messageContext.planId,
    filterSnapshot: { mode: "message-discovery-detail", sourceId: "message-context-complete" }
  });
  const messageRawJob = job(db, messageContext.planId, messageJobId);
  upsertJob(db, {
    ...messageRawJob,
    description: messageRawDescription,
    analysis: {
      provider: "message-discovery-detail",
      semanticStatus: "pending",
      decisionSource: "analysis_pending",
      recommendation: null
    }
  }, messageRawBatchId);
  const messageRetry = await retryOneJobAnalysis({
    db,
    input: { planId: messageContext.planId, jobId: messageJobId },
    deps: applicationDeps(controlledRunner({ delayMs: 0 }))
  });
  const messageAnalysisObservation = db.prepare(`SELECT description, analysis_json
    FROM job_observations WHERE batch_id = ? AND job_id = ?`).get(messageRetry.batchId, messageJobId);
  assert.strictEqual(messageAnalysisObservation.description, messageRawDescription);
  assert.strictEqual(JSON.parse(messageAnalysisObservation.analysis_json).semanticStatus, "complete");

  const blockedMessageContext = seedPlan("message-context-blocked");
  const blockedMessageJobId = seedFailedJob(blockedMessageContext, "message-context-inactive", {
    bossActiveText: "近半年活跃",
    bossActiveDays: 180
  });
  const blockedMessageRunner = controlledRunner({ delayMs: 0 });
  const blockedMessageRetry = await retryOneJobAnalysis({
    db,
    input: { planId: blockedMessageContext.planId, jobId: blockedMessageJobId },
    deps: applicationDeps(blockedMessageRunner, { messageContextAnalysis: true })
  });
  assert.strictEqual(blockedMessageRetry.completed, 1);
  assert.strictEqual(blockedMessageRetry.sourcePending, 0);
  assert.deepStrictEqual(blockedMessageRunner.calls, ["message-context-inactive"]);
  assert.strictEqual(job(db, blockedMessageContext.planId, blockedMessageJobId).analysis.semanticStatus, "complete");

  const signalContext = seedPlan("message-context-signal");
  const signalJobId = seedFailedJob(signalContext, "message-context-signal-complete");
  const signalRunner = controlledRunner({ delayMs: 0 });
  const signalController = new AbortController();
  await retryOneJobAnalysis({
    db,
    input: { planId: signalContext.planId, jobId: signalJobId },
    deps: applicationDeps(signalRunner, {
      messageContextAnalysis: true,
      signal: signalController.signal
    })
  });
  assert.strictEqual(signalRunner.signals[0], signalController.signal);

  const mixed = seedPlan("mixed");
  const completeId = seedFailedJob(mixed, "bulk-complete");
  const partialId = seedFailedJob(mixed, "bulk-partial");
  const failedId = seedFailedJob(mixed, "bulk-failed");
  const sourcePendingId = seedFailedJob(mixed, "bulk-source-pending", { location: "Beijing" });
  const ignoredId = seedFailedJob(mixed, "bulk-applied");
  markCandidateJob(db, { profileId: mixed.profileId, planId: mixed.planId, jobId: ignoredId, status: "applied", reasonCode: "test" });
  const expectedMixed = pendingIds(mixed.planId);
  assert(expectedMixed.includes(sourcePendingId));
  assert(!expectedMixed.includes(ignoredId));
  const mixedRunner = controlledRunner();
  const bulk = await retryPendingJobAnalyses({
    db,
    input: { planId: mixed.planId },
    deps: applicationDeps(mixedRunner)
  });
  assert.strictEqual(bulk.kind, "bulk");
  assert.deepStrictEqual(bulk.jobIds, expectedMixed);
  assert.strictEqual(bulk.requested, 4);
  assert.strictEqual(bulk.completed, 2);
  assert.strictEqual(bulk.failed, 1);
  assert.strictEqual(bulk.sourcePending, 1);
  assert.strictEqual(bulk.concurrency, PRODUCT_POLICY.operations.modelAnalysis.retryConcurrency);
  assert.strictEqual(mixedRunner.peak, PRODUCT_POLICY.operations.modelAnalysis.retryConcurrency, "bulk must use the configured retry concurrency");
  assert(!mixedRunner.calls.includes("bulk-source-pending"), "source-pending jobs must not invoke the analyzer seam");
  assert(!pendingIds(mixed.planId).includes(sourcePendingId),
    "a newly detected local blocker must leave the analysis retry queue instead of retrying forever");
  assert.strictEqual(job(db, mixed.planId, sourcePendingId).decisionBucket, "not_recommended");
  assert.strictEqual(job(db, mixed.planId, completeId).analysis.semanticStatus, "complete");
  assert.strictEqual(job(db, mixed.planId, partialId).analysis.semanticStatus, "partial");
  assert.strictEqual(job(db, mixed.planId, failedId).analysis.errorCode, "MODEL_TIMEOUT");
  assert.deepStrictEqual(job(db, mixed.planId, partialId).analysis.analysisRevision, { fixture: "bulk-partial", version: "analysis-retry-smoke" });
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS count FROM job_observations WHERE batch_id = ? AND job_id = ?").get(bulk.batchId, sourcePendingId).count, 1);
  const scoped = seedPlan("scoped-retry");
  const visibleId = seedFailedJob(scoped, "scoped-boss-complete");
  const outsideId = seedFailedJob(scoped, "scoped-zhaopin-complete", { source: "zhaopin", url: "https://www.zhaopin.com/jobdetail/scoped.html" });
  const scopedRunner = controlledRunner({ delayMs: 0 });
  const scopedRetry = await retryPendingJobAnalyses({ db,
    input: { planId: scoped.planId, jobIds: String(visibleId) }, deps: applicationDeps(scopedRunner) });
  assert.deepStrictEqual(scopedRetry.jobIds, [visibleId], "a page's retry list must not include another platform or another scope");
  assert(pendingIds(scoped.planId).includes(outsideId));
  await rejects(() => retryPendingJobAnalyses({ db,
    input: { planId: scoped.planId, jobIds: String(sourcePendingId) }, deps: applicationDeps(scopedRunner) }),
    error => assert.match(error.message, /不属于/));
  assert.deepStrictEqual(batch(db, bulk.batchId).filterSnapshot.jobIds, expectedMixed);

  const capped = seedPlan("capped");
  for (let index = 0; index < PRODUCT_POLICY.operations.modelAnalysis.maxRetryJobs + 2; index += 1) {
    seedFailedJob(capped, `capped-${String(index).padStart(2, "0")}`);
  }
  const expectedCapped = pendingIds(capped.planId).slice(0, PRODUCT_POLICY.operations.modelAnalysis.maxRetryJobs);
  const cappedRunner = controlledRunner({ delayMs: 0 });
  const cappedResult = await retryPendingJobAnalyses({ db, input: { planId: capped.planId }, deps: applicationDeps(cappedRunner) });
  assert.deepStrictEqual(cappedResult.jobIds, expectedCapped);
  assert.strictEqual(cappedResult.requested, PRODUCT_POLICY.operations.modelAnalysis.maxRetryJobs);

  const errors = seedPlan("errors");
  const errorRunner = controlledRunner();
  await rejects(() => retryOneJobAnalysis({ db, input: { planId: errors.planId, jobId: 1 }, deps: applicationDeps(errorRunner, { modelReady: false }) }), (error) => {
    assert.strictEqual(error.code, "MODEL_CONFIGURATION_REQUIRED");
    assert.strictEqual(error.statusCode, 409);
  });
  await rejects(() => retryOneJobAnalysis({ db, input: { planId: 999999, jobId: 1 }, deps: applicationDeps(errorRunner) }), (error) => {
    assert.strictEqual(error.message, "Search Plan 不存在。");
  });
  const missingCard = seedPlan("missing-card", { confirmCard: false });
  await rejects(() => retryOneJobAnalysis({ db, input: { planId: missingCard.planId, jobId: 1 }, deps: applicationDeps(errorRunner) }), (error) => {
    assert.strictEqual(error.code, "MATCHING_CARD_CONFIRMATION_REQUIRED");
    assert.strictEqual(error.statusCode, 409);
  });
  await rejects(() => retryOneJobAnalysis({ db, input: { planId: errors.planId, jobId: 999999 }, deps: applicationDeps(errorRunner) }), (error) => {
    assert.strictEqual(error.message, "岗位不存在或不属于当前筛选方案。");
  });
  await rejects(() => retryPendingJobAnalyses({ db, input: { planId: errors.planId }, deps: applicationDeps(errorRunner) }), (error) => {
    assert.strictEqual(error.message, "当前没有待重试的语义分析岗位。");
  });
  assert.deepStrictEqual(errorRunner.calls, [], "validation failures must happen before analyzer execution");
}

async function testPausedInventoryRecovery() {
  const saved = seedPlan('paused-inventory');
  const jobId = seedFailedJob(saved, 'paused-inventory-complete');
  const current = seedPausedWorkflow(saved, 'paused-inventory-current');
  const historical = seedPausedWorkflow(saved, 'paused-inventory-history', { localDay: '1900-01-01' });
  const otherPlatform = seedPausedWorkflow(saved, 'paused-inventory-zhaopin', { site: 'zhaopin' });
  const historicalBefore = getWorkflowRun(db, historical.id);
  const otherBefore = getWorkflowRun(db, otherPlatform.id);
  const recovered = await retryPendingJobAnalyses({ db, input: { planId: saved.planId, jobIds: [jobId] },
    deps: applicationDeps(controlledRunner({ delayMs: 0 })) });
  assert.equal(recovered.completed, 1);
  assert.equal(listWorkflowInventory(db, { planId: saved.planId }).length, 1);
  const updated = getWorkflowRun(db, current.id);
  assert.equal(updated.inventoryCount, 1, 'successful ordinary retry must refresh a paused workflow recommendation count');
  assert.deepStrictEqual({ ...updated, inventoryCount: current.inventoryCount, updatedAt: current.updatedAt }, current,
    'count reconciliation must preserve pause reason, resume phase, generation and every other workflow field');
  assert.deepStrictEqual(getWorkflowRun(db, historical.id), historicalBefore, 'historical workflow counts must remain unchanged');
  assert.deepStrictEqual(getWorkflowRun(db, otherPlatform.id), otherBefore, 'BOSS inventory must not overwrite the other platform count');
  reconcilePlanWorkflowInventory(db, saved.planId);
  assert.deepStrictEqual(getWorkflowRun(db, current.id), updated, 'unchanged inventory must not rewrite the paused workflow');
}

function seedPausedWorkflow(saved, id, overrides = {}) {
  const workflow = createWorkflowRun(db, { id, profileId: saved.profileId, planId: saved.planId,
    localDay: chinaLocalDay(), sequence: 1, inventoryCount: 0, ...overrides });
  db.prepare("UPDATE workflow_runs SET status = 'paused', control_state = 'pause_requested', error_code = 'MODEL_QUOTA_EXHAUSTED', error_message = 'fixture quota pause', resume_phase = 'analyzing', recovery_generation = 2 WHERE id = ?").run(workflow.id);
  return getWorkflowRun(db, workflow.id);
}

async function testBulkRecoveryStopsOnQuotaFailure() {
  const saved = seedPlan('quota-recovery');
  const ids = Array.from({ length: 6 }, (_, i) => seedFailedJob(saved, `quota-recovery-${i}`, { source: 'zhaopin' }));
  const before = ids.map(id => JSON.stringify(job(db, saved.planId, id).analysis));
  const calls = [];
  const deps = applicationDeps(controlledRunner(), {
    createJobAnalysisRunner: () => async input => {
      calls.push(input.id);
      await new Promise(resolve => setTimeout(resolve, 10));
      return { semanticStatus: 'failed', decisionSource: 'analysis_pending', errorCode: 'HTTP_402', error: 'Insufficient balance' };
    }
  });
  await assert.rejects(retryPendingJobAnalyses({ db, input: { planId: saved.planId, jobIds: ids, site: 'zhaopin' }, deps }),
    error => error.code === 'MODEL_QUOTA_EXHAUSTED' && error.statusCode === 409);
  assert.equal(calls.length, PRODUCT_POLICY.operations.modelAnalysis.retryConcurrency, 'quota failure stops new model calls after already running workers');
  for (const id of ids.filter(id => !calls.includes(id))) {
    assert.equal(JSON.stringify(job(db, saved.planId, id).analysis), before[ids.indexOf(id)], 'unstarted jobs retain their original pending results');
  }
  for (const id of calls) assert.equal(job(db, saved.planId, id).analysis.errorCode, 'HTTP_402', 'issued failures remain recorded');
}

async function testUnavailableResumeStopsRecoveryBeforeModel() {
  const saved = seedPlan('resume-unavailable-recovery');
  const ids = Array.from({ length: 6 }, (_, i) => seedFailedJob(saved, `resume-unavailable-${i}`, { source: 'zhaopin' }));
  db.prepare('UPDATE resume_documents SET content_hash = ? WHERE id = ?').run('wrong-confirmed-document-hash', saved.resumeDocumentId);
  let calls = 0;
  const deps = applicationDeps(controlledRunner(), {
    createJobAnalysisRunner(configs, keywords, options) {
      assert.equal(configs.resumeEvidenceRecovery.status, 'unavailable');
      assert.equal(configs.resumeEvidenceRecovery.reasonCode, 'DOCUMENT_HASH_MISMATCH');
      return require('../src/core/job_analysis').createJobAnalysisRunner(configs, keywords, { ...options,
        analyzer: { async selectJob() { calls++; throw Error('Unavailable resume must not reach the model'); } } });
    }
  });
  await assert.rejects(retryPendingJobAnalyses({ db, input: { planId: saved.planId, jobIds: ids, site: 'zhaopin' }, deps }),
    error => error.code === 'CANDIDATE_RESUME_EVIDENCE_UNAVAILABLE' && error.statusCode === 409);
  assert.equal(calls, 0);
  const changed = ids.map(id => job(db, saved.planId, id).analysis).filter(analysis => analysis.errorCode === 'CANDIDATE_RESUME_EVIDENCE_UNAVAILABLE');
  assert.equal(changed.length, PRODUCT_POLICY.operations.modelAnalysis.retryConcurrency);
  assert(changed.every(analysis => analysis.matchStatus === 'material_missing' && analysis.decisionStatus === 'needs_material'));
  assert.equal(ids.length - changed.length, 4, 'Unstarted jobs remain available for recovery');
}

async function testRecoveryPreservesInFlightSuccess() {
  const saved = seedPlan('quota-in-flight');
  const ids = Array.from({ length: 4 }, (_, i) => seedFailedJob(saved, `quota-in-flight-${i}`, { source: 'zhaopin' }));
  const ordered = pendingIds(saved.planId);
  const before = ids.map(id => JSON.stringify(job(db, saved.planId, id).analysis));
  const calls = [];
  const runner = controlledRunner({ delayMs: 0 });
  const deps = applicationDeps(runner, {
    createJobAnalysisRunner(configs) {
      const complete = runner.create(configs);
      return async input => {
        calls.push(input.id);
        await new Promise(resolve => setTimeout(resolve, input.id === ordered[0] ? 30 : 10));
        if (input.id !== ordered[0]) throw Object.assign(new Error('balance exhausted'), { status: 402 });
        return complete(input);
      };
    }
  });
  await assert.rejects(retryPendingJobAnalyses({ db, input: { planId: saved.planId, jobIds: ids, site: 'zhaopin' }, deps }),
    error => error.code === 'MODEL_QUOTA_EXHAUSTED');
  assert.deepEqual(calls, ordered.slice(0, 2), 'a raw HTTP configuration failure also prevents new requests');
  assert.equal(job(db, saved.planId, ordered[0]).analysis.semanticStatus, 'complete', 'already running successful analysis must be saved before reporting the pause');
  assert.equal(job(db, saved.planId, ordered[1]).analysis.errorCode, 'HTTP_402');
  for (const id of ordered.slice(2)) assert.equal(JSON.stringify(job(db, saved.planId, id).analysis), before[ids.indexOf(id)]);
}

async function testProductionRecoveryStopsOnHttpConfigurationFailure() {
  for (const [status, code] of [[402, 'MODEL_QUOTA_EXHAUSTED'], [401, 'MODEL_CONFIGURATION_REQUIRED']]) {
    const saved = seedPlan(`transport-${status}`);
    const ids = Array.from({ length: 6 }, (_, i) => seedFailedJob(saved, `transport-${status}-${i}`, { source: 'zhaopin' }));
    let calls = 0;
    const deps = applicationDeps(controlledRunner(), {
      createJobAnalysisRunner(configs, keywords, options) {
        configs.semanticMatchingMode = 'split';
        return require('../src/core/job_analysis').createJobAnalysisRunner(configs, keywords, {
          ...options,
          analyzer: { async understandJob() {
            calls++;
            await new Promise(resolve => setTimeout(resolve, 10));
            throw Object.assign(new Error('transport configuration error'), { status });
          } }
        });
      }
    });
    await assert.rejects(retryPendingJobAnalyses({ db, input: { planId: saved.planId, jobIds: ids, site: 'zhaopin' }, deps }),
      error => error.code === code && error.statusCode === 409);
    assert.equal(calls, PRODUCT_POLICY.operations.modelAnalysis.retryConcurrency, 'production result-mode errors retain the HTTP status needed to stop new requests');
  }
}

async function testDashboardContract() {
  const http = seedPlan("http");
  const failedJobId = seedFailedJob(http, "http-failed");
  const bulk = seedPlan("http-bulk");
  seedFailedJob(bulk, "http-bulk-failed");
  seedFailedJob(bulk, "http-bulk-source-pending", { location: "Beijing" });
  const empty = seedPlan("http-empty");
  const requests = [];
  const httpRunner = controlledRunner();
  const runtimeModelConfig = { provider: "mock", providers: { mock: { model: "offline-structured-mock" } } };
  let ready = true;
  const httpLogger = {
    info() {}, warn() {}, error() {},
    requestId() { return "analysis-http-request"; },
    listRecent() { return []; }
  };
  server = createDashboardServer({
    db,
    browserAuthority: { browserMode: "edge", cdpPort: null, profilePath: "" },
    root,
    dbPath,
    forceMock: true,
    logger: httpLogger,
    analysisRetryRunnerFactory: httpRunner.create,
    runtimeModelResolver({ taskProfile }) {
      requests.push({ kind: "runtime", taskProfile });
      return { modelConfig: runtimeModelConfig };
    },
    modelReadinessChecker(_state, { taskProfile }) {
      requests.push({ kind: "ready", taskProfile });
      return ready;
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const paused = seedPlan('http-paused-inventory');
  const pausedJobId = seedFailedJob(paused, 'http-paused-inventory-complete');
  await retryOneJobAnalysis({ db, input: { planId: paused.planId, jobId: pausedJobId },
    deps: applicationDeps(controlledRunner({ delayMs: 0 })) });
  const pausedWorkflow = seedPausedWorkflow(paused, 'http-paused-inventory');
  const pausedPage = await fetch(`${base}/workflow?runId=${pausedWorkflow.id}`);
  assert.equal(pausedPage.status, 200);
  assert.match(await pausedPage.text(), /data-overview-recommendations>1<\/dd>/,
    'opening the paused task must repair and display an already stale recommendation count');
  const pausedAfter = getWorkflowRun(db, pausedWorkflow.id);
  assert.equal(pausedAfter.inventoryCount, 1);
  assert.deepStrictEqual({ ...pausedAfter, inventoryCount: pausedWorkflow.inventoryCount, updatedAt: pausedWorkflow.updatedAt }, pausedWorkflow);

  const singleFailed = await post(base, "/api/analyze-job", { planId: http.planId, jobId: failedJobId });
  const singleFailedHtml = await singleFailed.text();
  assert.strictEqual(singleFailed.status, 400);
  assert(singleFailedHtml.includes("MODEL_TIMEOUT"));
  assert(singleFailedHtml.includes("analysis-http-request"));
  assert(singleFailedHtml.includes(`href="/queue?planId=${http.planId}&amp;pool=analysis_pending"`));
  assert(requests.some((entry) => entry.taskProfile === "batch_screening"), "retry routes must resolve the batch_screening task profile");
  assert(httpRunner.configs.every((configs) => configs.model === runtimeModelConfig), "runner seam must receive the route's batch_screening model config without replacing it");

  const guardedHttp = seedPlan("http-guarded");
  const guardedHttpJobId = seedFailedJob(guardedHttp, "http-purpose-bypass", {
    bossActiveText: "近半年活跃",
    bossActiveDays: 180
  });
  const guardedResponse = await post(base, "/api/analyze-job", {
    planId: guardedHttp.planId,
    jobId: guardedHttpJobId,
    purpose: "message_discovery_context"
  });
  assert.strictEqual(guardedResponse.status, 303);
  assert.strictEqual(guardedResponse.headers.get("location"), `/queue?planId=${guardedHttp.planId}&pool=analysis_pending`);
  assert(!httpRunner.calls.includes("http-purpose-bypass"),
    "HTTP form fields must not grant the internal message-context analysis capability");

  const bulkMixed = await post(base, "/api/analyze-jobs", { planId: bulk.planId });
  assert.strictEqual(bulkMixed.status, 303);
  assert.strictEqual(bulkMixed.headers.get("location"), `/queue?planId=${bulk.planId}&pool=analysis_pending`);

  ready = false;
  const modelBlocked = await post(base, "/api/analyze-jobs", { planId: http.planId });
  const modelBlockedHtml = await modelBlocked.text();
  assert.strictEqual(modelBlocked.status, 409);
  assert(modelBlockedHtml.includes("MODEL_CONFIGURATION_REQUIRED"));
  assert(modelBlockedHtml.includes("analysis-http-request"));
  assert(modelBlockedHtml.includes('href="/settings#model-profile-batch_screening"'));

  ready = true;
  const noCard = seedPlan("http-no-card", { confirmCard: false });
  const noCardResponse = await post(base, "/api/analyze-job", { planId: noCard.planId, jobId: 1 });
  const noCardHtml = await noCardResponse.text();
  assert.strictEqual(noCardResponse.status, 409);
  assert(noCardHtml.includes("MATCHING_CARD_CONFIRMATION_REQUIRED"));
  assert(noCardHtml.includes("analysis-http-request"));
  assert(noCardHtml.includes(`href="/queue?planId=${noCard.planId}&amp;pool=analysis_pending"`));

  const missingPlan = await post(base, "/api/analyze-job", { jobId: 1 });
  const missingPlanHtml = await missingPlan.text();
  assert.strictEqual(missingPlan.status, 400);
  assert(missingPlanHtml.includes("JOB_ANALYSIS_RETRY_FAILED"));
  assert(missingPlanHtml.includes("analysis-http-request"));
  assert(missingPlanHtml.includes('href="/"'));

  const missingJob = await post(base, "/api/analyze-job", { planId: http.planId, jobId: 999999 });
  const missingJobHtml = await missingJob.text();
  assert.strictEqual(missingJob.status, 400);
  assert(missingJobHtml.includes("JOB_ANALYSIS_RETRY_FAILED"));
  assert(missingJobHtml.includes("analysis-http-request"));
  assert(missingJobHtml.includes(`href="/queue?planId=${http.planId}&amp;pool=analysis_pending"`));

  const emptyBulk = await post(base, "/api/analyze-jobs", { planId: empty.planId });
  const emptyBulkHtml = await emptyBulk.text();
  assert.strictEqual(emptyBulk.status, 400);
  assert(emptyBulkHtml.includes("JOB_ANALYSIS_RETRY_FAILED"));
  assert(emptyBulkHtml.includes("analysis-http-request"));
  assert(emptyBulkHtml.includes(`href="/queue?planId=${empty.planId}&amp;pool=analysis_pending"`));
  await testAnalysisWaitingUi(base, http.planId, failedJobId);
  const zhaopin = seedPlan("http-zhaopin-recovery");
  const zhaopinJobId = seedFailedJob(zhaopin, "http-zhaopin-complete", { source: "zhaopin" });
  const analysisHref = `/queue?planId=${zhaopin.planId}&site=zhaopin&pool=analysis_pending`;
  const zhaopinPage = await (await fetch(`${base}/jobs?planId=${zhaopin.planId}&site=zhaopin`)).text();
  assert(zhaopinPage.includes(`href="${analysisHref.replaceAll('&', '&amp;')}"`), "Zhaopin records must expose the existing saved-JD analysis queue");
  const recoveryPage = await (await fetch(`${base}${analysisHref}`)).text();
  assert(recoveryPage.includes('action="/api/analyze-jobs"'));
  assert(recoveryPage.includes(`name="jobIds" value="${zhaopinJobId}"`));
  const zhaopinRecovered = await post(base, "/api/analyze-jobs", { planId: zhaopin.planId, jobIds: String(zhaopinJobId), site: "zhaopin" });
  assert.equal(zhaopinRecovered.status, 303);
  assert.equal(job(db, zhaopin.planId, zhaopinJobId).analysis.semanticStatus, "complete");
  assert.equal(db.prepare('SELECT site FROM batches WHERE id = ?').get(job(db, zhaopin.planId, zhaopinJobId).batchId).site, 'zhaopin');
  assert.equal(httpRunner.calls.filter(id => id === 'http-zhaopin-complete').length, 1, "saved-JD recovery calls the existing analyzer once");
  const recoveredPage = await (await fetch(`${base}/jobs?planId=${zhaopin.planId}&site=zhaopin&batch=all`)).text();
  assert(!recoveredPage.includes('继续分析已有岗位'), "a fully resolved list must not retain a misleading recovery prompt");
  const archived = seedPlan('http-zhaopin-archived');
  const archivedId = seedFailedJob(archived, 'http-zhaopin-archived', { source: 'zhaopin' });
  archiveCandidateJob(db, { profileId: archived.profileId, planId: archived.planId, jobId: archivedId });
  const archivedPage = await (await fetch(`${base}/jobs?planId=${archived.planId}&site=zhaopin&archive=only`)).text();
  assert(!archivedPage.includes('继续分析已有岗位'), 'archived jobs must not lead to an empty recovery queue');
  const quota = seedPlan('http-quota');
  const quotaId = seedFailedJob(quota, 'http-quota', { source: 'zhaopin' });
  const quotaResponse = await post(base, '/api/analyze-jobs', { planId: quota.planId, jobIds: String(quotaId), site: 'zhaopin' });
  assert.equal(quotaResponse.status, 409);
  const quotaHtml = await quotaResponse.text();
  assert(quotaHtml.includes('MODEL_QUOTA_EXHAUSTED'));
  assert(quotaHtml.includes('href="/settings#model-profile-batch_screening"'), 'quota recovery directs the user to the existing model settings');
}

async function testAnalysisWaitingUi(base, planId, jobId) {
  let chromium;
  try { ({ chromium } = require("playwright")); }
  catch (error) { if (process.env.ROLEFLOW_REQUIRE_PLAYWRIGHT === "1") throw error; return; }
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${base}/queue?planId=${planId}&pool=analysis_pending`);
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let requests = 0;
    let entered;
    const routeEntered = new Promise(resolve => { entered = resolve; });
    let posted;
    await page.route("**/api/analyze-jobs", async route => {
      requests += 1;
      posted = new URLSearchParams(route.request().postData());
      entered();
      await held;
      await route.fulfill({ status: 303, headers: { location: `/queue?planId=${planId}` } });
    });
    const bulk = page.locator('form[action="/api/analyze-jobs"]');
    await bulk.locator("button").click({ noWaitAfter: true });
    await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes("正在分析"), null, { timeout: 2500 });
    await routeEntered;
    assert.strictEqual(posted.get("jobIds"), String(jobId), "the visible queue controls the actual retry snapshot");
    assert.strictEqual(posted.get("site"), "boss");
    assert.strictEqual(await bulk.locator("button").isDisabled(), true);
    assert.strictEqual(await page.locator("main h1").innerText(), "当前待处理岗位", "the existing page remains readable while analysis is pending");
    await bulk.evaluate(form => form.requestSubmit());
    assert.strictEqual(requests, 1, "repeated submissions must not queue another analysis request");
    release();
    await page.waitForURL(`${base}/queue?planId=${planId}`);
    await page.goto(`${base}/queue?planId=${planId}&pool=analysis_pending`);
    const single = page.locator(`form[action="/api/analyze-job"]:has(input[name="jobId"][value="${jobId}"])`);
    await page.route("**/api/analyze-job", route => route.fulfill({ status: 409, contentType: "text/html", body: '<main><p>模型尚未配置</p><a href="/settings">配置模型</a></main>' }));
    await single.locator("button").click();
    await page.waitForFunction(() => document.querySelector('[role="alert"]')?.textContent.includes("模型尚未配置"));
    assert.strictEqual(await single.locator("button").isEnabled(), true);
    assert.strictEqual(await page.locator('[role="alert"] a').getAttribute("href"), "/settings");
    await page.unroute("**/api/analyze-job");
    let failures = 0;
    await page.route("**/api/analyze-job", route => { failures += 1; return route.abort(); });
    await single.locator("button").click();
    await page.waitForFunction(() => document.querySelector('[role="alert"]')?.textContent.includes("暂时无法确认"));
    assert.strictEqual(failures, 1, "an uncertain response must not replay itself");
    assert.strictEqual(await single.locator("button").isEnabled(), true);
  } finally { await browser.close(); }
}

function seedPlan(label, { confirmCard = true } = {}) {
  const profile = {
    candidate: { name: `Candidate ${label}`, city: "Guangzhou", targetTitles: ["AI Engineer"], expectedSalary: "10-18K" },
    education: [{ school: "Test University", degree: "本科", major: "Computer Science" }],
    experiences: [],
    skills: [{ name: "Python", evidence: ["project"] }, { name: "RAG", evidence: ["project"] }],
    projects: [{ name: "KnowledgeFlow", roleBoundary: "owner", canSay: ["built retrieval"] }],
    credentials: [], strengths: []
  };
  const saved = saveProfileAnalysis(db, {
    profile,
    document: { originalFileName: `${label}.txt`, format: "text", contentHash: `${label}-resume`, text: "Python RAG retrieval project evidence ".repeat(12), diagnostics: {} },
    searchPlan: { name: `Plan ${label}`, cities: ["Guangzhou"], directions: ["AI Engineer"], keywords: [{ word: "AI Engineer", priority: "A" }], experience: ["1-3年"], jobTypes: ["全职"], bossActiveDays: 3 }
  });
  if (confirmCard) {
    const card = createMatchingCardDraft(db, {
      profileId: saved.profileId,
      profileVersionId: saved.profileVersionId,
      resumeDocumentId: saved.resumeDocumentId,
      resumeContentHash: `${label}-resume`,
      card: matchingCardFromProfile(profile),
      source: "migration"
    });
    confirmMatchingCard(db, { profileId: saved.profileId, cardId: card.id });
  }
  return saved;
}

function seedFailedJob(saved, sourceId, overrides = {}) {
  const batchId = createBatch(db, overrides.source || "boss", "seed", "analysis application smoke", {
    profileId: saved.profileId,
    searchPlanId: saved.planId,
    filterSnapshot: { execution: { scanKind: "daily" } }
  });
  return upsertJob(db, {
    source: "boss",
    sourceId,
    keyword: "AI Engineer",
    title: "AI Application Engineer",
    company: "Smoke Co",
    location: "Guangzhou",
    salary: "10-18K",
    experience: "1-3年",
    education: "本科",
    bossActiveText: "今日活跃",
    bossActiveDays: 0,
    url: `https://www.zhipin.com/job_detail/${sourceId}.html`,
    tags: ["Python", "RAG"],
    description: "Build Python RAG and agent applications with retrieval evaluation, FastAPI integration, production diagnostics, testing, and complete delivery ownership. ".repeat(3),
    score: 20,
    level: "可投",
    matches: ["Python", "RAG"],
    risks: [],
    qualityTags: [],
    analysis: { provider: "mock", model: "offline", semanticStatus: "failed", decisionSource: "analysis_pending", recommendation: "review", fitLevel: "C", error: "previous timeout", errorCode: "MODEL_TIMEOUT", evidence: { jd: [], resume: [] } },
    ...overrides
  }, batchId);
}

function applicationDeps(runner, overrides = {}) {
  return {
    root,
    logger,
    modelReady: true,
    modelConfig: { provider: "mock", providers: { mock: { model: "offline-structured-mock" } } },
    createJobAnalysisRunner: runner.create,
    ...overrides
  };
}

function controlledRunner({ delayMs = 10 } = {}) {
  const state = { calls: [], active: 0, peak: 0, configs: [], signals: [] };
  return {
    get calls() { return state.calls; },
    get peak() { return state.peak; },
    get configs() { return state.configs; },
    get signals() { return state.signals; },
    create(configs) {
      state.configs.push(configs);
      return async (jobInput, options = {}) => {
        state.calls.push(jobInput.sourceId);
        state.signals.push(options.signal || null);
        state.active += 1;
        state.peak = Math.max(state.peak, state.active);
        try {
          if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
          if (jobInput.sourceId === 'http-quota') return { semanticStatus: 'failed', errorCode: 'HTTP_402', decisionSource: 'analysis_pending' };
          const semanticStatus = jobInput.sourceId.includes("partial") ? "partial"
            : jobInput.sourceId.includes("failed") ? "failed"
              : "complete";
          return {
            provider: "fixture",
            model: "offline-runner",
            semanticStatus,
            revision: require('../src/core/analysis_revision').buildAnalysisRevision(configs,
              require('../src/storage/job_store').sourceContentHash(jobInput)),
            decisionStatus: semanticStatus === "partial" ? "needs_retry" : "ready",
            recommendation: semanticStatus === "complete" ? "apply" : "review",
            fitLevel: semanticStatus === "complete" ? "A" : "C",
            error: semanticStatus === "failed" ? "fixture timeout" : "",
            errorCode: semanticStatus === "failed" ? "MODEL_TIMEOUT" : "",
            evidence: { jd: ["complete fixture JD"], resume: ["fixture resume evidence"] },
            analysisRevision: { fixture: jobInput.sourceId, version: "analysis-retry-smoke" }
          };
        } finally {
          state.active -= 1;
        }
      };
    }
  };
}

function pendingIds(planId) {
  return listDecisionPool(db, { planId })
    .filter((item) => item.decisionBucket === "analysis_pending" && isJobAwaitingAction(item))
    .map((item) => item.id);
}

function job(database, planId, jobId) {
  return listReportJobs(database, { planId, batch: "all", limit: 10000 }).find((item) => item.id === jobId);
}

function batch(database, batchId) {
  const row = database.prepare("SELECT keyword, filter_snapshot_json FROM batches WHERE id = ?").get(batchId);
  return { keyword: row.keyword, filterSnapshot: JSON.parse(row.filter_snapshot_json) };
}

async function rejects(operation, verify) {
  try {
    await operation();
    assert.fail("expected operation to reject");
  } catch (error) {
    verify(error);
  }
}

function chinaLocalDay() {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = Object.fromEntries(formatter.formatToParts(new Date()).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function post(base, route, values) {
  return fetch(base + route, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(Object.entries(values).map(([key, value]) => [key, String(value)])).toString(),
    redirect: "manual"
  });
}

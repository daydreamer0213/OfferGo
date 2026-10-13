const assert = require("node:assert");

const JOB_EXPORTS = [
  "upsertKeywordSource", "upsertJob", "upsertScanCheckpointJob", "getJob", "getJobIdentity", "listJobIdentities", "listJobSummaries",
  "findLinkableInboundJob", "setZhaopinJobAvailability", "listReportJobs", "markApplication", "bindBatchToPlan",
  "rescorePlanObservations", "reassessBatchObservations", "addFollowUpNote", "recordCandidateJobEvent",
  "listCandidateJobEvents", "recordRecommendationFeedback", "markCandidateJob", "buildFeedbackSummary",
  "buildBatchSummary", "getLatestBatchId", "getLatestMainScanBatchId", "listDecisionPool",
  "getOutcomeAnalyticsSnapshot", "listDecisionQueue", "isJobAwaitingAction", "decisionBucket",
  "applyJobQualityGovernance", "isActivityProbeDue", "sourceContentHash", "getModelCache", "saveModelCache",
  "archiveCandidateJob", "restoreCandidateJob", "isCandidateJobArchived"
].sort();

const CANDIDATE_EXPORTS = [
  "saveProfileAnalysis", "attachResumeDocumentFile", "getResumeDocument", "saveSearchPlan", "getCandidateProfile",
  "listCandidateProfiles", "saveCandidateResumeVersion", "listCandidateResumeVersions", "listMatchingResumeVersions",
  "getCandidateResumeDocument", "getActiveResumeText", "listCandidateResumeVersionLabels",
  "recordResumeParseAttempt", "listResumeParseAttempts", "updateCandidateProfile", "getSearchPlan",
  "getActiveSearchPlan", "listSearchPlans", "listProfileVersions", "getLatestProfileVersionId",
  "getSearchPlanDependency", "getMatchingCard", "getActiveMatchingCard", "listMatchingCards",
  "createMatchingCardDraft", "confirmMatchingCard", "saveMatchingCardDraftEdit", "saveConfirmedMatchingCardRevision",
  "getCandidateMatchingContext", "compareProfileVersions", "saveCandidateFact", "listCandidateFacts"
].sort();

const warnings = [];
const onWarning = (warning) => warnings.push(warning);
process.on("warning", onWarning);
const jobStore = require("../src/storage/job_store");
const candidateStore = require("../src/storage/candidate_store");
const storage = require("../src/core/storage");
process.removeListener("warning", onWarning);

assert.strictEqual(JOB_EXPORTS.length, 36);
assert.strictEqual(CANDIDATE_EXPORTS.length, 32);
assert.strictEqual(Object.keys(storage).length, 196);
assert.deepStrictEqual(Object.keys(jobStore).sort(), JOB_EXPORTS);
assert.deepStrictEqual(Object.keys(candidateStore).sort(), CANDIDATE_EXPORTS);
for (const name of JOB_EXPORTS.filter((name) => ![
  "upsertScanCheckpointJob", "getJob", "getJobIdentity", "listJobIdentities", "listJobSummaries", "findLinkableInboundJob", "setZhaopinJobAvailability"
].includes(name))) assert.strictEqual(storage[name], jobStore[name], `${name} must be a direct facade reference`);
for (const name of CANDIDATE_EXPORTS.filter((name) => ![
  "getCandidateResumeDocument", "getActiveResumeText", "listCandidateResumeVersionLabels"
].includes(name))) assert.strictEqual(storage[name], candidateStore[name], `${name} must remain a direct facade reference`);
assert.strictEqual(warnings.filter((warning) => /circular/i.test(warning.message)).length, 0, "facade and direct stores must load without circular warnings");

async function main() {
activityObservationAnchorSmoke();
wholeJdPriorityMetadataSmoke();
const db = storage.openDb(":memory:");
function observeExec(action) {
  const original = db.exec.bind(db);
  const statements = [];
  db.exec = (sql) => { statements.push(String(sql)); return original(sql); };
  try { return { value: action(), statements }; } finally { db.exec = original; }
}
function observeExecFor(database, action) {
  const original = database.exec.bind(database);
  const statements = [];
  database.exec = (sql) => { statements.push(String(sql)); return original(sql); };
  try { return { value: action(), statements }; } finally { database.exec = original; }
}
async function observeExecAsync(action) {
  const original = db.exec.bind(db);
  const statements = [];
  db.exec = (sql) => { statements.push(String(sql)); return original(sql); };
  try { return { value: await action(), statements }; } finally { db.exec = original; }
}
function tableSnapshot(tables) {
  return Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
}
try {
  jobStore.upsertKeywordSource(db, "AI", "smoke");
  jobStore.upsertKeywordSource(db, "AI", "second-source");
  assert.deepStrictEqual(db.prepare("SELECT keyword, source FROM keyword_sources WHERE keyword = ?").all("AI").map((row) => ({ ...row })), [{ keyword: "AI", source: "second-source" }]);
  jobStore.saveModelCache(db, { cacheKey: "smoke", kind: "job", provider: "test", model: "test", inputHash: "one", result: { first: true } });
  jobStore.saveModelCache(db, { cacheKey: "smoke", kind: "job", provider: "test", model: "test", inputHash: "two", result: { second: true } });
  assert.deepStrictEqual(jobStore.getModelCache(db, "smoke").result, { second: true });
  db.prepare("UPDATE model_cache SET result_json = 'bad json' WHERE cache_key = 'smoke'").run();
  assert.deepStrictEqual(jobStore.getModelCache(db, "smoke").result, {});

  // Independent, ready fixtures freeze decision precedence rather than inheriting refresh tags.
  const ready = { score: 90, level: "优先", risks: [], qualityTags: [], bossActiveDays: 0, description: "x".repeat(160), title: "PM", company: "A", location: "Shanghai" };
  assert.strictEqual(jobStore.decisionBucket({ ...ready, analysis: { semanticStatus: "complete", recommendation: "primary", recommendationSchemaVersion: 2 } }), "primary");
  assert.strictEqual(jobStore.decisionBucket({ ...ready, analysis: { semanticStatus: "partial" } }), "analysis_pending");
  assert.strictEqual(jobStore.decisionBucket({ ...ready, analysis: { semanticStatus: "failed" } }), "analysis_pending");
  assert.strictEqual(jobStore.decisionBucket({ ...ready, analysis: { semanticStatus: "stale" } }), "analysis_pending");
  assert.strictEqual(jobStore.decisionBucket({ ...ready, analysis: { semanticStatus: "complete", hardBlockers: [{ kind: "safety", requirement: "required", jdEvidence: "required", resumeEvidence: "missing" }] } }), "not_recommended");
  assert.strictEqual(jobStore.decisionBucket({ ...ready, analysis: { semanticStatus: "complete", jobQuality: { level: "risk" } } }), "not_recommended");

  const governedOrder = jobStore.applyJobQualityGovernance([{ ...ready, lastSeenAt: "2026-07-20T00:00:00.000Z", bossActiveDays: 1, previousContentHash: "different" }], { now: "2026-08-11T00:00:00.000Z" })[0];
  assert.deepStrictEqual(governedOrder.qualityTags, ["detail_changed", "activity_snapshot_aged", "stale_or_unknown_active", "needs_recheck"]);

  const profileSave = storage.saveProfileAnalysis(db, {
    profile: { candidate: { name: "Job Contract", city: "Shanghai", targetTitles: ["PM"] }, skills: [], projects: [] },
    document: { originalFileName: "contract.txt", format: "text", contentHash: "contract-v1", text: "resume", diagnostics: {} },
    searchPlan: { name: "contract plan", cities: ["Shanghai"], keywords: ["AI"] }
  });
  const profileId = profileSave.profileId;
  const planId = profileSave.planId;

  const batchId = storage.createBatch(db, "boss", "AI", "job-store contract", { profileId, searchPlanId: planId, filterSnapshot: { execution: { source: "contract" } } });
  const outerUpsert = observeExec(() => {
  db.exec("BEGIN IMMEDIATE");
  const value = jobStore.upsertJob(db, {
    source: "boss", sourceId: "job-store-contract", keyword: "AI", title: "Product Manager", company: "RoleFlow",
    location: "Shanghai", salary: "25k", experience: "3 years", education: "Bachelor", tags: ["AI"],
    description: "A complete job description for the job storage contract smoke test.", url: "https://example.invalid/job-store-contract"
  }, batchId);
  db.exec("COMMIT");
  return value;
  });
  assert.deepStrictEqual(outerUpsert.statements, ["BEGIN IMMEDIATE", "COMMIT"]);
  const jobId = outerUpsert.value;
  assert.strictEqual(jobStore.upsertJob(db, { source: "boss", sourceId: "job-store-contract", title: "Product Manager", company: "RoleFlow" }, batchId), jobId);
  const report = jobStore.listReportJobs(db, { batch: "all" });
  assert.strictEqual(report.length, 1);
  assert.strictEqual(report[0].sourceId, "job-store-contract");
  assert.strictEqual(report[0].previousContentHash, "");
  assert.strictEqual(jobStore.sourceContentHash(report[0]).length, 64);
  assert.strictEqual(db.prepare("SELECT content_hash FROM job_observations WHERE job_id = ?").get(jobId).content_hash, jobStore.sourceContentHash({ title: "Product Manager", company: "RoleFlow" }));

  jobStore.markApplication(db, jobId, "applied", "legacy note");
  jobStore.markCandidateJob(db, { profileId, jobId, planId, status: "review", note: "profile note", reviewAt: "2026-08-12" });
  jobStore.recordRecommendationFeedback(db, { profileId, jobId, planId, reasonCode: "other", note: "feedback" });
  jobStore.recordCandidateJobEvent(db, { profileId, jobId, planId, eventType: "manual", payload: { source: "contract" } });
  const profileReport = jobStore.listReportJobs(db, { planId, profileId, batch: "all" })[0];
  const legacyReport = jobStore.listReportJobs(db, { batch: "all" }).find((row) => row.id === jobId);
  assert.strictEqual(profileReport.applicationStatus, "review");
  assert.strictEqual(profileReport.applicationNote, "profile note");
  assert.strictEqual(legacyReport.applicationStatus, "applied");
  assert.deepStrictEqual(jobStore.listCandidateJobEvents(db, { profileId, jobId, planId, limit: 10 }).map((event) => event.eventType).sort(), ["manual", "recommendation_feedback", "review"]);
  assert.deepStrictEqual(jobStore.listCandidateJobEvents(db, { profileId, jobId, eventType: "manual" })[0].payload, { source: "contract" });

  const queueBatch = storage.createBatch(db, "boss", "queue", "queue", { profileId, searchPlanId: planId, filterSnapshot: { execution: {} } });
  for (const [sourceId, status] of [["queue-review", "review"], ["queue-pending", ""]]) {
    const id = jobStore.upsertJob(db, { ...ready, source: "boss", sourceId, keyword: "AI", tags: [], matches: [], analysis: { semanticStatus: "complete", recommendation: "primary", recommendationSchemaVersion: 2, revision: { pipelineVersions: require('../src/core/analysis_revision').PIPELINE_VERSIONS } } }, queueBatch);
    if (status) jobStore.markCandidateJob(db, { profileId, jobId: id, planId, status, note: status });
  }
  assert.deepStrictEqual(jobStore.listDecisionQueue(db, { planId, limit: 1 }).map((row) => row.sourceId), ["queue-review"]);
  for (let index = 0; index < 55; index += 1) {
    jobStore.upsertJob(db, { ...ready, source: "boss", sourceId: `queue-cap-${index}`, keyword: "AI", tags: ["salary_target_core"], matches: [], url: `https://www.zhipin.com/job_detail/queue-${index}.html`, bossActiveText: "今日活跃", analysis: { semanticStatus: "complete", recommendation: "primary", recommendationSchemaVersion: 2 } }, queueBatch);
  }
  const cappedQueue = jobStore.listDecisionQueue(db, { planId, limit: 999 });
  assert.strictEqual(cappedQueue.length, 50);
  assert.strictEqual(cappedQueue[0].sourceId, "queue-review");
  const firstPending = cappedQueue.findIndex((row) => !row.applicationStatus || row.applicationStatus === "pending");
  assert(firstPending > 0 && cappedQueue.slice(0, firstPending).every((row) => row.applicationStatus === "review"));
  assert.strictEqual(jobStore.getLatestMainScanBatchId(db, { planId }), queueBatch);
  const ignored = storage.createBatch(db, "boss", "ignored", "ignored", { profileId, searchPlanId: planId, filterSnapshot: { execution: [] } });
  jobStore.upsertJob(db, { ...ready, source: "boss", sourceId: "ignored", tags: [], matches: [] }, ignored);
  assert.strictEqual(jobStore.getLatestMainScanBatchId(db, { planId }), queueBatch);

  const configs = { model: { provider: "test", providers: { test: { model: "test" } } }, candidateProfile: { candidate: { targetTitles: ["PM"] } }, searchPlan: { name: "contract", cities: ["Shanghai"], keywords: ["AI"] }, profile: { location: { target_cities: ["Shanghai"] }, candidate: { target_roles: ["PM"] } }, scoring: { positive_keywords: [], risk_rules: [], boss_activity: { max_active_days: 3 }, salary: {}, experience: {}, exclude_words: [] }, targetPolicy: { directions: ["PM"] }, platformPolicy: {} };
  const bound = storage.createBatch(db, "boss", "bind", "bind");
  jobStore.upsertJob(db, { ...ready, source: "boss", sourceId: "bind", tags: [], matches: [] }, bound);
  const bind = observeExec(() => jobStore.bindBatchToPlan(db, { batchId: bound, planId }));
  assert.deepStrictEqual(bind.statements, ["BEGIN", "COMMIT"]);
  const rescored = observeExec(() => jobStore.rescorePlanObservations(db, { planId, configs }));
  assert.deepStrictEqual(rescored.statements, ["BEGIN", "COMMIT"]);
  const bindFailureBatch = storage.createBatch(db, "boss", "bind-failure", "bind-failure");
  const bindFailureJob = jobStore.upsertJob(db, { ...ready, source: "boss", sourceId: "bind-failure", tags: [], matches: [] }, bindFailureBatch);
  jobStore.markApplication(db, bindFailureJob, "applied", "legacy");
  const bindBefore = db.prepare("SELECT search_plan_id AS planId FROM batches WHERE id = ?").get(bindFailureBatch);
  db.exec(`CREATE TRIGGER fail_contract_bind BEFORE INSERT ON candidate_job_states WHEN NEW.job_id = ${bindFailureJob} BEGIN SELECT RAISE(ABORT, 'bind late failure'); END`);
  const bindFailure = observeExec(() => assert.throws(() => jobStore.bindBatchToPlan(db, { batchId: bindFailureBatch, planId }), /bind late failure/));
  assert.deepStrictEqual(bindFailure.statements, ["BEGIN", "ROLLBACK"]);
  assert.deepStrictEqual(db.prepare("SELECT search_plan_id AS planId FROM batches WHERE id = ?").get(bindFailureBatch), bindBefore);
  db.exec("DROP TRIGGER fail_contract_bind");

  const rescoreBatch = storage.createBatch(db, "boss", "rescore", "rescore", { profileId, searchPlanId: planId, filterSnapshot: { execution: {} } });
  jobStore.upsertJob(db, { ...ready, source: "boss", sourceId: "rescore-first", score: 0, tags: [], matches: [], url: "https://www.zhipin.com/job_detail/rescore-first.html", bossActiveText: "今日活跃" }, rescoreBatch);
  jobStore.upsertJob(db, { ...ready, source: "boss", sourceId: "rescore-second", score: 0, tags: [], matches: [], url: "https://www.zhipin.com/job_detail/rescore-second.html", bossActiveText: "今日活跃" }, rescoreBatch);
  const rescoreObservation = db.prepare("SELECT id FROM job_observations WHERE batch_id = ? ORDER BY id DESC LIMIT 1").get(rescoreBatch);
  const rescoreBefore = db.prepare("SELECT * FROM job_observations WHERE batch_id = ? ORDER BY id").all(rescoreBatch);
  db.exec(`CREATE TRIGGER fail_contract_rescore BEFORE UPDATE ON job_observations WHEN NEW.id = ${rescoreObservation.id} BEGIN SELECT RAISE(ABORT, 'rescore late failure'); END`);
  const rescoreFailure = observeExec(() => assert.throws(() => jobStore.rescorePlanObservations(db, { planId, configs }), /rescore late failure/));
  assert.deepStrictEqual(rescoreFailure.statements, ["BEGIN", "ROLLBACK"]);
  assert.deepStrictEqual(db.prepare("SELECT * FROM job_observations WHERE batch_id = ? ORDER BY id").all(rescoreBatch), rescoreBefore);
  db.exec("DROP TRIGGER fail_contract_rescore");

  const reassessBatch = storage.createBatch(db, "boss", "reassess", "reassess", { profileId, searchPlanId: planId, filterSnapshot: { execution: {} } });
  jobStore.upsertJob(db, { ...ready, source: "boss", sourceId: "reassess-late", keyword: "AI", tags: [], matches: [], description: "short", url: "https://www.zhipin.com/job_detail/reassess.html", bossActiveText: "今日活跃" }, reassessBatch);
  const reassessObservation = db.prepare("SELECT id, analysis_json FROM job_observations WHERE batch_id = ? ORDER BY id LIMIT 1").get(reassessBatch);
  db.exec(`CREATE TRIGGER fail_contract_reassess BEFORE UPDATE ON job_observations WHEN NEW.id = ${reassessObservation.id} BEGIN SELECT RAISE(ABORT, 'reassess late failure'); END`);
  let lateAnalyzerCalls = 0;
  const reassessFailure = await observeExecAsync(() => assert.rejects(() => jobStore.reassessBatchObservations(db, { batchId: reassessBatch, planId, configs, analyzeJob: async () => { lateAnalyzerCalls += 1; return { semanticStatus: "complete", recommendation: "primary", recommendationSchemaVersion: 2 }; } }), /reassess late failure/));
  assert.deepStrictEqual(reassessFailure.statements, ["BEGIN", "ROLLBACK"]);
  assert(lateAnalyzerCalls > 0);
  assert.deepStrictEqual(db.prepare("SELECT id, analysis_json FROM job_observations WHERE id = ?").get(reassessObservation.id), reassessObservation);
  db.exec("DROP TRIGGER fail_contract_reassess");
  const reassessedSuccess = await observeExecAsync(() => jobStore.reassessBatchObservations(db, { batchId, planId, configs, analyzeJob: async () => ({ semanticStatus: "complete", recommendation: "primary", recommendationSchemaVersion: 2 }) }));
  assert.deepStrictEqual(reassessedSuccess.statements, ["BEGIN", "COMMIT"]);
  const reassessed = reassessedSuccess.value;
  assert.strictEqual(reassessed.batchId, batchId);
  let analyzerCalls = 0;
  const countBeforeGate = db.prepare("SELECT count(*) AS n FROM job_observations").get().n;
  for (const [input, code] of [[{ batchId: null, planId }, "BATCH_ID_REQUIRED"], [{ batchId, planId: null }, "PLAN_ID_REQUIRED"], [{ batchId, planId: planId + 999 }, "BATCH_PLAN_MISMATCH"]]) {
    const gateBefore = tableSnapshot(["jobs", "job_observations", "events", "candidate_job_events", "job_analysis_attempts"]);
    await assert.rejects(() => jobStore.reassessBatchObservations(db, { ...input, configs, analyzeJob: async () => { analyzerCalls += 1; } }), (error) => error.code === code);
    assert.deepStrictEqual(tableSnapshot(["jobs", "job_observations", "events", "candidate_job_events", "job_analysis_attempts"]), gateBefore);
  }
  assert.strictEqual(analyzerCalls, 0);
  assert.strictEqual(db.prepare("SELECT count(*) AS n FROM job_observations").get().n, countBeforeGate);

  // Isolated plan: exactly two observations, with a UDF-triggered failure on the second real update.
  const isolated = storage.openDb(":memory:");
  try {
    const isolatedSave = storage.saveProfileAnalysis(isolated, {
      profile: { candidate: { name: "Atomic Contract", city: "Shanghai", targetTitles: ["PM"] }, skills: [], projects: [] },
      document: { originalFileName: "atomic.txt", format: "text", contentHash: "atomic-v1", text: "resume", diagnostics: {} },
      searchPlan: { name: "atomic plan", cities: ["Shanghai"], keywords: ["AI"] }
    });
    const isolatedBatch = storage.createBatch(isolated, "boss", "atomic", "atomic", { profileId: isolatedSave.profileId, searchPlanId: isolatedSave.planId, filterSnapshot: { execution: {} } });
    for (const sourceId of ["atomic-first", "atomic-second"]) jobStore.upsertJob(isolated, { ...ready, source: "boss", sourceId, score: 0, keyword: "AI", tags: [], matches: [], url: `https://www.zhipin.com/job_detail/${sourceId}.html`, bossActiveText: "今日活跃" }, isolatedBatch);
    const isolatedConfigs = { ...configs, candidateProfile: { candidate: { targetTitles: ["PM"] } }, searchPlan: { name: "atomic plan", cities: ["Shanghai"], keywords: ["AI"] } };
    const isolatedRows = () => isolated.prepare(`SELECT o.*, j.source, j.source_id FROM job_observations o JOIN batches b ON b.id = o.batch_id JOIN jobs j ON j.id = o.job_id WHERE b.search_plan_id = ? ORDER BY o.id`).all(isolatedSave.planId).map((row) => ({ ...row }));
    assert.strictEqual(isolatedRows().length, 2);
    let updateCalls = 0;
    isolated.function("contract_second_update", () => { updateCalls += 1; if (updateCalls === 2) throw new Error("second rescore update"); return 0; });
    isolated.exec("CREATE TRIGGER fail_second_rescore BEFORE UPDATE ON job_observations BEGIN SELECT contract_second_update(); END");
    const atomicBefore = isolatedRows();
    const atomicFailure = observeExecFor(isolated, () => assert.throws(() => jobStore.rescorePlanObservations(isolated, { planId: isolatedSave.planId, configs: isolatedConfigs }), /second rescore update|SQLITE/));
    assert.deepStrictEqual(atomicFailure.statements, ["BEGIN", "ROLLBACK"]);
    assert.strictEqual(updateCalls, 2);
    assert.deepStrictEqual(isolatedRows(), atomicBefore);
  } finally { isolated.close(); }
} finally {
  db.close();
}
}

function wholeJdPriorityMetadataSmoke() {
  const db = storage.openDb(":memory:");
  const NativeDate = Date;
  let clock = "2026-10-14T08:00:00.000Z";
  global.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return NativeDate.parse(clock); }
  };
  try {
    const owner = storage.saveProfileAnalysis(db, {
      profile: { candidate: { name: "Priority Contract", city: "Shanghai", targetTitles: ["PM"] }, skills: [], projects: [] },
      document: { originalFileName: "priority.txt", format: "text", contentHash: "priority-v1", text: "resume", diagnostics: {} },
      searchPlan: { name: "priority", cities: ["Shanghai"], keywords: ["AI"] }
    });
    const analysis = { semanticMatchingMode: "whole_jd", semanticStatus: "complete", decisionStatus: "decided",
      decisionSource: "model_work_match", recommendation: "apply", recommendationSchemaVersion: 2,
      revision: { semanticMatchingMode: "whole_jd", pipelineVersions: require("../src/core/analysis_revision").PIPELINE_VERSIONS } };
    const base = { source: "boss", title: "PM", location: "Shanghai", tags: [], matches: [], qualityTags: [], risks: [],
      description: "Complete duties and requirements for this PM opportunity. ".repeat(4),
      bossActiveText: "今日活跃", bossActiveDays: 0, analysis };
    const observe = (job, at, keyword = "AI") => {
      clock = at;
      const batchId = storage.createBatch(db, job.source, keyword, keyword, { profileId: owner.profileId, searchPlanId: owner.planId });
      return jobStore.upsertJob(db, { ...job, url: `https://example.test/jobs/${job.sourceId}` }, batchId);
    };
    const checks = [];
    const inspectOrder = (name, ids, expected) => {
      clock = "2026-10-14T15:00:00.000Z";
      const pool = jobStore.listDecisionPool(db, { planId: owner.planId }).filter(job => ids.includes(job.id));
      const report = jobStore.listReportJobs(db, { planId: owner.planId, profileId: owner.profileId, batch: "all" }).filter(job => ids.includes(job.id));
      assert.strictEqual(pool.length, ids.length, `${name}: all fixtures remain visible`);
      checks.push({ name, actual: pool.map(job => job.sourceId), report: report.map(job => job.sourceId), expected });
      return pool;
    };
    const pair = (name, patch, cleanFirst = false, common = {}) => {
      const clean = { ...base, ...common, sourceId: `${name}-clean`, company: `${name}-clean` };
      const reminded = { ...base, ...common, ...patch, sourceId: `${name}-reminded`, company: `${name}-reminded` };
      const ids = [observe(clean, "2026-10-14T09:00:00.000Z"), observe(reminded, "2026-10-14T10:00:00.000Z")];
      const rawBefore = db.prepare("SELECT analysis_json, risks_json, quality_tags_json FROM job_observations WHERE job_id IN (?,?) ORDER BY job_id").all(...ids);
      const projected = inspectOrder(name, ids, cleanFirst ? [clean.sourceId, reminded.sourceId] : [reminded.sourceId, clean.sourceId]);
      const savedReminder = jobStore.getJob(db, ids[1]);
      assert.deepStrictEqual(savedReminder.risks, reminded.risks, `${name}: reminders remain saved`);
      assert.deepStrictEqual(projected.find(job => job.id === ids[1]).risks, reminded.risks, `${name}: reminders remain projected`);
      for (const tag of reminded.qualityTags) assert(savedReminder.qualityTags.includes(tag), `${name}: tags remain saved`);
      assert.deepStrictEqual(db.prepare("SELECT analysis_json, risks_json, quality_tags_json FROM job_observations WHERE job_id IN (?,?) ORDER BY job_id").all(...ids), rawBefore);
      return projected;
    };
    for (const [tag, risk] of [
      ["experience_stretch", "经验范围可冲刺"], ["experience_stretch", "经验门槛偏高"],
      ["experience_unverified", "经验待确认"], ["experience_overrange", "经验门槛明显偏高"],
      ["experience_out_of_scope", "经验不在当前选择范围"]
    ]) pair(`${tag}-${risk}`, { qualityTags: [tag], risks: [risk] });
    for (const tag of ["experience_stretch", "experience_unverified"]) pair(`${tag}-tag-only`, { qualityTags: [tag] });
    pair("unpaired-reminder", { risks: ["经验范围可冲刺"] }, true);
    pair("wrong-tag-reminder", { qualityTags: ["experience_stretch"], risks: ["经验待确认"] }, true);
    pair("mixed-salary-experience", { qualityTags: ["experience_stretch"], risks: ["经验门槛偏高，薪资明显超出偏好"] }, true);
    pair("unknown-experience-risk", { qualityTags: ["experience_stretch"], risks: ["可能需要补充项目交付经验"] }, true);
    pair("salary-preference", { qualityTags: ["experience_stretch", "salary_target_high"], risks: ["经验范围可冲刺"] }, true);
    pair("salary-unverified", { qualityTags: ["experience_stretch", "salary_preference_unverified"], risks: ["经验范围可冲刺"] }, true);
    pair("safety-risk", { qualityTags: ["experience_stretch", "low_value_risk"], risks: ["经验范围可冲刺", "存在收费风险"] }, true);
    pair("work-schedule", { qualityTags: ["experience_stretch", "work_schedule_single"], risks: ["经验范围可冲刺"] }, true);
    for (const [name, patch] of [
      ["legacy-mode", { semanticMatchingMode: "layered" }], ["partial", { semanticStatus: "partial" }],
      ["stale", { semanticStatus: "stale" }], ["undecided", { decisionStatus: "needs_retry" }],
      ["rule-source", { decisionSource: "rule_gate" }], ["invalid-tier", { recommendation: "invalid" }],
      ["old-pipeline", { revision: { ...analysis.revision, pipelineVersions: { ...analysis.revision.pipelineVersions, selectJob: "old" } } }]
    ]) pair(name, { qualityTags: ["experience_stretch"], risks: ["经验范围可冲刺"] }, true, { analysis: { ...analysis, ...patch } });
    pair("incomplete-jd", { qualityTags: ["experience_stretch"], risks: ["经验范围可冲刺"] }, true, { description: "short JD" });
    for (const tier of ["primary", "caution", "not_recommended"]) {
      const projected = pair(`tier-${tier}`, { qualityTags: ["experience_stretch"], risks: ["经验范围可冲刺"] }, false, { analysis: { ...analysis, recommendation: tier } });
      assert(projected.every(job => job.analysis.recommendation === tier && job.decisionBucket === tier), "sorting does not change the final tier");
    }
    const oldLive = { ...base, sourceId: "date-old-live", company: "Date Old" }, newLive = { ...base, sourceId: "date-new-live", company: "Date New" };
    observe(oldLive, "2026-10-14T08:00:00.000Z");
    const oldId = observe(oldLive, "2026-10-14T09:00:00.000Z");
    observe(newLive, "2026-10-14T08:00:00.000Z");
    const newId = observe(newLive, "2026-10-14T10:00:00.000Z");
    observe(newLive, "2026-10-14T13:00:00.000Z", "analysis-retry-bulk");
    observe(oldLive, "2026-10-14T14:00:00.000Z", "analysis-retry");
    const dates = inspectOrder("real source wins over later local retry", [oldId, newId], [newLive.sourceId, oldLive.sourceId]);
    assert(dates.every(job => job.effectiveBossActiveDays === 0 && job.decisionBucket === "apply"));
    assert.deepStrictEqual(dates[0].qualityTags, dates[1].qualityTags, "same duplicate metadata keeps the date comparison isolated");
    assert.strictEqual(dates.find(job => job.id === oldId).activityObservedAt, "2026-10-14T09:00:00.000Z");
    assert.strictEqual(dates.find(job => job.id === newId).activityObservedAt, "2026-10-14T10:00:00.000Z");
    assert.strictEqual(dates.find(job => job.id === oldId).lastSeenAt, "2026-10-14T14:00:00.000Z");
    const zlOld = { ...base, source: "zhaopin", bossActiveText: "", bossActiveDays: null, sourceId: "zl-date-old", company: "ZL Old" };
    const zlNew = { ...zlOld, sourceId: "zl-date-new", company: "ZL New" };
    inspectOrder("zhaopin retains local date compatibility", [observe(zlOld, "2026-10-14T09:00:00.000Z"), observe(zlNew, "2026-10-14T10:00:00.000Z")], [zlNew.sourceId, zlOld.sourceId]);
    console.log("whole JD priority metadata checks", JSON.stringify(checks));
    for (const check of checks) {
      assert.deepStrictEqual(check.actual, check.expected, check.name);
      assert.deepStrictEqual(check.report, check.expected, `${check.name}: report shares the order`);
    }
  } finally {
    global.Date = NativeDate;
    db.close();
  }
}

function activityObservationAnchorSmoke() {
  const db = storage.openDb(":memory:");
  const NativeDate = Date;
  let clock = "2026-10-01T00:00:00.000Z";
  global.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return NativeDate.parse(clock); }
  };
  try {
    const save = (name) => storage.saveProfileAnalysis(db, {
      profile: { candidate: { name, city: "Shanghai", targetTitles: ["PM"] }, skills: [], projects: [] },
      document: { originalFileName: `${name}.txt`, format: "text", contentHash: name, text: "resume", diagnostics: {} },
      searchPlan: { name, cities: ["Shanghai"], keywords: ["AI"] }
    });
    const owner = save("activity-owner");
    const otherOwner = save("activity-other-owner");
    const otherPlanId = candidateStore.saveSearchPlan(db, { profileId: owner.profileId, plan: { name: "activity-other-plan", cities: ["Shanghai"], keywords: ["AI"] } });
    const analysis = { semanticStatus: "complete", recommendation: "primary", modelRecommendation: "caution", recommendationSchemaVersion: 2,
      revision: { pipelineVersions: require("../src/core/analysis_revision").PIPELINE_VERSIONS } };
    const fixture = { source: "boss", sourceId: "activity-anchor", title: "PM", company: "Anchor", location: "Shanghai", tags: [], matches: [],
      description: "A complete job description. ".repeat(8), bossActiveText: "今日活跃", bossActiveDays: 0, analysis };
    const observe = (keyword, at, job = fixture, binding = owner) => {
      clock = at;
      const batchId = storage.createBatch(db, "boss", keyword, keyword, { profileId: binding.profileId, searchPlanId: binding.planId });
      const jobId = jobStore.upsertJob(db, job, batchId);
      return { batchId, jobId };
    };
    const checks = [];
    const inspect = (name, jobId, expectedAt, expectedDays, expectedLastSeenAt) => {
      const pool = jobStore.listDecisionPool(db, { planId: owner.planId }).find((job) => job.id === jobId);
      const report = jobStore.listReportJobs(db, { planId: owner.planId, profileId: owner.profileId, batch: "all" }).find((job) => job.id === jobId);
      const single = jobStore.getJob(db, jobId);
      checks.push({ name, actual: [pool.activityObservedAt, report.activityObservedAt, single.activityObservedAt, pool.effectiveBossActiveDays],
        expected: [expectedAt, expectedAt, expectedAt, expectedDays] });
      assert.strictEqual(pool.lastSeenAt, expectedLastSeenAt, "local observation time remains available");
      assert.strictEqual(pool.analysis.recommendation, "primary");
      assert.strictEqual(pool.analysis.modelRecommendation, "caution");
      assert.deepStrictEqual(report.analysis, single.analysis);
      if (expectedDays > 3 || expectedDays === null) checks.push({ name: `${name}-refresh`, actual: pool.decisionBucket, expected: "refresh" });
    };
    const live = observe("AI", clock);
    const liveRow = db.prepare("SELECT * FROM job_observations WHERE batch_id = ?").get(live.batchId);
    const retry = observe("analysis-retry", "2026-10-05T00:00:00.000Z");
    clock = "2026-10-06T00:00:00.000Z";
    inspect("local retry ages from original live source", live.jobId, liveRow.seen_at, 5, "2026-10-05T00:00:00.000Z");
    observe("analysis-retry-bulk", "2026-10-05T12:00:00.000Z");
    clock = "2026-10-06T00:00:00.000Z";
    inspect("bulk retry ages from original live source", live.jobId, liveRow.seen_at, 5, "2026-10-05T12:00:00.000Z");
    checks.push({ name: "bulk retry is not a new scan", actual: jobStore.listDecisionPool(db, { planId: owner.planId }).find((job) => job.id === live.jobId).latestScanBatchId, expected: live.batchId });
    assert.deepStrictEqual(db.prepare("SELECT * FROM job_observations WHERE batch_id = ?").get(live.batchId), liveRow);
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS count FROM job_observations WHERE job_id = ?").get(live.jobId).count, 3);
    for (const [keyword, at] of [["detail-refresh", "2026-10-06T01:00:00.000Z"], ["activity-probe", "2026-10-06T02:00:00.000Z"], ["AI", "2026-10-06T03:00:00.000Z"]]) {
      observe(keyword, at);
      inspect(`${keyword} is a new real observation`, live.jobId, at, 0, at);
    }
    // A local snapshot must not borrow another plan/profile's date or a different displayed activity value.
    observe("AI", "2026-10-06T04:00:00.000Z", fixture, { profileId: owner.profileId, planId: otherPlanId });
    observe("AI", "2026-10-06T05:00:00.000Z", fixture, otherOwner);
    observe("AI", "2026-10-06T06:00:00.000Z", { ...fixture, bossActiveText: "昨日活跃", bossActiveDays: 1 });
    observe("analysis-retry", "2026-10-06T07:00:00.000Z");
    inspect("retry keeps the displayed snapshot's own source", live.jobId, "2026-10-06T03:00:00.000Z", 0, "2026-10-06T07:00:00.000Z");
    const historical = jobStore.listReportJobs(db, { batchId: retry.batchId })[0];
    checks.push({ name: "historical retry does not borrow later live date", actual: historical.activityObservedAt, expected: liveRow.seen_at });
    const unknown = observe("analysis-retry", "2026-10-06T08:00:00.000Z", { ...fixture, sourceId: "activity-unknown", company: "Unknown" });
    inspect("analysis without a traceable live source is unknown", unknown.jobId, "", null, "2026-10-06T08:00:00.000Z");
    const derivedSourceAt = "2026-10-01T00:00:00.000Z", derivedRetryAt = "2026-10-05T00:00:00.000Z";
    for (const [name, keyword, sourceText, sourceDays, retryText, retryDays, expectedAt] of [
      ["single retry derives source text days", "analysis-retry", "今日活跃", null, "今日活跃", 0, derivedSourceAt],
      ["bulk retry derives source text days", "analysis-retry-bulk", "今日活跃", null, "今日活跃", 0, derivedSourceAt],
      ["unknown source text cannot supply days", "analysis-retry", "近期活跃", null, "近期活跃", 0, ""],
      ["explicit conflicting source days stay isolated", "analysis-retry", "今日活跃", 1, "今日活跃", 0, ""],
      ["derived conflicting source days stay isolated", "analysis-retry", "昨日活跃", null, "昨日活跃", 0, ""],
      ["invalid current days stay unknown", "analysis-retry", "今日活跃", null, "今日活跃", -1, ""],
      ["changed activity text stays isolated", "analysis-retry", "昨日活跃", null, "今日活跃", 0, ""]
    ]) {
      const sourceJob = { ...fixture, sourceId: name, company: name, bossActiveText: sourceText, bossActiveDays: sourceDays };
      const source = observe("AI", derivedSourceAt, sourceJob);
      const original = db.prepare("SELECT * FROM job_observations WHERE batch_id = ?").get(source.batchId);
      observe(keyword, derivedRetryAt, { ...sourceJob, bossActiveText: retryText, bossActiveDays: retryDays });
      clock = "2026-10-06T00:00:00.000Z";
      inspect(name, source.jobId, expectedAt, expectedAt ? 5 : null, derivedRetryAt);
      assert.deepStrictEqual(db.prepare("SELECT * FROM job_observations WHERE batch_id = ?").get(source.batchId), original);
    }
    const strictJob = { ...fixture, sourceId: "strict-source-survives", company: "Strict", bossActiveText: "未说明", bossActiveDays: 1 };
    const strictSource = observe("AI", derivedSourceAt, strictJob);
    observe("AI", "2026-10-02T00:00:00.000Z", { ...strictJob, bossActiveDays: null });
    observe("analysis-retry", derivedRetryAt, strictJob);
    clock = "2026-10-06T00:00:00.000Z";
    inspect("a later incompatible null source does not hide an earlier strict source", strictSource.jobId, derivedSourceAt, 6, derivedRetryAt);
    const nullJob = { ...fixture, sourceId: "strict-null-source", company: "Strict Null", bossActiveText: "未说明", bossActiveDays: null };
    const nullSource = observe("AI", derivedSourceAt, nullJob);
    observe("analysis-retry", derivedRetryAt, nullJob);
    checks.push({ name: "strict null equality retains the actual source date", actual: jobStore.getJob(db, nullSource.jobId).activityObservedAt, expected: derivedSourceAt });
    assert.strictEqual(jobStore.listDecisionPool(db, { planId: owner.planId }).find(job => job.id === nullSource.jobId).effectiveBossActiveDays, null);
    console.log("activity observation anchor checks", JSON.stringify(checks));
    for (const check of checks) assert.deepStrictEqual(check.actual, check.expected, check.name);
  } finally {
    global.Date = NativeDate;
    db.close();
  }
}

main().then(() => console.log("job_store_contract_smoke ok"), (error) => { console.error(error); process.exitCode = 1; });

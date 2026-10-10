const { createBatch } = require("../../storage/scan_store");
const { upsertJob, listDecisionPool, isJobAwaitingAction } = require("../../storage/job_store");
const { getSearchPlan, listMatchingResumeVersions, getSearchPlanDependency,
  getCandidateMatchingContext } = require("../../storage/candidate_store");
const { profileToRuntimeConfigs } = require("../../core/search_plan");
const { loadConfigs } = require("../../config");
const { appError } = require("../../core/observability");
const { PRODUCT_POLICY } = require("../../core/product_policy");
const { scoreJob, decisionState } = require("../../core/scoring");
const { createJobAnalysisRunner } = require("../../core/job_analysis");
const { mapWithConcurrency } = require("../../core/async_pool");
const { reconcilePlanWorkflowInventory } = require("../../core/workflow_inventory");
const { classifyWorkflowAnalysisError } = require("../../core/workflow_analysis_executor");

function retryOneJobAnalysis({ db, input = {}, deps = {} }) {
  return retryJobAnalyses({ db, input, deps, bulk: false });
}

function retryPendingJobAnalyses({ db, input = {}, deps = {} }) {
  return retryJobAnalyses({ db, input, deps, bulk: true });
}

async function retryJobAnalyses({ db, input, deps, bulk }) {
  if (!deps.modelReady) {
    throw appError(
      "MODEL_CONFIGURATION_REQUIRED",
      "重试语义分析前，请先完成批量筛选模型连接测试。",
      { statusCode: 409 }
    );
  }
  const planId = Number(input.planId);
  const plan = getSearchPlan(db, planId);
  if (!plan) throw new Error("Search Plan 不存在。");
  const matchingContext = getCandidateMatchingContext(db, plan.profileId, { includeResumeEvidence: true });
  if (!matchingContext) {
    throw appError("MATCHING_CARD_CONFIRMATION_REQUIRED", "重试语义分析前，请先在工作台确认匹配偏好卡。", {
      statusCode: 409,
      details: { profileId: plan.profileId, cardId: getSearchPlanDependency(db, plan.id).draftCardId }
    });
  }
  const pool = listDecisionPool(db, { planId });
  let retryIds = null;
  if (bulk && input.jobIds !== undefined) {
    const values = Array.isArray(input.jobIds) ? input.jobIds : String(input.jobIds).split(",");
    const ids = values.map(value => Number(value));
    if (!ids.length || ids.length > PRODUCT_POLICY.operations.modelAnalysis.maxRetryJobs
      || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error("待分析岗位清单无效。");
    const ownIds = new Set(pool.map(job => job.id));
    if (ids.some(id => !ownIds.has(id))) throw new Error("岗位不属于当前筛选方案。");
    retryIds = new Set(ids);
  }
  const requestedJobId = Number(input.jobId);
  const jobs = bulk
    ? pool.filter((job) => (!retryIds || retryIds.has(job.id)) && job.decisionBucket === "analysis_pending" && isJobAwaitingAction(job))
      .slice(0, PRODUCT_POLICY.operations.modelAnalysis.maxRetryJobs)
    : pool.filter((job) => job.id === requestedJobId);
  if (!jobs.length) throw new Error(bulk ? "当前没有待重试的语义分析岗位。" : "岗位不存在或不属于当前筛选方案。");
  const baseConfigs = loadConfigs(deps.root);
  baseConfigs.model = deps.modelConfig;
  const configs = profileToRuntimeConfigs(baseConfigs, matchingContext.candidateProfile, plan.plan, listMatchingResumeVersions(db, plan.profileId), matchingContext.matchingCard);
  const makeRunner = deps.createJobAnalysisRunner || createJobAnalysisRunner;
  const analyze = makeRunner(configs, plan.plan.keywords || [], { db, logger: deps.logger });
  const batchId = createBatch(db, jobs[0].source || "boss", bulk ? "analysis-retry-bulk" : "analysis-retry", bulk
    ? `analysis-retry-bulk:plan:${planId}:jobs:${jobs.length}`
    : `analysis-retry:plan:${planId}:job:${jobs[0].id}`, {
    profileId: plan.profileId,
    searchPlanId: planId,
    filterSnapshot: { mode: bulk ? "analysis-retry-bulk" : "analysis-retry", jobIds: jobs.map((job) => job.id) }
  });
  const concurrency = bulk ? PRODUCT_POLICY.operations.modelAnalysis.retryConcurrency : 1;
  const needsMessageContext = !bulk && deps.messageContextAnalysis === true;
  let configurationError = null;
  const recordConfigurationError = error => {
    const classified = classifyWorkflowAnalysisError(error);
    if (classified.kind !== "configuration") return null;
    configurationError ||= appError(classified.pauseCode === "MODEL_QUOTA_EXHAUSTED"
      ? "MODEL_QUOTA_EXHAUSTED" : "MODEL_CONFIGURATION_REQUIRED", "模型连接需要恢复，已完成的分析已保存，剩余岗位仍待分析。", { statusCode: 409 });
    return classified;
  };
  const results = await mapWithConcurrency(jobs, concurrency, async (job) => {
    if (configurationError) return null;
    const scored = scoreJob(job, configs);
    if (decisionState(scored) !== "ready" && !needsMessageContext) {
      return { job, scored, sourcePending: true, analysis: job.analysis };
    }
    let analysis;
    try {
      analysis = await analyze({ ...job, ...scored, greeting: job.greeting || "" }, { signal: deps.signal || null });
    } catch (error) {
      const classified = recordConfigurationError(error);
      if (!classified) throw error;
      analysis = { semanticStatus: "failed", decisionSource: "analysis_pending", errorCode: classified.code, error: "模型服务暂不可用。" };
    }
    if (analysis.semanticStatus === "failed") recordConfigurationError({ code: analysis.errorCode, httpStatus: analysis.errorHttpStatus });
    throwIfAborted(deps.signal);
    if (needsMessageContext && job.source === "zhaopin") {
      const sourceAvailability = job.analysis?.sourceAvailability === "offline" ? "offline" : "unknown";
      analysis = { ...analysis, sourceAvailability };
    }
    return { job, scored, sourcePending: false, analysis };
  });
  throwIfAborted(deps.signal);
  let completed = 0;
  let failed = 0;
  let sourcePending = 0;
  for (const result of results.filter(Boolean)) {
    throwIfAborted(deps.signal);
    // Persist the current local boundary even when it prevents a model call.
    // Otherwise the unchanged observation stays in the model retry queue.
    upsertJob(db, { ...result.job, ...result.scored, analysis: result.analysis, greeting: result.job.greeting || "" }, batchId);
    if (result.sourcePending) {
      sourcePending += 1;
      continue;
    }
    if (result.analysis.semanticStatus === "failed") failed += 1;
    else completed += 1;
  }
  reconcilePlanWorkflowInventory(db, planId);
  if (configurationError) throw configurationError;
  return {
    kind: bulk ? "bulk" : "one",
    planId,
    batchId,
    jobIds: jobs.map((job) => job.id),
    requested: jobs.length,
    completed,
    failed,
    sourcePending,
    concurrency,
    results
  };
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || Object.assign(new Error("message discovery stopped"), { code: "MESSAGE_DISCOVERY_STOPPED" });
}

module.exports = {
  retryOneJobAnalysis,
  retryPendingJobAnalyses
};

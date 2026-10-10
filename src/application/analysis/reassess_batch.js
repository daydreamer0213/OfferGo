const {
  getSearchPlan,
  getCandidateProfile,
  getCandidateMatchingContext,
  getSearchPlanDependency,
  listMatchingResumeVersions
} = require("../../storage/candidate_store");
const { reassessBatchObservations } = require("../../storage/job_store");
const { assertSearchPlanReady } = require("../../core/plan_validation");
const { profileToRuntimeConfigs } = require("../../core/search_plan");
const { createJobAnalysisRunner } = require("../../core/job_analysis");

async function reassessBatch({ db, batchId, planId, createConfigs, logger, cleanDescription }) {
  const planRecord = getSearchPlan(db, planId);
  if (!planRecord) throw new Error(`未找到 Search Plan #${planId}`);
  const profileRecord = getCandidateProfile(db, planRecord.profileId);
  if (!profileRecord) throw new Error(`Search Plan #${planId} 对应的候选人画像不存在。`);

  // 与扫描使用同一套已确认匹配上下文；未确认的新简历不能影响重评。
  const matchingContext = getCandidateMatchingContext(db, planRecord.profileId, { includeResumeEvidence: true });
  assertSearchPlanReady(
    planRecord,
    matchingContext?.candidateProfile || {},
    getSearchPlanDependency(db, planRecord.id),
    { acquisitionMode: "inherited" }
  );
  if (!matchingContext) throw new Error(`Search Plan #${planId} 缺少已确认匹配偏好卡对应的画像版本。`);

  const configs = profileToRuntimeConfigs(
    createConfigs(),
    matchingContext.candidateProfile,
    planRecord.plan,
    listMatchingResumeVersions(db, planRecord.profileId),
    matchingContext.matchingCard,
    { resumeEvidenceRecovery: matchingContext.resumeEvidenceRecovery }
  );
  const keywordPlan = (planRecord.plan.keywords || []).map((item) => ({ ...item }));
  const analyzeJob = createJobAnalysisRunner(configs, keywordPlan, { db, logger });
  return reassessBatchObservations(db, {
    batchId,
    planId,
    configs,
    analyzeJob,
    cleanDescription
  });
}

module.exports = { reassessBatch };

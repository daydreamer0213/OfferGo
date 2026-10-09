const { decisionState } = require('./scoring');
const { hardBoundaryReason } = require('./match_explainer');
const { decisionHardBlockers, hardBlockerText, isAbsentResumeEvidence } = require('./model_contract');
const { deriveMatrixDecision } = require('./four_tier_decision');
const { normalizeJobConditions, summarizeQualifications, projectCapabilityRequirements } = require('./job_match_conditions');
const { DECISION_POLICY, DECISION_POLICY_HASH, RECOMMENDATION_SCHEMA_VERSION, capRecommendationTier } = require('./decision_policy');

function decideJobMatch({ analysis, job = {} }) {
  const gate = decisionState(job);
  const conditions = analysis.conditionSchemaVersion === 1 ? analysis.conditions || []
    : normalizeJobConditions({ jobUnderstanding: { coreRequirements: (analysis.requirementMatches || [])
      .map((row, index) => ({ ...row, id: row.id || 'R' + (index + 1), label: row.requirement })) } });
  const conditionResults = analysis.conditionSchemaVersion === 1 ? analysis.conditionResults || []
    : conditions.map(condition => ({ conditionId: condition.id, state: (analysis.requirementMatches || [])
      .find((row, index) => (row.id || 'R' + (index + 1)) === condition.id)?.state || 'unknown' }));
  analysis = { ...analysis, requirementMatches: projectCapabilityRequirements({ conditions, conditionResults,
    selectedTrackId: analysis.selectedTrackId, requirementMatches: analysis.requirementMatches }), decisionReasons: [] };
  const qualityTags = new Set(job.qualityTags || []);

  // 一、本地已确认的基础边界不依赖模型语义，可直接排除。
  if (gate === "blocked") {
    const semanticStatus = analysis.semanticStatus === "complete" ? "complete" : "blocked";
    return addGuard(
      analysis,
      "not_recommended",
      "no_fit",
      hardBoundaryReason(job, qualityTags) || "具体筛选依据未保存，请核对岗位与筛选条件。",
      semanticStatus,
      "hard_boundary"
    );
  }

  // 二、技术失败和证据未完成不伪装成四档建议。模型 hardBlocker 与岗位风险
  // 可能来自失败或过期的分析对象，必须等语义状态完整后才能参与定档。
  if (gate === "refresh") {
    return needsRetry(analysis, "岗位信息需要刷新后重新分析。");
  }
  if (["failed", "stale", "pending"].includes(analysis.semanticStatus)) {
    return needsRetry(analysis);
  }
  if (analysis.semanticStatus === "partial") {
    return needsRetry(analysis, "当前只有卡片级信息，完整 JD 补齐前不进入判定。");
  }
  const qualification = analysis.conditionSchemaVersion === 1
    ? summarizeQualifications({ conditions: analysis.conditions, conditionResults: analysis.conditionResults, selectedTrackId: analysis.selectedTrackId })
    : null;
  if (qualification?.status === 'conflict') {
    const failed = (analysis.conditions || []).filter(condition => qualification.conflictIds.includes(condition.id));
    return addGuard({ ...analysis, qualificationStatus: qualification.status, qualification }, 'not_recommended', 'no_fit',
      `不符合岗位明确要求：${failed.map(condition => condition.label).join('；')}`, analysis.semanticStatus, 'qualification_conflict');
  }
  // 三、完整语义结果中的明确硬边界优先于加权匹配结果。
  const hardBlockers = decisionHardBlockers(analysis);
  if (hardBlockers.length) {
    return addGuard(
      { ...analysis, hardBlockers },
      "not_recommended",
      "no_fit",
      `存在不可沟通的硬性缺口：${hardBlockerText(hardBlockers[0])}`,
      analysis.semanticStatus,
      "hard_blocker_guard"
    );
  }
  if (analysis.jobQuality?.level === "risk") {
    return addGuard(
      analysis,
      "not_recommended",
      "no_fit",
      "岗位存在安全或合规风险，不建议投递。",
      analysis.semanticStatus,
      "job_quality_risk_guard"
    );
  }
  if (hasConfirmedPrimaryGap(analysis)) {
    return addGuard(analysis, "not_recommended", "no_fit",
      "岗位的主要工作和关键基础能力与目前经历有明确差距，暂不建议继续。",
      analysis.semanticStatus, "confirmed_primary_gap");
  }
  if (!DECISION_POLICY.matrix[analysis.roleAlignment]) {
    return needsRetry(analysis, "岗位方向证据不足，等待补充后重新判定。");
  }

  // 四、代码计算 70/30 加权结果并查四档二维表。模型 shadow 建议不参与。
  const decisionMetrics = deriveMatrixDecision({
    roleAlignment: analysis.roleAlignment,
    requirementMatches: analysis.requirementMatches,
    responsibilityMatches: analysis.responsibilityMatches
  });
  let guarded = {
    ...analysis,
    ...(qualification ? { qualificationStatus: qualification.status, qualification } : {}),
    recommendation: decisionMetrics.matrixRecommendation,
    decisionStatus: "decided",
    decisionSource: "weighted_decision_matrix",
    fitLevel: decisionMetrics.fitBand,
    decisionMetrics,
    recommendationSchemaVersion: RECOMMENDATION_SCHEMA_VERSION,
    decisionPolicyHash: DECISION_POLICY_HASH
  };

  // 五、已有产品安全信号只能向下封顶，不能反向提升。
  if (qualification?.status === 'unknown' && guarded.recommendation !== 'not_recommended') {
    const unresolved = (analysis.conditions || []).filter(condition => qualification.unresolvedIds.includes(condition.id));
    guarded = addGuard(guarded, capRecommendationTier(guarded.recommendation, 'caution'), guarded.fitLevel,
      `需要确认岗位资格：${unresolved.map(condition => condition.label).join('；')}`, guarded.semanticStatus, 'qualification_unknown');
  }
  if (qualityTags.has("eligibility_review") && guarded.recommendation !== "not_recommended") {
    guarded = addGuard(
      guarded,
      capRecommendationTier(guarded.recommendation, "caution"),
      guarded.fitLevel,
      "资格待确认：岗位存在届别或在校条件，需要确认后再决定。",
      guarded.semanticStatus,
      "eligibility_review_guard"
    );
  }
  if (qualityTags.has("experience_stretch") || qualityTags.has("experience_overrange") || qualityTags.has("experience_salary_overlap")) {
    guarded = capGuard(
      guarded,
      "apply",
      "岗位年限高于候选人当前经历，最高归入可投。",
      "experience_stretch_guard"
    );
  }
  if (qualityTags.has("salary_target_high") || qualityTags.has("experience_salary_overlap")) {
    guarded = capGuard(
      guarded,
      "caution",
      "岗位薪资或经验跨度需要先确认，最高归入慎投。",
      "salary_stretch_guard"
    );
  }
  if (hasTransferableIndispensable(analysis)) {
    guarded = capGuard(
      guarded,
      "apply",
      "核心硬性要求只有可迁移证据，最高归入可投。",
      "indispensable_transferable_guard"
    );
  }
  if (hasShadowResponsibilitySprawlCaution(analysis) && guarded.recommendation !== "not_recommended") {
    guarded = capGuard(
      guarded,
      "caution",
      "岗位存在职责发散，且模型语义建议慎投，最高归入慎投。",
      "model_quality_caution_guard"
    );
  }
  const materialRisk = (analysis.hiddenRisks || []).find((risk) => (
    risk?.type !== "responsibility_sprawl"
      && ["medium", "high"].includes(risk?.severity)
  ));
  if (materialRisk && guarded.recommendation !== "not_recommended") {
    const evidence = materialRisk.evidence ? `：${materialRisk.evidence}` : "";
    guarded = capGuard(
      guarded,
      "caution",
      `岗位存在需要先沟通确认的风险${evidence}`,
      "semantic_risk_guard"
    );
  }

  // 六、缺少双侧证据属于分析未完成，不进入四档。
  if (missingEitherSideEvidence(guarded)) {
    return needsRetry(guarded, "模型结论缺少可核对的双侧证据，标记待重试。", "model_evidence_gap");
  }

  return { ...guarded, decisionReasons: guarded.decisionReasons.length ? guarded.decisionReasons : [{
    code: 'weighted_decision_matrix', conditionIds: guarded.requirementMatches.map(row => row.id),
    explanation: '结合岗位的主要工作、核心能力要求与已有经历判断。'
  }] };
}

function hasConfirmedPrimaryGap(analysis) {
  if (analysis.roleAlignment !== 'insufficient_evidence') return false;
  const evidenceBound = item => String(item?.jdEvidence || '').trim()
    && String(item?.resumeEvidence || '').trim() && !isAbsentResumeEvidence(item.resumeEvidence);
  const duties = analysis.responsibilityMatches || [];
  const known = duties.filter(item => ['matched', 'transferable', 'missing'].includes(item.state) && evidenceBound(item));
  const policy = DECISION_POLICY.responsibilityAlignment;
  if (known.length < policy.minimumKnownCount || known.length / Math.max(1, duties.length) < policy.minimumKnownCoverage
    || known.some(item => item.state !== 'missing')) return false;
  const requirements = analysis.requirementMatches || [];
  if (requirements.some(item => (item.central || item.foundation || item.indispensable)
    && ['matched', 'transferable'].includes(item.state) && evidenceBound(item))) return false;
  return requirements.some(item => item.central === true && item.foundation === true && item.state === 'missing'
    && evidenceBound(item) && /不了解|不会|不能|不负责|未使用|没有.{0,24}(?:经历|经验)|由.{0,24}负责/.test(item.resumeEvidence));
}

function hasTransferableIndispensable(analysis) {
  return (analysis.requirementMatches || []).some((item) => (
    item?.state === "transferable" && item?.indispensable === true
  ));
}

function hasShadowResponsibilitySprawlCaution(analysis) {
  return analysis?.modelRecommendation === "caution"
    && analysis?.jobQuality?.level === "caution"
    && (analysis.jobQuality.concerns || []).some((concern) => concern?.type === "responsibility_sprawl");
}

function missingEitherSideEvidence(analysis) {
  const evidence = analysis.evidence || {};
  return !(evidence.jd || []).length || !(evidence.resume || []).length;
}

function addGuard(analysis, recommendation, fitLevel, reason, semanticStatus = analysis.semanticStatus, decisionSource = analysis.decisionSource) {
  return {
    ...analysis,
    semanticStatus,
    decisionReasons: [...(analysis.decisionReasons || []), { code: decisionSource,
      conditionIds: decisionSource === 'qualification_conflict' ? analysis.qualification?.conflictIds || []
        : decisionSource === 'qualification_unknown' ? analysis.qualification?.unresolvedIds || [] : [],
      explanation: reason }],
    decisionSource,
    recommendation,
    decisionStatus: "decided",
    fitLevel,
    fitReasons: [reason, ...(analysis.fitReasons || []).filter((item) => item && item !== reason)],
    ruleAdjusted: true
  };
}

function capGuard(analysis, cap, reason, decisionSource) {
  const recommendation = capRecommendationTier(analysis.recommendation, cap);
  if (recommendation === analysis.recommendation) return analysis;
  return addGuard(analysis, recommendation, analysis.fitLevel, reason, analysis.semanticStatus, decisionSource);
}

function needsRetry(analysis, reason = "", decisionSource = "needs_retry") {
  return {
    ...analysis,
    decisionReasons: [{ code: decisionSource, conditionIds: [], explanation: reason || '分析尚未完成，请稍后重试。' }],
    recommendation: null,
    decisionStatus: "needs_retry",
    decisionSource,
    fitLevel: null,
    decisionMetrics: null,
    fitReasons: reason
      ? [reason, ...(analysis.fitReasons || []).filter((item) => item && item !== reason)]
      : (analysis.fitReasons || []),
    ruleAdjusted: true
  };
}

module.exports = { decideJobMatch };

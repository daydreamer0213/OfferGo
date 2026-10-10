const assert = require("node:assert/strict");
const { applyRuleGuard, compactAnalysis } = require("../src/core/job_analysis");
const { PIPELINE_VERSIONS } = require("../src/core/analysis_revision");
const { decisionBucket } = require("../src/core/storage");

function requirement(requirementName, state, overrides = {}) {
  return {
    requirement: requirementName,
    state,
    foundation: false,
    central: false,
    indispensable: false,
    jdEvidence: `JD：${requirementName}`,
    resumeEvidence: state === "unknown" ? "" : `简历：${requirementName}`,
    ...overrides
  };
}

function analysis(overrides = {}) {
  return {
    semanticStatus: "complete",
    decisionSource: "model",
    roleAlignment: "aligned",
    requirementMatches: [
      requirement("核心交付", "matched", { foundation: true, central: true })
    ],
    hardBlockers: [],
    hiddenRisks: [],
    jobQuality: { level: "normal", concerns: [] },
    evidence: { jd: ["JD：核心交付"], resume: ["简历：核心交付"] },
    fitReasons: ["模型旧理由"],
    modelRecommendation: "not_recommended",
    confidence: 0.1,
    ...overrides
  };
}

for (const [state, expected] of [['conflict', 'not_recommended'], ['unknown', 'caution'], ['satisfied', 'primary']]) {
  const conditions = [{ id: 'E1', category: 'qualification', strength: 'mandatory', trackIds: ['T1'], label: '必须持有C1驾驶证' },
    { id: 'R1', category: 'capability', label: '核心交付', central: true, foundation: true }];
  const conditionResults = [{ conditionId: 'E1', category: 'qualification', state },
    { conditionId: 'R1', category: 'capability', state: 'matched' }];
  const result = applyRuleGuard(analysis({ conditionSchemaVersion: 1, selectedTrackId: 'T1', conditions, conditionResults }), {});
  assert.equal(result.recommendation, expected, `qualification ${state} must survive final scoring`);
  assert.equal(decisionBucket({ analysis: result }), expected);
  const compact = compactAnalysis({ model: { provider: 'test' }, semanticMatchingMode: 'split' }, {
    job: { description: '负责驾驶配送，并处理客户订单。', detailStatus: 'complete' },
    jobUnderstanding: {}, matchDecision: { conditions, conditionResults, qualificationStatus: state, conditionSchemaVersion: 1 }
  });
  assert.deepEqual(compact.conditionResults, conditionResults, 'compactAnalysis must preserve normalized qualification rows');
  assert.equal(compact.qualificationStatus, state);
}

const primary = applyRuleGuard(analysis(), {});
assert.equal(primary.recommendation, "primary",
  "最终档位必须来自代码二维表，不能被低置信度或 shadow 模型建议降级");
assert.equal(primary.modelRecommendation, "not_recommended",
  "shadow 建议必须保留用于对照");
assert.equal(primary.decisionSource, "weighted_decision_matrix");
assert.equal(primary.decisionMetrics.matrixRecommendation, "primary");
assert.equal(primary.decisionMetrics.combinedFit, 1);

const weightedApply = applyRuleGuard(analysis({
  roleAlignment: "mostly_aligned",
  requirementMatches: [
    requirement("核心交付", "transferable", { foundation: true, central: true }),
    requirement("持续协作", "matched")
  ]
}), {});
assert.equal(weightedApply.recommendation, "apply",
  "核心与支持项必须按 70/30 的本地权重进入二维表");

const zeroDutyGap = applyRuleGuard(analysis({
  roleAlignment: "partially_aligned",
  requirementMatches: [
    requirement("core delivery", "missing", { central: true }),
    requirement("adjacent collaboration", "transferable")
  ],
  responsibilityMatches: [
    { id: "D1", state: "transferable", jdEvidence: "JD: duty one", resumeEvidence: "Resume: transferable one" },
    { id: "D2", state: "transferable", jdEvidence: "JD: duty two", resumeEvidence: "Resume: transferable two" },
    { id: "D3", state: "unknown", jdEvidence: "JD: duty three", resumeEvidence: "" },
    { id: "D4", state: "unknown", jdEvidence: "JD: duty four", resumeEvidence: "" }
  ]
}), {});
assert.equal(zeroDutyGap.recommendation, "apply");
assert.equal(zeroDutyGap.decisionMetrics.responsibilityPromotionRoute, "zero_duty_gap");
assert.equal(zeroDutyGap.decisionMetrics.responsibilityZeroDutyGapPromotionReady, true);
assert.equal(zeroDutyGap.decisionMetrics.responsibilityMatchedIndispensablePromotionReady, false);
assert.equal(zeroDutyGap.decisionMetrics.responsibilityFoundationCeilingApplied, false);

const calibratedIndispensableBoundary = applyRuleGuard(analysis({
  roleAlignment: "partially_aligned",
  requirementMatches: [
    requirement("indispensable delivery", "matched", { indispensable: true }),
    requirement("required item two", "matched"),
    requirement("preferred item three", "missing"),
    requirement("bonus item four", "missing"),
    requirement("required item five", "matched"),
    requirement("central gap", "missing", { central: true }),
    requirement("central strength", "matched", { central: true }),
    requirement("required item eight", "transferable"),
    requirement("required item nine", "matched"),
    requirement("required item ten", "missing"),
    requirement("required item eleven", "missing"),
    requirement("required item twelve", "transferable"),
    requirement("required item thirteen", "missing")
  ],
  responsibilityMatches: [
    { id: "D1", state: "transferable", jdEvidence: "JD: duty one", resumeEvidence: "Resume: transferable one" },
    { id: "D2", state: "missing", jdEvidence: "JD: duty two", resumeEvidence: "Resume: confirmed gap two" },
    { id: "D3", state: "transferable", jdEvidence: "JD: duty three", resumeEvidence: "Resume: transferable three" },
    { id: "D4", state: "missing", jdEvidence: "JD: duty four", resumeEvidence: "Resume: confirmed gap four" }
  ]
}), {});
assert.equal(calibratedIndispensableBoundary.decisionMetrics.responsibilityRequirementJointFit, 0.47);
assert.equal(calibratedIndispensableBoundary.recommendation, "apply",
  "joint fit 0.47 with matched indispensable evidence must retain the recall-first opportunity");

const consistencyAdjusted = applyRuleGuard(analysis({
  roleAlignment: "misaligned",
  requirementMatches: [
    requirement("adjacent core delivery", "transferable", { foundation: true, central: true }),
    requirement("another core duty", "unknown", { foundation: true, central: true })
  ]
}), {});
assert.equal(consistencyAdjusted.recommendation, "caution");
assert.equal(consistencyAdjusted.roleAlignment, "misaligned",
  "raw model alignment must remain available for audit");
assert.equal(consistencyAdjusted.decisionMetrics.reportedRoleAlignment, "misaligned");
assert.equal(consistencyAdjusted.decisionMetrics.effectiveRoleAlignment, "partially_aligned");
assert.equal(consistencyAdjusted.decisionMetrics.alignmentConsistencyAdjusted, true);

const noFit = applyRuleGuard(analysis({
  roleAlignment: "partially_aligned",
  requirementMatches: [
    requirement("核心交付", "missing", { foundation: true, central: true })
  ]
}), {});
assert.equal(noFit.recommendation, "not_recommended");

const lowCoverage = applyRuleGuard(analysis({
  requirementMatches: [
    requirement("核心交付", "matched", { foundation: true, central: true }),
    requirement("关键协作", "unknown", { foundation: true, central: true })
  ]
}), {});
assert.equal(lowCoverage.recommendation, "caution",
  "证据覆盖率不足时不得进入默认勾选档");
assert.equal(lowCoverage.decisionMetrics.coverageCapped, true);

const blocked = applyRuleGuard(analysis({
  roleAlignment: "misaligned",
  hardBlockers: [{
    kind: "safety",
    requirement: "入职收费风险",
    jdEvidence: "JD：入职前支付培训费",
    resumeEvidence: "简历：候选人无法规避该收费要求"
  }]
}), {});
assert.equal(blocked.recommendation, "not_recommended");
assert.equal(blocked.decisionSource, "hard_blocker_guard",
  "a hard blocker must win before alignment consistency normalization");

const locallyBlockedComplete = applyRuleGuard(analysis(), {
  qualityTags: ["inactive_boss"]
});
assert.equal(locallyBlockedComplete.semanticStatus, "complete",
  "a completed semantic analysis must remain complete when a local hard boundary changes only the recommendation");
assert.equal(locallyBlockedComplete.recommendation, "not_recommended");
assert.equal(locallyBlockedComplete.decisionSource, "hard_boundary");
const locallyBlockedFailed = applyRuleGuard(analysis({ semanticStatus: "failed" }), {
  qualityTags: ["inactive_boss"]
});
assert.equal(locallyBlockedFailed.semanticStatus, "blocked",
  "a local hard boundary must not turn a failed semantic analysis into a completed result");

for (const semanticStatus of ["failed", "stale", "pending", "partial"]) {
  const technical = applyRuleGuard(analysis({ semanticStatus }), {});
  assert.equal(technical.recommendation, null,
    `${semanticStatus} 是技术状态，不得伪装成四档建议`);
  assert.equal(technical.decisionStatus, "needs_retry");
}

const staleBlocker = {
  kind: "safety",
  requirement: "过期的收费风险",
  jdEvidence: "JD：过期缓存中的收费描述",
  resumeEvidence: "简历：无法接受该收费要求"
};
for (const technicalAnalysis of [
  analysis({ semanticStatus: "failed", hardBlockers: [staleBlocker] }),
  analysis({ semanticStatus: "stale", jobQuality: { level: "risk", concerns: [] } })
]) {
  const guarded = applyRuleGuard(technicalAnalysis, {});
  assert.equal(guarded.recommendation, null,
    "技术未完成状态不得被缓存中的 hardBlocker 或 jobQuality 抢先定档");
  assert.equal(guarded.decisionStatus, "needs_retry");
  assert.equal(decisionBucket({ analysis: technicalAnalysis }), "analysis_pending",
    "技术未完成状态不得被缓存中的 hardBlocker 或 jobQuality 抢先分入不推荐");
}

const compact = compactAnalysis({
  model: { provider: "mock", providers: { mock: { model: "mock" } } },
  resumeVersions: {}
}, {
  job: { detailRead: true, description: "完整岗位描述" },
  jobUnderstanding: {
    coreRequirements: [],
    hiddenRisks: [],
    jobQuality: { level: "normal", concerns: [] }
  },
  matchDecision: {
    roleAlignment: "aligned",
    responsibilityMatches: [{
      id: "D1",
      state: "matched",
      jdEvidence: "JD: primary delivery",
      resumeEvidence: "Resume: primary delivery evidence"
    }],
    modelRecommendation: "apply",
    requirementMatches: [],
    hardBlockers: [],
    evidence: { jd: [], resume: [] }
  },
  ruleMatch: {},
  revision: {}
});
assert.equal(compact.modelRecommendation, "apply");
assert.deepEqual(compact.responsibilityMatches, [{
  id: "D1",
  state: "matched",
  jdEvidence: "JD: primary delivery",
  resumeEvidence: "Resume: primary delivery evidence"
}], "compact analysis must preserve responsibility evidence for the production decision path");

assert.equal(PIPELINE_VERSIONS.matchJob, "match-decision-v55-grounded-conditions");
assert.equal(PIPELINE_VERSIONS.decisionRules, "four-tier-weighted-v4.9-screening-v2-effect-conditions-v1");

const capabilityConditions = [
  { id: 'R1', label: '交付业务接口', category: 'capability', central: true, foundation: true },
  { id: 'R2', label: '编写自动化测试', category: 'capability' }
];
const capabilityResults = [
  { conditionId: 'R1', state: 'missing' }, { conditionId: 'R2', state: 'matched' }
];
const scoredCapabilities = analysis({ conditionSchemaVersion: 1, conditions: capabilityConditions,
  conditionResults: capabilityResults, requirementMatches: [
    requirement('交付业务接口', 'missing', { central: true, foundation: true }),
    requirement('编写自动化测试', 'matched')
  ] });
const withoutDegree = applyRuleGuard(scoredCapabilities, {});
const withDegree = applyRuleGuard({ ...scoredCapabilities,
  conditions: [...capabilityConditions, { id: 'R3', label: '本科及以上学历', category: 'qualification', strength: 'mandatory', central: true }],
  conditionResults: [...capabilityResults, { conditionId: 'R3', state: 'satisfied' }],
  requirementMatches: [...scoredCapabilities.requirementMatches, requirement('本科及以上学历', 'matched', { central: true })]
}, {});
assert.equal(withDegree.decisionMetrics.combinedFit, withoutDegree.decisionMetrics.combinedFit,
  '合格学历不能改变能力分或掩盖核心交付缺口');
assert.equal(withDegree.decisionMetrics.core.total, 1);
assert.equal(withDegree.requirementMatches.length, 2);
assert.deepEqual(withDegree.requirementMatches.map(row => row.requirement), ['交付业务接口', '编写自动化测试']);
assert.equal(withDegree.requirementMatches[1].resumeEvidence, '简历：编写自动化测试');
assert.ok(Array.isArray(withDegree.decisionReasons));

const degreeOnly = applyRuleGuard(analysis({ conditionSchemaVersion: 1,
  conditions: [{ id: 'R1', label: '本科及以上学历', category: 'qualification', strength: 'mandatory', central: true }],
  conditionResults: [{ conditionId: 'R1', state: 'satisfied' }],
  requirementMatches: [requirement('本科及以上学历', 'matched', { central: true })]
}), {});
assert.equal(degreeOnly.decisionMetrics.combinedFit, null, '只有学历不能推导职业能力充分匹配');
assert.equal(degreeOnly.recommendation, 'caution');
const preferences = applyRuleGuard(analysis({ conditionSchemaVersion: 1, conditions: [
  { id: 'R1', category: 'capability', label: '核心交付', central: true, foundation: true },
  { id: 'B1', category: 'preference', label: '行业背景', central: true, indispensable: true }
], conditionResults: [{ conditionId: 'R1', state: 'matched' }, { conditionId: 'B1', state: 'transferable' }]
}), {});
assert.equal(preferences.recommendation, 'primary', '偏好不能通过 indispensable 触发核心降档');
const legacyPreference = applyRuleGuard(analysis({ requirementMatches: [
  requirement('核心交付', 'matched', { central: true, foundation: true }),
  requirement('行业背景优先', 'transferable', { indispensable: true, central: true })
] }), {});
assert.equal(legacyPreference.recommendation, 'primary', '旧格式的优先条件也不能触发核心降档');
const punctuated = applyRuleGuard(analysis({ requirementMatches: [
  requirement('开发接口，优化查询', 'matched', { central: true, foundation: true })
] }), {});
assert.equal(punctuated.requirementMatches[0].resumeEvidence, '简历：开发接口，优化查询', '标签规范化不能丢失证据');
assert.equal(punctuated.requirementMatches[0].jdEvidence, 'JD：开发接口，优化查询');
assert.equal(punctuated.recommendation, 'primary');

console.log("four_tier_pipeline_smoke ok");

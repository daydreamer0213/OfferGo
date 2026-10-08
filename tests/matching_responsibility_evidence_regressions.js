const assert = require("node:assert/strict");
const { validateModelResult, evidenceFitReasons } = require("../src/core/model_contract");
const { applyRuleGuard } = require("../src/core/job_analysis");

// Replay the evidence fields recorded in jobs-first.json, backend-junior/job-3.
// Omission of validated duty evidence must not turn a complete decision into a retry.
const jobUnderstanding = {
  roleSummary: "主导微服务架构与 Kubernetes 生产集群治理，优化云成本并管理技术团队，交付高可用云基础设施。",
  responsibilityEvidence: ["JD：主导微服务架构与Kubernetes生产集群治理", "JD：负责云成本和团队技术管理"],
  coreRequirements: [{ id: "R1", label: "5年以上架构经验", foundation: true, central: false,
    indispensable: true, evidence: "JD：要求5年以上架构经验" }],
  jobQuality: { level: "normal", concerns: [] }
};
const raw = {
  roleAlignment: "misaligned",
  roleResumeEvidence: [
    "简历：云桥软件工作期间，使用Node.js、Fastify、PostgreSQL完成订单状态与发票导出接口，补充接口参数校验和错误处理。",
    "简历：在5人团队参与订单后台开发，个人完成订单状态与发票导出接口；前端与云环境由其他同事负责。"
  ],
  roleGaps: ["D1|work_object", "D2|main_action"],
  responsibilityMatches: [
    { id: "D1", state: "missing", resumeEvidence: "简历：云桥软件工作期间，使用Node.js、Fastify、PostgreSQL完成订单状态与发票导出接口，补充接口参数校验和错误处理。" },
    { id: "D2", state: "missing", resumeEvidence: "简历：在5人团队参与订单后台开发，个人完成订单状态与发票导出接口；前端与云环境由其他同事负责。" }
  ],
  matches: [{ id: "R1", state: "missing", resumeEvidence: "简历：2024.07-2026.09担任后端开发工程师，参与订单后台开发，个人完成接口开发与参数校验；未显示架构经验。" }],
  eligibility: []
};

function validate(value) {
  return validateModelResult("matchJob", value, { jobUnderstanding });
}
function guard(value) {
  return applyRuleGuard({ ...value, semanticStatus: "complete" }, {});
}
let failed = 0;
function check(name, run) {
  try { run(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
}

check("saved missing duty evidence completes the backend decision without changing unknown", () => {
  const result = validate(raw);
  assert.equal(result.requirementMatches[0].state, "unknown", "年限未证明仍是未知");
  assert.deepEqual(result.evidence.jd, jobUnderstanding.responsibilityEvidence);
  for (const item of raw.responsibilityMatches) assert(result.evidence.resume.includes(item.resumeEvidence));
  const decided = guard(result);
  assert.equal(decided.decisionStatus, "decided");
  assert.equal(decided.recommendation, "caution", "现有 misaligned/insufficient_evidence 档位保持不变");
  assert.equal(decided.fitLevel, "insufficient_evidence");
  assert.equal(decided.decisionSource, "weighted_decision_matrix");
});

for (const state of ["matched", "transferable"]) {
  check(`${state} duties provide bilateral evidence while requirements remain unknown`, () => {
    const result = validate({ ...raw, roleAlignment: "mostly_aligned", roleGaps: [], matches: [],
      responsibilityMatches: raw.responsibilityMatches.map(item => ({ ...item, state })) });
    assert.equal(result.requirementMatches[0].state, "unknown");
    assert.deepEqual(result.evidence.jd, jobUnderstanding.responsibilityEvidence);
    assert.equal(guard(result).decisionStatus, "decided");
  });
}

check("unknown duties do not invent bilateral evidence or unblock a retry", () => {
  const result = validate({ ...raw, roleAlignment: "mostly_aligned", roleGaps: [], matches: [],
    responsibilityMatches: raw.responsibilityMatches.map(item => ({ id: item.id, state: "unknown", resumeEvidence: "" })) });
  assert.deepEqual(result.evidence, { jd: [], resume: [] });
  assert.equal(result.requirementMatches[0].state, "unknown");
  assert.equal(guard(result).decisionStatus, "needs_retry");
  assert.equal(guard(result).recommendation, null);
});

check("a partial match explains evidenced duties without claiming the whole role", () => {
  const reasons = evidenceFitReasons({
    roleAlignment: 'partially_aligned',
    roleSummary: '设计运动控制算法、完成机器人动力学建模，并协助大模型测试',
    roleResumeEvidence: ['简历：完成知识库检索链路开发'],
    responsibilityMatches: [{ state: 'transferable', jdEvidence: 'JD：协助大模型测试', resumeEvidence: '简历：做过问答输出测试' }],
    fitReasons: ['旧解释：知识库检索经验能支持机器人动力学建模']
  });
  assert(reasons.some(reason => reason.includes('问答输出测试') && reason.includes('协助大模型测试')));
  assert(!reasons.some(reason => reason.includes('动力学建模')));
});
check("legacy explanations remain available without structured duty or requirement evidence", () => {
  assert.deepEqual(evidenceFitReasons({ fitReasons: ['已有相关开发经验'] }), ['已有相关开发经验']);
});

if (failed) process.exitCode = 1;
else console.log("matching_responsibility_evidence_regressions ok (6 checks)");

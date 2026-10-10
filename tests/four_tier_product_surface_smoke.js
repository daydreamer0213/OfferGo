const assert = require("node:assert/strict");
const { decisionBucket } = require("../src/core/storage");
const { workflowEligibility } = require("../src/core/workflow_inventory");
const { renderMarkdown } = require("../src/reports/render");

function job(recommendation, overrides = {}) {
  const { analysis: analysisOverrides = {}, ...jobOverrides } = overrides;
  return {
    source: "boss",
    url: "https://www.zhipin.com/job_detail/abc123.html",
    description: "完整岗位描述".repeat(24),
    bossActiveDays: 1,
    effectiveBossActiveDays: 1,
    qualityTags: [],
    risks: [],
    analysis: {
      semanticStatus: "complete",
      recommendation,
      roleAlignment: "aligned",
      requirementMatches: [],
      hardBlockers: [],
      ...analysisOverrides
    },
    ...jobOverrides
  };
}

assert.equal(decisionBucket(job("apply")), "primary",
  "历史 apply 必须在读取时解释为新主投");
assert.equal(decisionBucket(job("caution")), "apply",
  "历史 caution 必须在读取时解释为新可投");
assert.equal(decisionBucket(job("review")), "caution",
  "历史 review 必须在读取时解释为新慎投");
assert.equal(decisionBucket(job("skip")), "not_recommended",
  "历史 skip 必须在读取时解释为新不推荐");
assert.equal(decisionBucket(job("apply", {
  analysis: { recommendationSchemaVersion: 2 }
})), "apply",
  "新 schema 的 apply 必须保持可投，不能误升为主投");

assert.equal(decisionBucket(job(null, {
  analysis: { semanticStatus: "failed", decisionStatus: "needs_retry" }
})), "analysis_pending");

for (const tier of ["primary", "apply"]) {
  const result = workflowEligibility(job(tier, {
    analysis: { recommendationSchemaVersion: 2 }
  }), { now: "2026-08-01T00:00:00.000Z" });
  assert.equal(result.eligible, true, `${tier} 必须进入默认沟通候选池`);
  assert.equal(result.tier, tier);
}
const caution = workflowEligibility(job("caution", {
  analysis: { recommendationSchemaVersion: 2 }
}), { now: "2026-08-01T00:00:00.000Z" });
assert.equal(caution.eligible, false,
  "慎投不得计入默认沟通库存");
assert.equal(caution.reasonCode, "WORKFLOW_DECISION_CAUTION",
  "慎投必须保留明确的人工选择原因");

const markdown = renderMarkdown([{
  ...job("apply", { analysis: { recommendationSchemaVersion: 2 } }),
  score: 80,
  level: "可投",
  title: "测试岗位",
  company: "测试公司",
  location: "广州",
  salary: "面议",
  firstSeenAt: "2026-08-01",
  lastSeenAt: "2026-08-01"
}]);
assert(markdown.includes("可投"));
assert(!markdown.includes("|apply|"),
  "面向用户的报告必须显示中文四档，而不是内部枚举");

persistedDecisionJourney().then(() => console.log("four_tier_product_surface_smoke ok")).catch(error => {
  console.error(error.stack || error.message); process.exitCode = 1;
});

async function persistedDecisionJourney() {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const storage = require('../src/core/storage');
  const { getJob } = require('../src/storage/job_store');
  const { createJobAnalysisRunner } = require('../src/core/job_analysis');
  const { runtimeAnalysisContext } = require('../src/core/analysis_revision');
  const { isClearlyUnmatchedMessageJob } = require('../src/core/message_routing_policy');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'offergo-match-persistence-'));
  const databasePath = path.join(folder, 'jobs.sqlite');
  let db = storage.openDb(databasePath);
  const saved = [];
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    for (const [state, credential, expected] of [
      ['conflict', [{ name: 'C1驾驶证', held: false }], 'not_recommended'],
      ['unknown', [], 'caution'], ['satisfied', [{ name: 'C1驾驶证', held: true }], 'primary']
    ]) {
      const profile = { candidate: { name: `Synthetic ${state}`, targetTitles: ['查询开发工程师'] },
        education: [{ degree: '本科' }], credentials: credential,
        projects: [{ name: '查询系统', canSay: ['编写查询接口，并优化慢查询。'] }] };
      const searchPlan = { name: 'Synthetic plan', cities: ['广州'], directions: ['查询开发工程师'],
        keywords: [{ word: '查询开发工程师', priority: 'A' }] };
      const candidate = storage.saveProfileAnalysis(db, { profile, searchPlan,
        document: { originalFileName: `${state}.txt`, format: 'text', contentHash: state, text: '本科。编写查询接口，并优化慢查询。', diagnostics: {} } });
      const batchId = storage.createBatch(db, 'boss', '查询开发工程师', 'synthetic persistence', {
        profileId: candidate.profileId, searchPlanId: candidate.planId
      });
      const rawJob = { ...job(null), sourceId: `persistence-${state}`, title: '查询开发工程师', company: 'Synthetic Corp',
        location: '广州', salary: '面议', experience: '不限', education: '本科', tags: [],
        description: '必须持有C1驾驶证。负责查询接口开发；优化慢查询。'.repeat(8), detailRead: true, detailRequired: true };
      const configs = { model: { provider: 'openai_compatible', providers: { openai_compatible: { model: 'synthetic' } } },
        semanticMatchingMode: 'split', candidateProfile: profile, searchPlan, analysisContext: runtimeAnalysisContext(profile, searchPlan), scoring: {} };
      let calls = 0;
      const runner = createJobAnalysisRunner(configs, [], { db, analyzer: {
        understandJob: async () => { calls++; return { industryContext: '合成验收', hiringTracks: [{ id: 'T1', label: '查询开发', roleSummary: '查询开发',
          responsibilityEvidence: ['JD：负责查询接口开发', 'JD：优化慢查询'] }],
        requirements: [{ label: '查询接口开发', trackIds: ['T1'], central: true, foundation: true, indispensable: false,
          evidence: 'JD：负责查询接口开发' }], eligibility: [{ label: '必须持有C1驾驶证', evidence: 'JD：必须持有C1驾驶证',
          trackIds: [], alternatives: [{ allOf: [{ kind: 'credential', operator: 'has', value: 'C1驾驶证' }] }] }], riskSignals: [] }; },
        matchJob: async input => { calls++; const refs = [input.matchEvidence.entries.find(entry => entry.sourcePath === 'projects[0].canSay[0]').id];
          return { selectedTrackId: 'T1', roleAlignment: 'aligned', roleResumeEvidence: ['简历：编写查询接口，并优化慢查询。'], roleGaps: [],
            responsibilityMatches: ['D1', 'D2'].map(id => ({ id, state: 'matched', resumeEvidence: '简历：编写查询接口，并优化慢查询。', candidateEvidenceRefs: refs })),
            matches: [{ id: 'R1', state: 'matched', resumeEvidence: '简历：编写查询接口，并优化慢查询。', candidateEvidenceRefs: refs }], eligibility: [] }; }
      } });
      const analysis = await runner(rawJob);
      assert.equal(analysis.recommendation, expected, `${state}: ${analysis.error || analysis.fitReasons?.join('；')}`);
      assert.equal(analysis.qualificationStatus, state);
      assert.equal(calls, 2);
      const jobId = storage.upsertJob(db, { ...rawJob, analysis }, batchId);
      saved.push({ jobId, batchId, planId: candidate.planId, expected, state, analysis });
    }
    db.close(); db = storage.openDb(databasePath);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, version, '新判定不改变数据库版本');
    for (const item of saved) {
      const restored = getJob(db, item.jobId);
      assert.deepEqual(restored.analysis.conditions, item.analysis.conditions);
      assert.deepEqual(restored.analysis.conditionResults, item.analysis.conditionResults);
      assert.deepEqual(restored.analysis.decisionReasons, item.analysis.decisionReasons);
      assert.equal(storage.decisionBucket(restored), item.expected);
      assert.equal(storage.listDecisionPool(db, { planId: item.planId })[0].decisionBucket, item.expected);
      assert.equal(workflowEligibility(restored, { now: new Date().toISOString() }).eligible, item.expected === 'primary');
      assert.equal(isClearlyUnmatchedMessageJob(restored), item.expected === 'not_recommended');
    }
    const old = saved.at(-1), original = getJob(db, old.jobId);
    const historical = { ...original.analysis, revision: { ...original.analysis.revision,
      pipelineVersions: { ...original.analysis.revision.pipelineVersions, matchJob: 'match-decision-v45-graduation-window' } } };
    const historicalId = storage.upsertJob(db, { ...original, sourceId: 'historical-decision', analysis: historical }, old.batchId);
    const before = db.prepare('SELECT analysis_json FROM jobs WHERE id = ?').get(historicalId).analysis_json;
    const read = getJob(db, historicalId);
    assert.equal(read.analysis.semanticStatus, 'stale', '旧匹配版本不能直接进入当前活动池');
    assert.equal(read.analysis.recommendation, 'primary', '旧判断保留用于历史展示');
    assert.equal(storage.decisionBucket(read), 'analysis_pending');
    assert.equal(workflowEligibility(read, { now: new Date().toISOString() }).eligible, false);
    assert.equal(db.prepare('SELECT analysis_json FROM jobs WHERE id = ?').get(historicalId).analysis_json, before, '读取不能改写历史 JSON');
    const unversioned = { ...original.analysis }; delete unversioned.revision;
    const unversionedId = storage.upsertJob(db, { ...original, sourceId: 'unversioned-decision', analysis: unversioned }, old.batchId);
    assert.equal(getJob(db, unversionedId).analysis.semanticStatus, 'stale', '无版本历史分析不能直接进入当前活动池');
    assert.equal(getJob(db, unversionedId).analysis.recommendation, 'primary');
  } finally { db.close(); fs.rmSync(folder, { recursive: true, force: true }); }
}

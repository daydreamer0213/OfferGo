const assert = require('node:assert/strict');
const path = require('node:path');
const { createJobAnalysisRunner, cachedModelCall } = require('../src/core/job_analysis');
const { scoreJob } = require('../src/core/scoring');
const { presentWorkMatchInput, validateWorkMatchOutput } = require('../src/core/job_work_matching');
const { openDb, saveProfileAnalysis, createBatch } = require('../src/core/storage');
const { upsertJob, getJob, decisionBucket, rescorePlanObservations, listReportJobs } = require('../src/storage/job_store');
const { projectMessageDecisionCard } = require('../src/core/message_discovery');
const { loadConfigs } = require('../src/config');

const configs = loadConfigs(path.resolve(__dirname, '..'));
configs.profile = { location: { target_cities: ['广州'] }, candidate: { target_roles: ['后端开发'] } };
configs.model = { provider: 'fixture', model: 'whole-jd-fixture' };
configs.candidateProfile = { candidate: { city: '广州', targetTitles: ['后端开发'] },
  education: [{ degree: '本科', major: '电子信息工程', endDate: '2024-06', status: '已毕业' }],
  source: { resumeEvidenceText: '已独立实现订单接口、数据库设计和索引优化，负责接口测试与问题定位。' },
  experiences: [], skills: [], projects: [], credentials: [], strengths: [] };
configs.targetPolicy = { jobTypes: ['全职'], directions: ['后端开发'] };
const description = '同时招聘两个独立方向。算法方向仅限2027届硕士在校生，负责模型训练和效果评估。社会招聘后端方向，负责订单和库存业务接口开发、数据库设计和索引优化、接口自动化测试、日志监控、上线问题定位及客户系统对接；要求本科或相关专业，具备业务接口交付经验，与产品和测试团队合作完成稳定的业务系统。';
const job = { source: 'zhaopin', sourceId: 'whole-jd-one', title: '研发工程师', location: '广州',
  salary: '10-15K', experience: '经验不限', education: '本科', description, qualityTags: [], tags: [] };
let requests = 0, tier = 'primary', lastInput;
const analyzer = {
  async understandJob() { throw Error('Whole JD must not use the old split understanding'); },
  async matchJob() { throw Error('Whole JD must not use the old split matching'); },
  async selectJob(input) {
    requests++; lastInput = input;
    const payload = presentWorkMatchInput(input);
    const jd = Object.keys(payload.sourceIndex).find(id => payload.sourceIndex[id].path === 'originalJob.description');
    const candidate = Object.keys(payload.sourceIndex).find(id => payload.sourceIndex[id].path === 'candidateProfile.resumeEvidenceText');
    return validateWorkMatchOutput({ selectedWork: { summary: '社会招聘后端订单接口与数据库交付', jdEvidenceRefs: [jd] },
      supportingEvidenceRefs: [candidate], materialConsiderations: [{ description: 'JD 中算法方向与本次选择的社会招聘后端方向分开。',
        jdEvidenceRefs: [jd], candidateEvidenceRefs: [] }], modelRecommendation: tier,
      decisionExplanation: '社会招聘后端方向有直接的接口和数据库交付支持，值得投递。' }, input);
  }
};
async function main() {
  const db = openDb(':memory:');
  try {
    assert.equal(configs.semanticMatchingMode, 'whole_jd');
    const scored = scoreJob(job, configs);
    assert(!scored.qualityTags.includes('cohort_mismatch'));
    assert(!scored.qualityTags.includes('student_status_mismatch'));
    assert(scored.jdScopeSignals.qualityTags.includes('cohort_mismatch'));
    assert.notEqual(scored.eligibilityStatus, 'blocked', 'Branch qualifications cannot penalize the entire JD');
    assert(!scored.risks.some(reason => /毕业年份不符合|仅面向在校/.test(reason)));
    const analyze = createJobAnalysisRunner(configs, [], { db, analyzer });
    const result = await analyze(job);
    assert.equal(requests, 1);
    assert.equal(result.recommendation, 'primary');
    assert.equal(result.decisionSource, 'model_work_match');
    assert.equal(result.fitLevel, null, 'Do not invent a weighted score for the new method');
    assert.equal(lastInput.originalJob.description, description);
    assert.deepEqual(lastInput.searchPreferences.cities, ['广州']);
    assert.deepEqual(lastInput.searchPreferences.jobTypes, ['全职']);
    assert.equal(lastInput.candidateProfile.resumeEvidenceText, configs.candidateProfile.source.resumeEvidenceText);
    assert.match(lastInput.runtimeContext.analysisAsOfDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal((await analyze(job)).recommendation, 'primary');
    assert.equal(requests, 1, 'Canonical source-bound cache must be reused');
    await testPriorWorkMethodRefresh(lastInput, result);

    for (const expected of ['primary', 'apply', 'caution', 'not_recommended']) {
      tier = expected;
      const caseJob = { ...job, sourceId: 'tier-' + expected };
      const analysis = await analyze(caseJob);
      assert.equal(analysis.recommendation, expected);
      const storedId = upsertJob(db, { ...caseJob, ...scoreJob(caseJob, configs), analysis });
      const stored = getJob(db, storedId);
      assert.equal(stored.analysis.recommendation, expected);
      assert.equal(decisionBucket(stored), expected);
      assert.equal(require('../src/core/decision_policy').defaultSelectedForBatch(decisionBucket(stored)),
        ['primary', 'apply'].includes(expected), 'Only the actual primary/apply recommendations receive default selection');
      const card = projectMessageDecisionCard(stored);
      assert.equal(card.roleSummary, analysis.roleSummary);
      assert.equal(card.fitSummary, analysis.decisionExplanation);
      const brief = require('../src/core/mock_interview').buildInterviewBrief({ sessionKind: 'job_specific', job: stored });
      assert.equal(brief.jobFocus.role, analysis.roleSummary);
      assert.equal(brief.jobFocus.recommendation, expected);
      assert.equal(brief.jobFocus.decisionExplanation, analysis.decisionExplanation);
      assert.deepEqual(brief.jobFocus.materialConsiderations, analysis.materialConsiderations);
      assert.deepEqual(brief.jobFocus.roleResumeEvidence, analysis.roleResumeEvidence);
    }
    const before = requests;
    const excluded = await analyze({ ...job, sourceId: 'outside-city', location: '佛山' });
    assert.equal(excluded.recommendation, 'not_recommended');
    assert.equal(excluded.decisionSource, 'hard_boundary');
    assert.equal((await analyze({ ...job, sourceId: 'short', description: '负责订单接口开发' })).recommendation, null);
    assert.equal((await analyze({ ...job, sourceId: 'intern', title: '后端实习生' })).recommendation, 'not_recommended');
    assert.equal((await analyze({ ...job, sourceId: 'detail', detailRequired: true, detailRead: false })).recommendation, null);
    assert.equal((await analyze({ ...job, sourceId: 'detail-tag', qualityTags: ['detail_unverified'] })).recommendation, null);
    assert.equal((await analyze({ ...job, sourceId: 'aged', qualityTags: ['stale_or_unknown_active'] })).recommendation, null);
    assert.equal(requests, before, 'Boundaries and incomplete JD must not request a model');

    const mixedJob = { ...job, sourceId: 'independent-intern-and-fulltime', description:
      description.replace('算法方向仅限2027届硕士在校生', '算法方向是实习生岗位，仅限2027届硕士在校生')
        .replace('社会招聘后端方向', '社会招聘后端全职方向') };
    assert.equal((await analyze(mixedJob)).semanticStatus, 'complete');
    assert.equal(requests, before + 1, 'An independent internship option cannot exclude an advertised full-time option');
    const internshipOnly = { ...job, sourceId: 'intern-description', description:
      '岗位为实习生岗位，要求每周到岗4天，实习至少6个月。负责订单接口开发、数据库设计和索引优化、接口测试与日志问题定位，协助正式员工完成需求与上线支持，实习期结束后表现合格可转正为全职岗位。该岗位面向在校学生，需学校提供在读证明及实习时间安排。' };
    assert.equal((await analyze(internshipOnly)).recommendation, 'not_recommended');
    assert.equal(requests, before + 1, 'A future conversion does not create a current full-time option');
    for (const recruitingWork of ['社会招聘', '校园招聘', '全职岗位招聘']) {
      const recruitingIntern = { ...internshipOnly, sourceId: 'recruiting-intern-' + recruitingWork,
        title: '招聘助理', description: '本岗位为实习生岗位，面向在校学生，要求每周到岗4天，实习至少6个月。主要工作是协助' + recruitingWork
          + '，负责候选人筛选、简历整理、面试邀约和信息维护，与业务负责人核对岗位需求，并跟进招聘进度、汇总招聘数据和安排入职材料。协助人事团队维护候选人沟通记录和招聘渠道。' };
      assert.equal((await analyze(recruitingIntern)).recommendation, 'not_recommended');
    }
    assert.equal(requests, before + 1, 'Recruitment duties are not an independently offered full-time option');

    for (const context of [{ candidateProfile: { ...configs.candidateProfile, source: {} } },
      { resumeEvidenceRecovery: { status: 'unavailable', reasonCode: 'DOCUMENT_HASH_MISMATCH' },
        candidateProfile: { ...configs.candidateProfile, source: { resumeEvidenceText: '已截断的旧资料'.repeat(200).slice(0, 1000) } } }]) {
      const incomplete = createJobAnalysisRunner({ ...configs, ...context }, [], { analyzer });
      const pending = await incomplete(job);
      assert.equal(pending.recommendation, null);
      assert.equal(pending.matchStatus, 'material_missing');
      assert.equal(pending.decisionStatus, 'needs_material');
      assert.equal(pending.errorCode, 'CANDIDATE_RESUME_EVIDENCE_UNAVAILABLE');
    }
    assert.equal(requests, before + 1, 'Missing or failed-restoration resume must not invoke the model');
    assert.equal(require('../src/core/workflow_analysis_executor').classifyWorkflowAnalysisError({
      code: 'CANDIDATE_RESUME_EVIDENCE_UNAVAILABLE'
    }).pauseCode, 'CANDIDATE_RESUME_EVIDENCE_UNAVAILABLE');

    const failed = await createJobAnalysisRunner(configs, [], { analyzer: { async selectJob() {
      throw Object.assign(new Error('bad JSON'), { code: 'MODEL_INVALID_JSON', modelRepairHandled: true });
    } } })(job);
    assert.equal(failed.semanticStatus, 'failed');
    assert.equal(failed.recommendation, null);
    assert.equal(failed.errorCode, 'MODEL_INVALID_JSON');
    console.log('whole_jd_analysis_smoke passed');
  } finally { db.close(); }
}
async function testPriorWorkMethodRefresh(input, previous) {
  const db = openDb(':memory:');
  try {
    const priorVersion = 'whole-jd-work-v1-source-bound';
    const oldSelection = Object.fromEntries(['selectedWork', 'supportingEvidenceRefs',
      'materialConsiderations', 'modelRecommendation', 'decisionExplanation'].map(key => [key, previous[key]]));
    await cachedModelCall({ db, configs, kind: 'selectJob', pipelineVersion: priorVersion,
      input, run: async () => oldSelection });
    const oldAnalysis = { ...previous, revision: { ...previous.revision,
      pipelineVersions: { ...previous.revision.pipelineVersions, selectJob: priorVersion } } };
    const { profileId, planId } = saveProfileAnalysis(db, {
      profile: configs.candidateProfile,
      document: { originalFileName: 'whole-jd.txt', format: 'text', contentHash: 'whole-jd-refresh',
        text: configs.candidateProfile.source.resumeEvidenceText, diagnostics: {} },
      searchPlan: { name: 'Whole JD refresh', cities: ['广州'], directions: ['后端开发'], keywords: ['后端开发'] }
    });
    const batchId = createBatch(db, 'zhaopin', '后端开发', 'whole-jd-refresh', { profileId, searchPlanId: planId });
    const id = upsertJob(db, { ...job, ...scoreJob(job, configs), analysis: oldAnalysis }, batchId);
    const before = requests;
    tier = 'apply';
    const analyze = createJobAnalysisRunner(configs, [], { db, analyzer });
    assert.equal((await analyze(job)).recommendation, 'apply',
      'The corrected work method must not reuse an old source-bound decision');
    assert.equal(requests, before + 1, 'A previous-method cache entry must miss');
    assert.equal((await analyze(job)).recommendation, 'apply');
    assert.equal(requests, before + 1, 'The new-method cache remains reusable');
    const oldStored = getJob(db, id).analysis;
    assert.equal(oldStored.semanticStatus, 'stale');
    assert(oldStored.staleReasons.includes('work_matching_pipeline_changed'));
    assert.equal(oldStored.recommendation, 'primary', 'Reading stale history must preserve its original recommendation');
    assert.equal(JSON.parse(db.prepare('SELECT analysis_json FROM jobs WHERE id = ?').get(id).analysis_json).recommendation,
      'primary', 'Refresh projection must not rewrite the old saved decision');
    for (let repeat = 0; repeat < 2; repeat++) {
      rescorePlanObservations(db, { planId, configs });
      const observation = JSON.parse(db.prepare('SELECT analysis_json FROM job_observations WHERE job_id = ?').get(id).analysis_json);
      assert.equal(observation.recommendation, 'primary', 'New-workflow rescore must preserve the old whole-JD recommendation');
      assert.equal(observation.semanticStatus, 'stale');
      assert.equal(observation.decisionStatus, 'needs_retry');
      assert.deepEqual(observation.staleReasons, ['work_matching_pipeline_changed']);
      assert.deepEqual(observation.selectedWork, oldAnalysis.selectedWork);
      assert.equal(observation.decisionExplanation, oldAnalysis.decisionExplanation);
      const report = listReportJobs(db, { planId, limit: 10 }).find(row => row.id === id);
      assert.equal(report.analysis.recommendation, 'primary');
      assert.equal(report.decisionBucket, 'analysis_pending');
      assert.equal(require('../src/core/decision_policy').defaultSelectedForBatch(report.decisionBucket), false);
    }
    const currentAnalysis = await analyze(job);
    upsertJob(db, { ...job, ...scoreJob(job, configs), analysis: currentAnalysis }, batchId);
    const legacyId = upsertJob(db, { ...job, sourceId: 'legacy-split', ...scoreJob(job, configs),
      analysis: { ...currentAnalysis, semanticMatchingMode: 'split', revision: { ...currentAnalysis.revision,
        semanticMatchingMode: 'split', pipelineVersions: { ...currentAnalysis.revision.pipelineVersions, matchJob: 'legacy-match' } } } }, batchId);
    rescorePlanObservations(db, { planId, configs });
    const report = listReportJobs(db, { planId, limit: 10 });
    const current = report.find(row => row.id === id);
    assert.equal(current.analysis.semanticStatus, 'complete');
    assert.equal(current.analysis.recommendation, 'apply');
    assert.equal(current.decisionBucket, 'apply');
    assert.equal(require('../src/core/decision_policy').defaultSelectedForBatch(current.decisionBucket), true);
    const legacy = report.find(row => row.id === legacyId);
    assert.equal(legacy.analysis.semanticStatus, 'stale');
    assert.equal(legacy.analysis.recommendation, null, 'Legacy stale handling must remain unchanged');
    assert.equal(legacy.decisionBucket, 'analysis_pending');
    assert.equal(requests, before + 1, 'Rescoring must not trigger a new model request');
  } finally { db.close(); tier = 'primary'; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

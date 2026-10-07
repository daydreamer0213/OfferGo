const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const storage = require('../src/core/storage');
const onboarding = require('../src/storage/onboarding_store');
const { processOnboardingRun } = require('../src/application/onboarding/run');
const { runAgentOnboarding, confirmAgentMatchingCard } = require('../src/application/onboarding/agent_onboarding');
const { parseResumeText } = require('../src/core/resume_parser');

function resume(title, extra = '') {
  return parseResumeText({ fileName: 'candidate.txt', text: `姓名：测试候选人\n求职意向：${title}\n教育经历：信息管理本科。\n工作经历：参与相关项目并完成测试，与同事整理需求、记录反馈和核对交付结果，未独立管理预算。\n项目经历：负责资料整理、基础分析和协作沟通，按任务记录完成验收。\n${extra}` });
}
function profile(title) {
  return { candidate: { name: '候选人', targetTitles: [title] }, skills: [], projects: [], education: [], experiences: [] };
}
function runtime(title) {
  return {
    analyzeResume: async () => profile(title),
    buildMatchingCard: async ({ profile: input }) => ({ targetDirections: input.candidate.targetTitles,
      strongEvidence: [{ label: '参与项目', evidence: '参与相关项目并完成测试' }], transferableCapabilities: [], cautionTransitions: [] }),
    recommendPlan: async ({ profile: input }) => ({ name: `${input.candidate.targetTitles[0]}方案`,
      directions: input.candidate.targetTitles, keywords: [{ word: input.candidate.targetTitles[0], priority: 'A' }], cities: [] })
  };
}
async function start(db, document, title, profileId = null) {
  const { run } = onboarding.createOnboardingRun(db, { profileId, document, operationId: randomUUID() });
  return processOnboardingRun({ db, runId: run.id, ...runtime(title) });
}

async function changedResume(db) {
  const firstDocument = resume('产品经理');
  const first = await start(db, firstDocument, '产品经理');
  confirmAgentMatchingCard({ db, profileId: first.profileId, cardId: first.matchingCardId });
  const secondDocument = resume('Java后端开发', '补充经历：Java订单接口开发。');
  const second = await start(db, secondDocument, 'Java后端开发', first.profileId);
  assert.notEqual(second.profileVersionId, first.profileVersionId);
  const card = storage.getMatchingCard(db, second.matchingCardId);
  const plan = storage.getSearchPlan(db, second.searchPlanId);
  assert.equal(card.profileVersionId, second.profileVersionId);
  assert.equal(card.resumeContentHash, secondDocument.contentHash);
  assert.equal(plan.profileVersionId, second.profileVersionId, 'a newly analyzed resume must not reuse the old active plan');
  assert.deepEqual(plan.plan.directions, ['Java后端开发']);
  assert.equal(storage.getActiveSearchPlan(db, first.profileId).id, first.searchPlanId, 'a pending new card must preserve the confirmed active plan');
  assert.equal(plan.isActive, false);
  const decoyId = storage.saveSearchPlan(db, { profileId: second.profileId, profileVersionId: second.profileVersionId,
    plan: { name: '同版本未关联方案', directions: ['其他方向'] }, activate: false });
  db.exec(`CREATE TRIGGER fail_prepared_plan_activation BEFORE UPDATE OF is_active ON search_plans
    WHEN NEW.id = ${second.searchPlanId} AND NEW.is_active = 1
    BEGIN SELECT RAISE(ABORT, 'activation failed'); END`);
  assert.throws(() => confirmAgentMatchingCard({ db, profileId: second.profileId, cardId: second.matchingCardId }), /activation failed/);
  assert.equal(storage.getActiveMatchingCard(db, first.profileId).id, first.matchingCardId);
  assert.equal(storage.getMatchingCard(db, second.matchingCardId).status, 'draft');
  assert.equal(storage.getActiveSearchPlan(db, first.profileId).id, first.searchPlanId, 'failed activation must roll back the card and plan together');
  db.exec('DROP TRIGGER fail_prepared_plan_activation');
  confirmAgentMatchingCard({ db, profileId: second.profileId, cardId: second.matchingCardId });
  assert.equal(storage.getActiveSearchPlan(db, second.profileId).id, second.searchPlanId, 'confirmation must activate the run-bound plan, not a later same-version plan');
  assert.equal(storage.getSearchPlan(db, decoyId).isActive, false);
  assert.equal(storage.getSearchPlanDependency(db, second.searchPlanId).stale, false,
    'confirming the returned new card must leave its returned plan usable');
  const editedPlanId = storage.saveSearchPlan(db, { profileId: second.profileId, profileVersionId: second.profileVersionId,
    plan: { name: '确认后的手工方案', directions: ['Java后端开发'] } });
  confirmAgentMatchingCard({ db, profileId: second.profileId, cardId: second.matchingCardId });
  assert.equal(storage.getActiveSearchPlan(db, second.profileId).id, editedPlanId, 'idempotent confirmation must preserve a later explicit plan choice');
}

async function restoredCheckpoint(db) {
  const firstDocument = resume('产品经理');
  const { run } = onboarding.createOnboardingRun(db, { document: firstDocument, operationId: randomUUID() });
  const partial = await processOnboardingRun({ db, runId: run.id, ...runtime('产品经理'),
    recommendPlan: async () => { throw Object.assign(new Error('plan timeout'), { code: 'MODEL_TIMEOUT' }); } });
  assert.equal(partial.searchPlanId, null);
  onboarding.failOnboardingRun(db, partial.id, { code: 'MODEL_TIMEOUT', message: 'interrupted checkpoint' });
  const secondDocument = resume('Java后端开发');
  const latest = storage.saveProfileAnalysis(db, { profileId: partial.profileId,
    profile: profile('Java后端开发'), document: secondDocument, searchPlan: null });
  assert.notEqual(latest.profileVersionId, partial.profileVersionId);
  let planInput;
  const result = await runAgentOnboarding({ db, operationId: partial.id, document: firstDocument,
    runtimeDependencies: { ...runtime('产品经理'),
      analyzeResume: async () => { throw new Error('the completed profile checkpoint must not be analyzed again'); },
      recommendPlan: async input => { planInput = input.profile; return runtime('产品经理').recommendPlan(input); } } });
  assert.deepEqual(planInput.candidate.targetTitles, ['产品经理'], 'retry must load the exact saved profile version, not the latest mutable profile');
  assert.equal(result.profileVersionId, partial.profileVersionId);
  assert.deepEqual(result.profile.profile.candidate.targetTitles, ['产品经理'], 'the Agent result must describe the same version as its card and plan');
  assert.equal(result.profile.sourceHash, firstDocument.contentHash);
  assert.deepEqual(result.searchPlan.plan.directions, ['产品经理']);
  assert.equal(result.searchPlan.profileVersionId, partial.profileVersionId);
  assert.deepEqual(storage.getCandidateProfile(db, partial.profileId).profile.candidate.targetTitles, ['Java后端开发'],
    'restoring an old checkpoint must not overwrite the latest saved profile');
}

async function sameContentDifferentVersion(db) {
  const document = resume('产品经理');
  const first = await start(db, document, '产品经理');
  confirmAgentMatchingCard({ db, profileId: first.profileId, cardId: first.matchingCardId });
  // An explicit new analysis can use another document row with the exact same hash.
  const second = await start(db, document, '产品经理', first.profileId);
  assert.notEqual(second.resumeDocumentId, first.resumeDocumentId);
  assert.notEqual(second.profileVersionId, first.profileVersionId);
  assert.equal(storage.getMatchingCard(db, second.matchingCardId).profileVersionId, second.profileVersionId,
    'same content reanalysis must not attach a card from a different profile version');
  assert.equal(storage.getSearchPlan(db, second.searchPlanId).profileVersionId, second.profileVersionId);
  assert.equal(storage.getActiveSearchPlan(db, first.profileId).id, first.searchPlanId);
  const refresh = await runAgentOnboarding({ db, operationId: randomUUID(), document,
    refreshProfile: true, runtimeDependencies: runtime('产品经理') });
  assert.equal(refresh.reused, false, 'explicit Agent refresh still analyzes the resume again');
  const planCount = db.prepare('SELECT COUNT(*) AS count FROM search_plans').get().count;
  const activeBeforeReuse = storage.getActiveSearchPlan(db, first.profileId).id;
  const reuse = await runAgentOnboarding({ db, operationId: randomUUID(), document,
    runtimeDependencies: { analyzeResume: async () => { throw new Error('unchanged resume must reuse saved output'); } } });
  assert.equal(reuse.reused, true);
  assert.notEqual(reuse.run.resumeDocumentId, refresh.run.resumeDocumentId, 'a bound operation can have another same-hash document row');
  assert.equal(reuse.profileVersionId, refresh.profileVersionId);
  assert.equal(reuse.matchingCardId, refresh.matchingCardId);
  assert.equal(reuse.searchPlanId, refresh.searchPlanId);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM search_plans').get().count, planCount);
  assert.equal(storage.getActiveSearchPlan(db, first.profileId).id, activeBeforeReuse);
  confirmAgentMatchingCard({ db, profileId: refresh.profileId, cardId: refresh.matchingCardId });
  assert.equal(storage.getActiveSearchPlan(db, first.profileId).id, activeBeforeReuse, 'confirming another candidate must preserve the first candidate plan');
}

async function manualCard(db) {
  const first = await start(db, resume('产品经理'), '产品经理');
  confirmAgentMatchingCard({ db, profileId: first.profileId, cardId: first.matchingCardId });
  const document = resume('Java后端开发');
  const saved = storage.saveProfileAnalysis(db, { profileId: first.profileId, document, profile: profile('Java后端开发'), searchPlan: null });
  const manual = storage.createMatchingCardDraft(db, { profileId: first.profileId, profileVersionId: saved.profileVersionId, resumeDocumentId: saved.resumeDocumentId,
    resumeContentHash: document.contentHash, card: { targetDirections: ['Java后端开发'] } });
  storage.saveSearchPlan(db, { profileId: first.profileId, profileVersionId: saved.profileVersionId,
    plan: { name: '未关联手工卡', directions: ['Java后端开发'] }, activate: false });
  storage.confirmMatchingCard(db, { profileId: first.profileId, cardId: manual.id });
  assert.equal(storage.getActiveSearchPlan(db, first.profileId).id, first.searchPlanId, 'a non-onboarding card must not guess a plan by version');
}

(async () => {
  const failures = [];
  for (const scenario of [changedResume, restoredCheckpoint, sameContentDifferentVersion, manualCard]) {
    const db = storage.openDb(':memory:');
    try { await scenario(db); console.log(`${scenario.name}: ok`); }
    catch (error) { failures.push(error); console.error(`${scenario.name}: ${error.stack}`); }
    finally { db.close(); }
  }
  if (failures.length) process.exitCode = 1;
  else console.log('onboarding_version_consistency_smoke ok');
})();

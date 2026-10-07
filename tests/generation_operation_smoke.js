const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const storage = require('../src/core/storage');
const { MockModelAdapter } = require('../src/adapters/models/mock');
const { createResumeOptimizationService } = require('../src/application/resume_optimization');
const { createMockInterviewService } = require('../src/application/mock_interview');

(async () => {
  const db = storage.openDb(':memory:');
  try {
    const owner = storage.saveProfileAnalysis(db, {
      profile: { candidate: { name: '测试候选人', city: '广州', targetTitles: ['开发工程师'] }, skills: [{ name: 'Node.js' }], projects: [{ name: '知识库' }] },
      document: { originalFileName: 'synthetic.txt', format: 'text', contentHash: randomUUID(), text: '个人总结\n参与知识库开发\n技能：Node.js', diagnostics: {} },
      searchPlan: { name: '测试方案', cities: ['广州'], directions: ['开发工程师'], keywords: [{ word: 'Node.js', priority: 'A' }] }
    });
    const adapter = new MockModelAdapter();
    const calls = { start: 0, resume: 0, retry: 0 };
    for (const [method, kind] of [['generateMockInterviewStep', 'start'], ['generateResumeOptimization', 'resume'], ['reviewMockInterviewRetry', 'retry']]) {
      const original = adapter[method].bind(adapter);
      adapter[method] = async input => { calls[kind]++; await new Promise(resolve => setTimeout(resolve, 20)); return original(input); };
    }
    const base = { profileId: owner.profileId, planId: owner.planId };
    const startInput = { ...base, sessionKind: 'resume_general', resumeVersionId: owner.resumeVersionId, settings: { plannedQuestions: 3 }, operationId: randomUUID() };
    const interview = () => createMockInterviewService({ db, adapter });
    const [first, repeated] = await Promise.all([interview().startSession(startInput), interview().startSession(startInput)]);
    assert.equal(calls.start, 1, 'different HTTP service instances must share one start operation');
    assert.equal(first.id, repeated.id);
    assert.equal((await interview().startSession(startInput)).id, first.id, 'completed operation replays stored result');
    assert.equal(calls.start, 1);
    assert.deepEqual(interview().getOperation({ ...base, operationId: startInput.operationId }), { saved: true, resultId: first.id });
    assert.deepEqual(interview().getOperation({ ...base, operationId: randomUUID() }), { saved: false, resultId: null });
    assert.equal(calls.start, 1, 'status lookup must remain read-only and never invoke the model');
    await assert.rejects(interview().startSession({ ...startInput, settings: { plannedQuestions: 5 } }), { code: 'GENERATION_OPERATION_MISMATCH' });
    assert.notEqual((await interview().startSession({ ...startInput, operationId: randomUUID() })).id, first.id, 'an intentional new round is allowed');
    const activeInput = { ...startInput }; delete activeInput.operationId;
    const beforeActive = calls.start;
    const active = await Promise.all([interview().startSession(activeInput), interview().startSession(activeInput)]);
    assert.equal(calls.start, beforeActive + 1, 'equivalent active legacy requests share model work');
    assert.equal(active[0].id, active[1].id);

    const resume = () => createResumeOptimizationService({ db, adapter });
    const draftInput = { ...base, sourceResumeVersionId: owner.resumeVersionId, mode: 'general', operationId: randomUUID() };
    const drafts = await Promise.all([resume().createDraft(draftInput), resume().createDraft(draftInput)]);
    assert.equal(calls.resume, 1); assert.equal(drafts[0].id, drafts[1].id);
    assert.equal((await resume().createDraft(draftInput)).id, drafts[0].id); assert.equal(calls.resume, 1);
    assert.deepEqual(resume().getOperation({ ...base, operationId: draftInput.operationId }), { saved: true, resultId: drafts[0].id });
    assert.deepEqual(resume().getOperation({ ...base, operationId: randomUUID() }), { saved: false, resultId: null });
    assert.equal(calls.resume, 1);
    assert.notEqual((await resume().createDraft({ ...draftInput, operationId: randomUUID() })).id, drafts[0].id, 'regenerate with a new operation creates another draft');
    const activeDraftInput = { ...draftInput }; delete activeDraftInput.operationId;
    const beforeDraft = calls.resume;
    const activeDrafts = await Promise.all([resume().createDraft(activeDraftInput), resume().createDraft(activeDraftInput)]);
    assert.equal(calls.resume, beforeDraft + 1); assert.equal(activeDrafts[0].id, activeDrafts[1].id);
    const old = drafts[0];
    const saved = resume().saveDraft({ ...base, draftId: old.id, finalText: old.finalText + '\n甲修改', expectedRevision: old.revision });
    assert.throws(() => resume().saveDraft({ ...base, draftId: old.id, finalText: old.finalText + '\n乙修改', expectedRevision: old.revision }), { code: 'RESUME_OPTIMIZATION_REVISION_CONFLICT' });
    assert.equal(resume().getDraft({ ...base, draftId: old.id }).finalText, saved.finalText);
    assert.throws(() => resume().activateDraft({ ...base, draftId: old.id, finalText: 'TODO', expectedRevision: old.revision }), { code: 'RESUME_OPTIMIZATION_REVISION_CONFLICT' }, 'stale activation reports conflict before validating edited text');
    assert.throws(() => storage.activateResumeOptimization(db, { ...base, optimizationId: old.id, finalText: old.finalText, baseText: old.finalText }), { code: 'RESUME_OPTIMIZATION_REVISION_CONFLICT' });

    const sessionInput = { ...base, sessionId: first.id };
    for (let turnNumber = 1; turnNumber <= 3; turnNumber++) await interview().answerTurn({ ...sessionInput, turnNumber, answerText: `第${turnNumber}题：参与排查接口超时` });
    await interview().finishSession(sessionInput);
    const retryInput = { ...sessionInput, turnNumber: 1, answerText: '我参与知识库开发，并独立核对接口记录。', operationId: randomUUID() };
    const retries = await Promise.all([interview().retryTurn(retryInput), interview().retryTurn(retryInput)]);
    assert.equal(calls.retry, 1); assert.equal(retries[0].id, retries[1].id);
    await interview().retryTurn({ ...retryInput, answerText: '我参与知识库开发，并补充验收过程。', operationId: randomUUID() });
    assert.equal((await interview().retryTurn(retryInput)).id, retries[0].id, 'retry operation replay survives a later retry');
    const activeRetryInput = { ...retryInput, answerText: '第三次：我继续说明知识库验收中的具体分工。' }; delete activeRetryInput.operationId;
    const beforeRetry = calls.retry;
    const activeRetries = await Promise.all([interview().retryTurn(activeRetryInput), interview().retryTurn(activeRetryInput)]);
    assert.equal(calls.retry, beforeRetry + 1); assert.equal(activeRetries[0].id, activeRetries[1].id);
    const failedId = randomUUID(), original = adapter.generateResumeOptimization;
    adapter.generateResumeOptimization = async () => { throw Object.assign(new Error('timeout'), { code: 'MODEL_TIMEOUT' }); };
    await assert.rejects(resume().createDraft({ ...draftInput, operationId: failedId }), { code: 'MODEL_TIMEOUT' });
    adapter.generateResumeOptimization = original;
    await resume().createDraft({ ...draftInput, operationId: failedId });
    storage.activateResumeOptimization(db, { ...base, optimizationId: old.id, finalText: saved.finalText, expectedRevision: saved.revision });
    const copied = resume().copyDraft({ ...base, draftId: old.id });
    assert.notEqual(copied.id, old.id);
    assert.equal((await resume().createDraft(draftInput)).id, old.id, 'continuing edits must not replace the stored generation operation identity');
    const artifactRoot = process.env.OFFERGO_VALIDATION_ROOT || 'D:/DevData/OfferGo-validation/2026-10-07/audit-repairs';
    fs.mkdirSync(artifactRoot, { recursive: true });
    const persistedFile = path.join(fs.mkdtempSync(path.join(artifactRoot, 'operation-replay-')), 'synthetic.sqlite');
    db.prepare('VACUUM INTO ?').run(persistedFile);
    const reopened = storage.openDb(persistedFile);
    try {
      const unavailable = new MockModelAdapter();
      for (const method of ['generateResumeOptimization', 'generateMockInterviewStep', 'reviewMockInterviewRetry']) unavailable[method] = async () => { throw new Error('model must not run after replay'); };
      assert.equal((await createResumeOptimizationService({ db: reopened, adapter: unavailable }).createDraft(draftInput)).id, old.id);
      const recoveredInterview = createMockInterviewService({ db: reopened, adapter: unavailable });
      assert.equal((await recoveredInterview.startSession(startInput)).id, first.id);
      assert.equal((await recoveredInterview.retryTurn(retryInput)).id, retries[0].id);
    } finally { reopened.close(); }
    console.log('generation_operation_smoke ok');
  } finally { db.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

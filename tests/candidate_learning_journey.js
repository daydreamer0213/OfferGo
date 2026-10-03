const assert = require('node:assert/strict');
const storage = require('../src/core/storage');
const { MockModelAdapter } = require('../src/adapters/models/mock');
const { createMockInterviewService } = require('../src/application/mock_interview');
const evidenceStore = require('../src/storage/candidate_evidence_store');
const { validateMessageReply } = require('../src/core/message_reply_contract');
const { createMessageReplyAnalyzer } = require('../src/core/message_reply_analyzer');
const { createResumeOptimizationService } = require('../src/application/resume_optimization');

const db = storage.openDb(':memory:');
const answer = '我参与企业知识库开发，主要做接口联调和检索测试，没有主导架构。';
class InterviewAdapter extends MockModelAdapter {
  async generateMockInterviewStep(input) {
    const step = await super.generateMockInterviewStep(input);
    if (input.turns.length && step.nextQuestion) {
      step.nextQuestion = input.turns.length === 1
        ? { text: '遇到这种接口问题时，你是怎样缩小排查范围的？', focus: 'technical', resumeEvidenceIds: [input.context.resumeEvidenceCatalog[0].id], questionKind: 'follow_up', basedOnTurnNumber: 1, answerEvidence: '主要做接口联调和检索测试' }
        : { text: '请讲一次与同事共同排查问题的经历。', focus: 'behavioral', resumeEvidenceIds: [input.context.resumeEvidenceCatalog[0].id], questionKind: 'topic_transition', basedOnTurnNumber: null, answerEvidence: '' };
    }
    return step;
  }
  async reviewMockInterview(input) {
    return { ...await super.reviewMockInterview(input), evidenceCandidates: [
      { turnNumber: 1, subject: '知识库接口联调', sourceQuote: answer, text: answer },
      { turnNumber: 1, subject: '不存在的事实', sourceQuote: '我主导架构', text: '我主导架构' }
    ] };
  }
}

(async () => {
  try {
    const profile = storage.saveProfileAnalysis(db, {
      profile: { candidate: { name: '测试用户', city: '广州', targetTitles: ['工程师'] } },
      document: { contentHash: 'candidate-journey', text: '测试用户\n参与企业知识库开发\n技能：Node.js', format: 'text', originalFileName: 'resume.txt' },
      searchPlan: { name: '方案', cities: ['广州'], directions: ['工程师'], keywords: [{ word: '工程师', priority: 'A' }] }
    });
    const context = { profileId: profile.profileId, planId: profile.planId, resumeVersionId: profile.resumeVersionId, sessionKind: 'resume_general', settings: { plannedQuestions: 3 } };
    const service = createMockInterviewService({ db, adapter: new InterviewAdapter() });
    let session = await service.startSession(context);
    assert.equal(session.context.interviewBrief.generalThemes.length, 5);
    assert.deepEqual(session.context.candidateEvidence, []);
    session = await service.answerTurn({ ...context, sessionId: session.id, turnNumber: 1, answerText: answer });
    assert.equal(session.turns[1].basedOnTurnNumber, 1);
    assert.deepEqual(evidenceStore.listCandidateEvidence(db, { profileId: profile.profileId }), []);
    assert.throws(() => service.confirmEvidence({ ...context, sessionId: session.id, turnNumber: 1, subject: '架构', text: '我主导架构', sourceQuote: '我主导架构' }));
    const input = { ...context, sessionId: session.id, turnNumber: 1, subject: '知识库接口联调', text: answer, sourceQuote: answer };
    const saved = service.confirmEvidence(input);
    assert.equal(service.confirmEvidence(input).id, saved.id);
    assert.equal((await service.startSession(context)).context.candidateEvidence[0].text, answer);
    const resumeService = createResumeOptimizationService({ db, adapter: new MockModelAdapter() });
    const generalDraft = await resumeService.createDraft({ ...context, sourceResumeVersionId: profile.resumeVersionId, mode: 'general' });
    assert.equal(generalDraft.mode, 'general');
    assert.deepEqual(generalDraft.targetJobIds, []);
    assert(generalDraft.evidenceCatalog.some(item => item.kind === 'candidate_evidence' && item.text.includes(answer)));
    const unsafeService = createResumeOptimizationService({ db, adapter: {
      async generateResumeOptimization(input) {
        return { headline: '扩大职责', suggestions: [{ id: 'S1', operation: 'replace', originalText: '参与企业知识库开发', proposedText: '主导企业知识库架构', reason: '测试否定职责', evidenceIds: [input.evidenceCatalog.find(item => item.kind === 'candidate_evidence').id], editingPrinciple: 'contribution_clarity' }] };
      }
    } });
    await assert.rejects(() => unsafeService.createDraft({ ...context, sourceResumeVersionId: profile.resumeVersionId, mode: 'general' }), /职责边界/);
    assert.throws(() => resumeService.activateDraft({ ...context, draftId: generalDraft.id, finalText: generalDraft.finalText + '\n主导企业知识库架构' }), error => error.code === 'RESUME_ACTIVATION_INTEGRITY_FAILED');
    const batch = storage.createBatch(db, 'boss', '工程师', 'journey', { profileId: profile.profileId, searchPlanId: profile.planId });
    const jobId = storage.upsertJob(db, { source: 'boss', sourceId: 'specific-job', title: '应用工程师', keyword: '工程师', company: '示例公司', description: '负责知识库的接口开发、联调与检索评估，需要 Node.js 项目实践。', analysis: { semanticStatus: 'complete', recommendation: 'apply' } }, batch);
    const specific = await resumeService.createDraft({ ...context, sourceResumeVersionId: profile.resumeVersionId, mode: 'job_specific', jobId });
    assert.equal(specific.mode, 'job_specific');
    assert.deepEqual(specific.targetJobIds, [jobId]);
    await assert.rejects(() => resumeService.createDraft({ ...context, sourceResumeVersionId: profile.resumeVersionId, mode: 'job_specific', jobId: 99999 }));
    const now = new Date().toISOString();
    const salaryReply = { messageIntent: 'information_request', messageCategory: 'salary', messageSummary: 'HR 询问薪资与到岗',
      requiredFactKeys: ['expected_salary', 'availability_date'], usedFactKeys: ['expected_salary', 'availability_date'], usedMemoryIds: [],
      responseItems: [{ id: 'expected_salary', kind: 'question', required: true }, { id: 'availability_date', kind: 'question', required: true }],
      coverage: [{ responseItemId: 'expected_salary', covered: true }, { responseItemId: 'availability_date', covered: true }],
      missingFact: null, messages: ['期望 15–20K，下周可以到岗。'] };
    assert.equal(validateMessageReply(salaryReply, { now, facts: [{ key: 'expected_salary', value: '15–20K', updatedAt: now }, { key: 'availability_date', value: '下周', updatedAt: now }] }).messages.length, 1);
    const analyzer = createMessageReplyAnalyzer({ adapter: { async draftMessageGroup(input) {
      assert.equal(input.candidateEvidence[0].text, answer);
      return { ...salaryReply, messageCategory: 'project_fact', requiredFactKeys: [], usedFactKeys: [], responseItems: [], coverage: [], usedEvidenceIds: [saved.id], messages: [answer] };
    } } });
    assert.equal((await analyzer({ messages: [{ text: '你做过知识库接口联调吗？' }], candidateEvidence: evidenceStore.listCandidateEvidence(db, { profileId: profile.profileId }), now })).usedEvidenceIds[0], saved.id);
    for (const turnNumber of [2, 3]) session = await service.answerTurn({ ...context, sessionId: session.id, turnNumber, answerText: answer });
    session = await service.finishSession({ ...context, sessionId: session.id });
    assert.equal(session.report.evidenceCandidates.length, 1, 'bad evidence suggestion must not discard the entire report');
    evidenceStore.withdrawCandidateEvidence(db, { profileId: profile.profileId, id: saved.id });
    const afterWithdrawal = await resumeService.createDraft({ ...context, sourceResumeVersionId: profile.resumeVersionId, mode: 'general' });
    assert(!afterWithdrawal.evidenceCatalog.some(item => item.kind === 'candidate_evidence'));
    assert.deepEqual((await service.startSession(context)).context.candidateEvidence, []);
    const cardId = Number(db.prepare(`INSERT INTO candidate_progress_cards(profile_id,plan_id,job_id,source,stage,next_action,last_event_at,created_at,updated_at)
      VALUES (?, ?, ?, 'boss', 'reply_ready', 'review', ?, ?, ?)`).run(profile.profileId, profile.planId, jobId, now, now, now).lastInsertRowid);
    for (let index = 0; index < 101; index++) {
      const at = index ? now : '2026-01-01T00:00:00.000Z';
      const text = index ? '我目前在广州。' : '我累计完成3个知识库接口联调项目。';
      const [draft] = storage.recordMessageReplyDrafts(db, { profileId: profile.profileId, cardId, jobId,
        messageGroupKey: 'sha256:' + String(index).padStart(64, '0'), questionSummary: index ? '所在城市' : '知识库接口联调',
        messageIntent: 'information_request', messageCategory: index ? 'other' : 'project_fact', messages: ['原始回答'], createdAt: at });
      storage.completeMessageReplyDraft(db, { profileId: profile.profileId, draftId: draft.id, finalText: text, changedText: text,
        completionKind: 'copied', scope: { kind: 'global', key: '' }, extractedFacts: [], completedAt: at });
    }
    const material = require('../src/application/message_discovery/materials').candidateReplyMaterial(db, profile.profileId);
    const quality = require('../src/application/message_draft_quality').buildMessageDraftQualityContext(db, { profileId: profile.profileId,
      job: { id: jobId, company: '示例公司' }, messageTexts: ['你完成过几个知识库接口联调项目？'] });
    assert(require('../src/core/message_draft_quality').assessMessageDraftQuality({ text: '我累计完成3个知识库接口联调项目。', ...quality }).valid);
    assert(material.answerMemories.some(item => item.finalText.includes('3个')));
    const oldAnswerService = createResumeOptimizationService({ db, adapter: { async generateResumeOptimization(input) {
      const evidence = input.evidenceCatalog.find(item => item.kind === 'answer' && item.text.includes('3个'));
      assert(evidence);
      return { headline: '展开已确认项目数量', suggestions: [{ id: 'S1', operation: 'replace', originalText: '参与企业知识库开发',
        proposedText: '参与企业知识库开发，累计完成3个知识库接口联调项目', reason: '加入以前确认过的真实经历', evidenceIds: [evidence.id], editingPrinciple: 'result_visibility' }] };
    } } });
    const oldAnswerDraft = await oldAnswerService.createDraft({ ...context, sourceResumeVersionId: profile.resumeVersionId, mode: 'general' });
    assert.equal(oldAnswerService.activateDraft({ ...context, draftId: oldAnswerDraft.id, finalText: oldAnswerDraft.finalText + '\n项目经历：参与企业知识库开发' }).status, 'activated');
    await confirmedFactsJourney();
    console.log('candidate_learning_journey ok');
  } finally { db.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

async function confirmedFactsJourney() {
  const { mergeCandidateFacts } = require('../src/core/candidate_fact_policy');
  const profile = storage.saveProfileAnalysis(db, {
    profile: { candidate: { name: '状态测试', targetTitles: ['工程师'] } },
    document: { contentHash: 'confirmed-state', text: '状态测试\n参与接口联调', format: 'text', originalFileName: 'state.txt' },
    searchPlan: { name: '状态方案', directions: ['工程师'] }
  });
  const service = createMockInterviewService({ db, adapter: new MockModelAdapter() });
  const context = { profileId: profile.profileId, planId: profile.planId, resumeVersionId: profile.resumeVersionId, settings: { plannedQuestions: 3 } };
  let session = await service.startSession(context);
  const answer = '我目前已经离职，下周可以到岗。';
  session = await service.answerTurn({ ...context, sessionId: session.id, turnNumber: 1, answerText: answer });
  const entry = service.confirmEvidence({ ...context, sessionId: session.id, turnNumber: 1, sourceQuote: answer, subject: '求职状态', text: answer });
  const reply = createMessageReplyAnalyzer({ adapter: { async draftMessageGroup(input) {
    assert.equal(input.facts.find(fact => fact.key === 'employment_status')?.value, '已离职');
    assert.equal(input.facts.find(fact => fact.key === 'availability_date')?.value, '下周');
    return { messageIntent: 'information_request', messageCategory: 'availability', messageSummary: '确认在职和到岗',
      requiredFactKeys: ['employment_status', 'availability_date'], usedFactKeys: ['employment_status', 'availability_date'], usedMemoryIds: [],
      responseItems: [{ id: 'employment_status', kind: 'question', required: true }, { id: 'availability_date', kind: 'question', required: true }],
      coverage: [{ responseItemId: 'employment_status', covered: true }, { responseItemId: 'availability_date', covered: true }],
      missingFact: null, messages: ['目前已离职，下周可以到岗。'] };
  } } });
  assert.equal((await reply({ messages: [{ text: '你现在在职吗？何时到岗？' }], candidateEvidence: [entry] })).messages.length, 1);
  const newer = new Date(Date.parse(entry.updatedAt) + 1000).toISOString();
  assert.equal(mergeCandidateFacts([{ factKey: 'employment_status', factValue: '在职', updatedAt: newer }], [entry]).find(fact => fact.factKey === 'employment_status').factValue, '在职');
  assert(!mergeCandidateFacts([], [entry], { factRevisions: [{ id: 1, factKey: 'employment_status', operation: 'delete', createdAt: newer }] }).some(fact => fact.factKey === 'employment_status'), 'deleted facts must not reappear from older confirmed records');
  storage.saveCandidateFact(db, { profileId: profile.profileId, factKey: 'employment_status', factValue: '在职' });
  const updatedSession = await service.startSession(context);
  assert.equal(updatedSession.context.candidateFacts.find(fact => fact.factKey === 'employment_status').factValue, '在职', 'interview context must also prefer the new manual correction');
  evidenceStore.withdrawCandidateEvidence(db, { profileId: profile.profileId, id: entry.id });
  assert.deepEqual(mergeCandidateFacts([], evidenceStore.listCandidateEvidence(db, { profileId: profile.profileId })), []);
  assert.deepEqual(mergeCandidateFacts([], [{ ...entry, text: '我同事目前已经离职，下周可以到岗。' }]), [], 'another person is not a candidate fact');
  const hypothetical = mergeCandidateFacts([], [{ ...entry, text: '如果拿到 offer，我可以下周到岗，但目前没有确定。' }]);
  assert(!hypothetical.some(fact => fact.factKey === 'availability_date'), 'a hypothetical schedule is not confirmed');
  assert.equal(mergeCandidateFacts([], [{ ...entry, text: '我目前已离职，但到岗时间还没确定。' }]).find(fact => fact.factKey === 'employment_status').factValue, '已离职', 'one unknown item must not hide another known fact');
}

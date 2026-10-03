const assert = require('node:assert/strict');
const storage = require('../src/core/storage');
const { MockModelAdapter } = require('../src/adapters/models/mock');
const { createMockInterviewService } = require('../src/application/mock_interview');
const evidenceStore = require('../src/storage/candidate_evidence_store');

const db = storage.openDb(':memory:');
const answer = '我参与企业知识库开发，主要做接口联调和检索测试，没有主导架构。';
class InterviewAdapter extends MockModelAdapter {
  async generateMockInterviewStep(input) {
    const step = await super.generateMockInterviewStep(input);
    if (input.turns.length && step.nextQuestion) {
      step.nextQuestion = { text: '请讲一次与同事共同排查问题的经历。', focus: 'behavioral', resumeEvidenceIds: [input.context.resumeEvidenceCatalog[0].id], questionKind: 'topic_transition', basedOnTurnNumber: null, answerEvidence: '' };
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
    assert.equal(session.turns[1].basedOnTurnNumber, null);
    assert.deepEqual(evidenceStore.listCandidateEvidence(db, { profileId: profile.profileId }), []);
    assert.throws(() => service.confirmEvidence({ ...context, sessionId: session.id, turnNumber: 1, subject: '架构', text: '我主导架构', sourceQuote: '我主导架构' }));
    const input = { ...context, sessionId: session.id, turnNumber: 1, subject: '知识库接口联调', text: answer, sourceQuote: answer };
    const saved = service.confirmEvidence(input);
    assert.equal(service.confirmEvidence(input).id, saved.id);
    assert.equal((await service.startSession(context)).context.candidateEvidence[0].text, answer);
    for (const turnNumber of [2, 3]) session = await service.answerTurn({ ...context, sessionId: session.id, turnNumber, answerText: answer });
    session = await service.finishSession({ ...context, sessionId: session.id });
    assert.equal(session.report.evidenceCandidates.length, 1, 'bad evidence suggestion must not discard the entire report');
    evidenceStore.withdrawCandidateEvidence(db, { profileId: profile.profileId, id: saved.id });
    assert.deepEqual((await service.startSession(context)).context.candidateEvidence, []);
    console.log('candidate_learning_journey ok');
  } finally { db.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

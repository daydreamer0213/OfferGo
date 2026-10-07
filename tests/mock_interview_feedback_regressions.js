const test = require('node:test');
const assert = require('node:assert/strict');
const storage = require('../src/core/storage');
const { createMockInterviewService } = require('../src/application/mock_interview');

function setup(alwaysMissing = false) {
  const db = storage.openDb(':memory:');
  const owner = storage.saveProfileAnalysis(db, {
    profile: { candidate: { name: '反馈验收用户', targetTitles: ['产品实习生'] } },
    document: { text: '教育经历\n信息管理本科\n课程项目\n参与客服访谈，个人完成工单状态图和需求说明。',
      contentHash: 'interview-feedback', format: 'text', originalFileName: 'synthetic.txt' },
    searchPlan: { name: '产品实习', directions: ['产品实习生'] }
  });
  let correctionCount = 0;
  const service = createMockInterviewService({ db, adapter: {
    async generateMockInterviewStep(input) {
      const ids = input.context.resumeEvidenceCatalog.filter(item => item.text.includes('工单')).map(item => item.id);
      const initial = input.turns.length === 0;
      if (input.questionRevision) {
        correctionCount++;
        assert.equal(input.turns[0].answer, '我整理了访谈中的状态边界，并把待补资料与正在处理分开。');
        assert.equal(input.questionRevision.reason, 'MOCK_INTERVIEW_ANSWER_REVIEW_REQUIRED');
        assert.equal(input.questionRevision.rejectedQuestion.text, '你如何与同学核对这些状态边界？');
      }
      return {
        answerReview: initial || alwaysMissing || !input.questionRevision ? null : {
          conclusion: '说明了个人工作和划分原则，协作核对过程还可以补充。',
          strengths: '说明了状态划分的具体依据。', improvements: '补充一次与同学核对边界的过程。', turnNumbers: [1]
        },
        nextQuestion: { text: initial ? '你在课程项目中实际承担了哪些工单需求工作？' : '你如何与同学核对这些状态边界？',
          focus: '需求和协作能力', resumeEvidenceIds: ids, questionKind: 'topic_transition', basedOnTurnNumber: null, answerEvidence: '' },
        complete: false
      };
    }
  } });
  return { db, owner, service, corrections: () => correctionCount };
}

test('missing post-answer feedback gets one repair and a paragraph remains useful feedback', async () => {
  const f = setup();
  try {
    const input = { profileId: f.owner.profileId, planId: f.owner.planId, resumeVersionId: f.owner.resumeVersionId,
      sessionKind: 'resume_general', settings: { plannedQuestions: 3 } };
    const session = await f.service.startSession(input);
    const result = await f.service.answerTurn({ ...input, sessionId: session.id, turnNumber: 1,
      answerText: '我整理了访谈中的状态边界，并把待补资料与正在处理分开。' });
    assert.equal(f.corrections(), 1);
    assert.equal(result.turns.length, 2);
    assert.deepEqual(result.turns[0].answerReview.strengths, ['说明了状态划分的具体依据。']);
    assert.deepEqual(result.turns[0].answerReview.improvements, ['补充一次与同学核对边界的过程。']);
  } finally { f.db.close(); }
});

test('a failed feedback repair keeps the original question unanswered without fake feedback', async () => {
  const f = setup(true);
  try {
    const input = { profileId: f.owner.profileId, planId: f.owner.planId, resumeVersionId: f.owner.resumeVersionId,
      sessionKind: 'resume_general', settings: { plannedQuestions: 3 } };
    const session = await f.service.startSession(input);
    await assert.rejects(() => f.service.answerTurn({ ...input, sessionId: session.id, turnNumber: 1,
      answerText: '我整理了访谈中的状态边界，并把待补资料与正在处理分开。' }),
      error => error.code === 'MOCK_INTERVIEW_ANSWER_REVIEW_REQUIRED');
    assert.equal(f.corrections(), 1);
    const retained = f.service.getSession({ ...input, sessionId: session.id });
    assert.equal(retained.turns.length, 1);
    assert.equal(retained.turns[0].answerText, '');
    assert.equal(retained.turns[0].answerReview, null);
  } finally { f.db.close(); }
});

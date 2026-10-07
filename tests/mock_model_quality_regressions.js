const test = require('node:test');
const assert = require('node:assert/strict');
const storage = require('../src/core/storage');
const { MockModelAdapter } = require('../src/adapters/models/mock');
const { createResumeOptimizationService } = require('../src/application/resume_optimization');
const { validateInterviewStep, validateInterviewReport, validateRetryReview } = require('../src/core/mock_interview');

const resumeEvidenceCatalog = [
  { id: 'R1', text: '[姓名已隐藏]' },
  { id: 'R2', text: '教育经历' },
  { id: 'R3', text: '示例学院｜计算机本科｜2020.09—2024.06' },
  { id: 'R4', text: '求职意向：后端开发' },
  { id: 'R4a', text: '未负责生产部署。' },
  { id: 'R5', text: '未负责生产部署，但本人完成订单接口校验，前端由同事负责。' }
];
const context = { sessionKind: 'resume_general', resumeEvidenceCatalog };

test('offline Mock preserves a complete resume instead of relabeling education as experience', async () => {
  const db = storage.openDb(':memory:');
  try {
    const source = '教育经历\n示例学院｜计算机本科｜2020.09—2024.06\n工作经历\n本人完成订单接口校验，前端由同事负责，未负责生产部署。\n技能\nNode.js、SQL基础。';
    const owner = storage.saveProfileAnalysis(db, {
      profile: { candidate: { name: '占位测试', targetTitles: ['后端开发'] } },
      document: { text: source, contentHash: 'mock-preserve-source', format: 'text', originalFileName: 'synthetic.txt' },
      searchPlan: { name: '占位测试', directions: ['后端开发'] }
    });
    const draft = await createResumeOptimizationService({ db, adapter: new MockModelAdapter() }).createDraft({
      profileId: owner.profileId, planId: owner.planId, sourceResumeVersionId: owner.resumeVersionId, mode: 'general'
    });
    assert.equal(draft.suggestions.length, 0);
    assert.equal(draft.finalText, source);
    assert.match(draft.headline, /Mock/);
  } finally { db.close(); }
});

test('offline interview starts from actual actions and retains their responsibility boundary', async () => {
  const raw = await new MockModelAdapter().generateMockInterviewStep({ context });
  const step = validateInterviewStep(raw, { ...context, turns: [] });
  assert.deepEqual(step.nextQuestion.resumeEvidenceIds, ['R5']);
  assert.match(step.nextQuestion.text, /本人完成订单接口校验/);
  assert.match(step.nextQuestion.text, /未负责生产部署/);
  assert.doesNotMatch(step.nextQuestion.text, /姓名已隐藏|教育经历|示例学院|求职意向/);
  await assert.rejects(new MockModelAdapter().generateMockInterviewStep({
    context: { ...context, resumeEvidenceCatalog: resumeEvidenceCatalog.slice(0, 5) }
  }));
});

test('offline interview records both unrelated long and relevant short answers without judging coverage', async () => {
  const adapter = new MockModelAdapter();
  for (const answer of ['我只想讨论天气和午餐，电影院和旅行路线。这些文字用于增加字数，没有回答接口校验的问题。', '我补了参数校验。']) {
    const turns = [{ turnNumber: 1, answer }];
    const step = validateInterviewStep(await adapter.generateMockInterviewStep({ context, settings: { plannedQuestions: 3 }, turns }), { ...context, turns });
    assert.match(step.answerReview.conclusion, /Mock/);
    assert.doesNotMatch(step.answerReview.conclusion, /覆盖核心|较短|直接相关/);
    assert.deepEqual(step.answerReview.strengths, []);
    assert.deepEqual(step.answerReview.improvements, []);
    assert.equal(step.nextQuestion.basedOnTurnNumber, 1);
    assert(answer.includes(step.nextQuestion.answerEvidence));
    const report = validateInterviewReport(await adapter.reviewMockInterview({ turns }), { turns });
    assert.match(report.conclusion, /Mock/);
    assert.deepEqual(report.strengths, []);
    assert.deepEqual(report.improvements, []);
    assert.deepEqual(report.followUpRisks, []);
  }
});

test('offline retry does not equate more words or unchanged topic with improvement', async () => {
  for (const retryAnswer of ['天气很好。午餐吃了面条，继续讨论旅行路线和颜色，与问题无关。', '我校验订单参数。']) {
    const turn = { turnNumber: 1, originalAnswer: '天气很好。', retryAnswer };
    const review = validateRetryReview(await new MockModelAdapter().reviewMockInterviewRetry({ turn }), { turnNumber: 1 });
    assert.equal(review.improved, false);
    assert.match(review.conclusion, /Mock/);
    assert.match(review.conclusion, /未.*(?:判断|评估)|不.*(?:判断|评估)/);
    assert.deepEqual(review.strengths, []);
    assert.deepEqual(review.remainingImprovements, []);
  }
});

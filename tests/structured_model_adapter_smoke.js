const assert = require("node:assert");

const { StructuredModelAdapter } = require("../src/adapters/models/structured");
const { MockModelAdapter } = require('../src/adapters/models/mock');
const { validateInterviewPreparation, validateInterviewStep } = require('../src/core/mock_interview');

const calls = [];
const preparedStories = { stories: [{ id: 'S1', title: '接口排障', resumeEvidenceIds: ['R1'],
  text: '我参与接口排障，通过日志定位数据库，再复测修复结果。', missingDetails: ['当时为什么选择这个修复方式？'] }] };
const transport = {
  async requestJson(request) {
    calls.push(request);
    if (request.kind === 'generateMockInterviewPreparation') return preparedStories;
    if (request.kind === "reviewMockInterview") return { conclusion: "依据原题和回答复盘" };
    if (request.kind === "generateMockInterviewStep") return { complete: true };
    if (request.kind === "reviewMockInterviewRetry") {
      return {
        turnNumber: 1,
        conclusion: "表达更清楚",
        improved: true,
        strengths: [],
        remainingImprovements: []
      };
    }
    throw new Error(`unexpected kind: ${request.kind}`);
  }
};

(async () => {
  const adapter = new StructuredModelAdapter({
    transport,
    provider: "fixture",
    model: "fixture-model"
  });
  const result = await adapter.reviewMockInterviewRetry({
    turn: { turnNumber: 1, originalAnswer: "原回答", retryAnswer: "新回答" }
  });
  assert.strictEqual(result.improved, true);
  assert.strictEqual(adapter.provider, "fixture");
  assert.strictEqual(adapter.model, "fixture-model");
  assert.strictEqual(calls[0].kind, "reviewMockInterviewRetry");
  assert.match(calls[0].systemPrompt, /只比较/);
  assert.strictEqual(calls[0].input.turn.turnNumber, 1);
  const actualTurn = { turnNumber: 1, question: "如何定位接口问题？", answer: "看日志定位数据库，再复测修复结果。",
    answerReview: { conclusion: "应说明生产发布由谁负责" } };
  const context = { sessionKind: "resume_general", resume: { text: "实际简历" },
    resumeEvidenceCatalog: [{ id: "R1", text: "实际简历" }],
    interviewBrief: { generalThemes: ["解决问题"], resumeEvidenceCatalog: [{ id: "R1", text: "实际简历" }] } };
  const report = await adapter.reviewMockInterview({ context, turns: [actualTurn] });
  const reviewRequest = calls[1];
  assert.strictEqual(report.conclusion, "依据原题和回答复盘");
  assert.deepStrictEqual(reviewRequest.input.context, { sessionKind: "resume_general", resume: context.resume,
    interviewBrief: { generalThemes: ["解决问题"] } });
  assert.deepStrictEqual(reviewRequest.input.turns, [{ turnNumber: 1, question: actualTurn.question, answer: actualTurn.answer }]);
  assert.strictEqual(actualTurn.answerReview.conclusion, "应说明生产发布由谁负责", "historical feedback remains intact locally");
  await adapter.generateMockInterviewStep({ context, turns: [actualTurn], progress: { remainingThemes: ["解决问题"] } });
  assert.deepStrictEqual(calls[2].input.turns, reviewRequest.input.turns, "next-step assessment also uses actual answers, not old coaching as evidence");
  assert.deepStrictEqual(calls[2].input.context, context, "question generation keeps its grounding catalog");
  const preparation = await adapter.generateMockInterviewPreparation({ context });
  assert.deepStrictEqual(preparation, preparedStories);
  assert.strictEqual(calls[3].kind, 'generateMockInterviewPreparation');
  assert.deepStrictEqual(calls[3].input, { context }, 'initial preparation uses the frozen source context');
  await adapter.generateMockInterviewPreparation({ context, preparation: preparedStories,
    storyId: 'S1', supplement: '当时先比较了两个可行方案，再选择改动较小的一项。' });
  assert.deepStrictEqual(calls[4].input, { context, preparation: preparedStories,
    storyId: 'S1', supplement: '当时先比较了两个可行方案，再选择改动较小的一项。' });
  const storyContext = { ...context, storyPreparation: { id: 9, revision: 3, stories: preparedStories.stories } };
  await adapter.generateMockInterviewStep({ context: storyContext, turns: [] });
  assert.deepStrictEqual(calls[5].input.context.storyPreparation, { id: 9, revision: 3, stories: preparedStories.stories });
  assert.deepStrictEqual(calls[5].input.turns, [], 'a preparation draft never becomes a fabricated interview answer');
  await adapter.generateMockInterviewStep({ context: storyContext, turns: [actualTurn] });
  assert.deepStrictEqual(calls[6].input.turns, [{ turnNumber: 1, question: actualTurn.question, answer: actualTurn.answer }]);
  const offline = new MockModelAdapter();
  const workContext = { sessionKind: 'resume_general', resumeEvidenceCatalog: [
    { id: 'R1', text: '教育经历' }, { id: 'R2', text: '示例学院，完成课程开发训练' },
    { id: 'R3', text: '技能' }, { id: 'R4', text: '熟悉 Node.js 与接口开发' },
    { id: 'R5', text: '项目：知识库检索链路' },
    { id: 'R6', text: '参与建立知识库检索链路。' }, { id: 'R7', text: '通过查询日志定位检索问题。' },
    { id: 'R8', text: '项目：数据导出' }, { id: 'R9', text: '负责数据导出接口实现。' }
  ] };
  const offlineDraft = validateInterviewPreparation(await offline.generateMockInterviewPreparation({ context: workContext }), workContext);
  assert.deepStrictEqual(offlineDraft.stories.map(story => ({ id: story.id, resumeEvidenceIds: story.resumeEvidenceIds })), [
    { id: 'S1', resumeEvidenceIds: ['R5', 'R6', 'R7'] }, { id: 'S2', resumeEvidenceIds: ['R8', 'R9'] }
  ], 'offline grouping joins one work block rather than turning each resume line into a story');
  assert(offlineDraft.stories[0].text.includes('通过查询日志定位检索问题。'));
  assert(offlineDraft.stories.every(story => story.text.includes('离线 Mock') && story.missingDetails.length > 0));
  assert(!offlineDraft.stories.some(story => /示例学院|熟悉 Node.js/.test(story.text)));
  const editedDraft = { stories: offlineDraft.stories.map(story => story.id === 'S2'
    ? { ...story, text: `${story.text}\n已保存的本人修改。` } : story) };
  const refinedDraft = validateInterviewPreparation(await offline.generateMockInterviewPreparation({ context: workContext,
    preparation: editedDraft, storyId: 'S2', supplement: '因为旧导出接口占用较多内存，我选择分批读取。' }),
  { ...workContext, storyId: 'S2' });
  assert.strictEqual(refinedDraft.stories.length, 1);
  assert(refinedDraft.stories[0].text.includes('已保存的本人修改。'));
  assert(refinedDraft.stories[0].text.includes('因为旧导出接口占用较多内存，我选择分批读取。'));
  assert.strictEqual(editedDraft.stories[0].text, offlineDraft.stories[0].text);
  const selectedContext = { ...workContext, storyPreparation: { id: 12, revision: 4, stories: [offlineDraft.stories[1]] } };
  const selectedFirst = validateInterviewStep(await offline.generateMockInterviewStep({ context: selectedContext }), selectedContext);
  assert.deepStrictEqual(selectedFirst.nextQuestion.resumeEvidenceIds, ['R9']);
  assert.strictEqual(selectedFirst.nextQuestion.focus, 'S2');
  assert(selectedFirst.nextQuestion.text.includes('数据导出'));
  const selectedTurns = [{ turnNumber: 1, question: selectedFirst.nextQuestion.text, focus: 'S2', answer: '我把读取改为分批执行。' }];
  const selectedFollowUp = validateInterviewStep(await offline.generateMockInterviewStep({ context: selectedContext, turns: selectedTurns }),
    { ...selectedContext, turns: selectedTurns });
  assert.strictEqual(selectedFollowUp.nextQuestion.focus, 'S2');
  assert(selectedFollowUp.nextQuestion.text.includes('我把读取改为分批执行。'));
  console.log("structured model adapter smoke passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

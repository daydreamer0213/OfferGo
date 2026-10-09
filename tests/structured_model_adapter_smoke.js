const assert = require("node:assert");

const { StructuredModelAdapter } = require("../src/adapters/models/structured");

const calls = [];
const transport = {
  async requestJson(request) {
    calls.push(request);
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
  console.log("structured model adapter smoke passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

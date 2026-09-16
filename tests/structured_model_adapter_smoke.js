const assert = require("node:assert");

const { StructuredModelAdapter } = require("../src/adapters/models/structured");

const calls = [];
const transport = {
  async requestJson(request) {
    calls.push(request);
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
  console.log("structured model adapter smoke passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

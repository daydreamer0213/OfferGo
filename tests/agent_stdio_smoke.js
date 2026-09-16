const assert = require("node:assert");
const { PassThrough } = require("node:stream");

const { AgentStdioTransport } = require("../src/adapters/models/agent_stdio");

async function readRequest(output) {
  let buffered = "";
  for await (const chunk of output) {
    buffered += chunk.toString("utf8");
    const newline = buffered.indexOf("\n");
    if (newline >= 0) return JSON.parse(buffered.slice(0, newline));
  }
  throw new Error("request stream ended");
}

(async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const transport = new AgentStdioTransport({ input, output, timeoutMs: 1000 });
  const pending = transport.requestJson({
    kind: "reviewMockInterviewRetry",
    systemPrompt: "Return one JSON object.",
    input: { turn: 1 }
  });
  const request = await readRequest(output);
  assert.strictEqual(request.protocol, "offergo.agent.stdio");
  assert.strictEqual(request.version, 1);
  assert.strictEqual(request.type, "model_request");
  assert.strictEqual(request.task, "reviewMockInterviewRetry");
  assert.deepStrictEqual(request.input, { turn: 1 });
  assert.match(request.replyFormat, /same id/i);

  input.write(`${JSON.stringify({
    protocol: request.protocol,
    version: 1,
    type: "model_response",
    id: request.id,
    result: { improved: true }
  })}\n`);
  assert.deepStrictEqual(await pending, { improved: true });
  transport.close();

  const badInput = new PassThrough();
  const badOutput = new PassThrough();
  const badTransport = new AgentStdioTransport({ input: badInput, output: badOutput, timeoutMs: 1000 });
  const rejected = badTransport.requestJson({ kind: "analyzeResume", systemPrompt: "x", input: {} });
  const badRequest = await readRequest(badOutput);
  badInput.write(`${JSON.stringify({
    protocol: badRequest.protocol,
    version: 1,
    type: "model_response",
    id: "wrong-id",
    result: {}
  })}\n`);
  await assert.rejects(rejected, (error) => error.code === "AGENT_STDIO_RESPONSE_MISMATCH");
  badTransport.close();

  const timeoutInput = new PassThrough();
  const timeoutOutput = new PassThrough();
  const timeoutTransport = new AgentStdioTransport({
    input: timeoutInput,
    output: timeoutOutput,
    timeoutMs: 20
  });
  await assert.rejects(
    timeoutTransport.requestJson({ kind: "analyzeResume", systemPrompt: "x", input: {} }),
    (error) => error.code === "AGENT_STDIO_TIMEOUT"
  );
  timeoutTransport.close();

  const cancelInput = new PassThrough();
  const cancelOutput = new PassThrough();
  const cancelTransport = new AgentStdioTransport({ input: cancelInput, output: cancelOutput, timeoutMs: 1000 });
  const controller = new AbortController();
  const cancelled = cancelTransport.requestJson({
    kind: "analyzeResume",
    systemPrompt: "x",
    input: {},
    signal: controller.signal
  });
  controller.abort();
  await assert.rejects(cancelled, (error) => error.code === "AGENT_STDIO_CANCELLED");
  cancelTransport.close();

  console.log("agent stdio smoke passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

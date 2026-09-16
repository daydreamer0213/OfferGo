const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { AgentCommandTransport } = require("../src/adapters/models/agent_command_transport");
const { getAgentRunner, probeAgentRunner } = require("../src/adapters/models/agent_runner_registry");

const fakeCodex = path.join(__dirname, "fixtures", "fake_codex_cli.js");

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "offergo-codex-runner-"));
}

function runnerEnv(mode, auditPath = "") {
  return {
    ...process.env,
    OFFERGO_CODEX_COMMAND: process.execPath,
    OFFERGO_CODEX_ARGS_JSON: JSON.stringify([fakeCodex]),
    FAKE_CODEX_MODE: mode,
    FAKE_CODEX_AUDIT: auditPath
  };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => error?.code === code);
}

(async () => {
  const root = makeRoot();
  try {
    const runner = getAgentRunner("codex");
    assert.strictEqual(runner.id, "codex");
    assert.throws(() => getAgentRunner("unknown"), /不支持/);

    const ready = await probeAgentRunner({ runnerId: "codex", env: runnerEnv("success"), dataRoot: root });
    assert.strictEqual(ready.status, "ready");
    assert.strictEqual(ready.identity.runner, "codex");
    assert.strictEqual(ready.identity.runnerVersion, "9.9.9");

    const update = await probeAgentRunner({ runnerId: "codex", env: runnerEnv("help_missing"), dataRoot: root });
    assert.strictEqual(update.status, "update_required");

    const auditPath = path.join(root, "codex-audit.jsonl");
    const spec = runner.commandSpec({ dataRoot: root, env: runnerEnv("success", auditPath) });
    const transport = new AgentCommandTransport({ ...spec, runnerId: "codex", dataRoot: root, timeoutMs: 1200 });
    const result = await transport.requestJson({
      systemPrompt: "return a JSON object",
      input: { resume: "secret-resume-marker" },
      kind: "connectionTest",
      outputSchema: {
        type: "object",
        properties: { ok: { type: "boolean", const: true } },
        required: ["ok"],
        additionalProperties: false
      }
    });
    assert.deepStrictEqual(result, { ok: true });
    const invocation = JSON.parse(fs.readFileSync(auditPath, "utf8").trim());
    const argsText = invocation.args.join(" ");
    for (const flag of ["exec", "--ephemeral", "--sandbox", "read-only", "--ignore-user-config", "--ignore-rules", "--output-schema", "--output-last-message", "--cd"]) {
      assert.ok(invocation.args.includes(flag), `${flag}: ${argsText}`);
    }
    assert.ok(!argsText.includes("secret-resume-marker"));
    assert.ok(invocation.receivedPrompt);
    assert.notStrictEqual(path.resolve(invocation.cwd), path.resolve(process.cwd()));

    const businessResult = await transport.requestJson({
      systemPrompt: "return a business JSON object",
      input: { fixture: true },
      kind: "analyzeResume"
    });
    assert.deepStrictEqual(businessResult, { ok: true });
    const businessInvocation = fs.readFileSync(auditPath, "utf8").trim().split(/\r?\n/).map(JSON.parse).at(-1);
    assert.ok(!businessInvocation.args.includes("--output-schema"),
      "a task without a concrete schema must not send an invalid generic schema to Codex");

    for (const [mode, code] of [
      ["auth", "MODEL_AGENT_AUTH_REQUIRED"],
      ["quota", "MODEL_AGENT_QUOTA_EXHAUSTED"],
      ["failure", "MODEL_AGENT_PROCESS_FAILED"],
      ["invalid_json", "MODEL_AGENT_PROTOCOL_INVALID"]
    ]) {
      const failingSpec = runner.commandSpec({ dataRoot: root, env: runnerEnv(mode) });
      await expectCode(new AgentCommandTransport({
        ...failingSpec,
        runnerId: "codex",
        dataRoot: root,
        timeoutMs: 1200
      }).requestJson({ systemPrompt: "system", input: { mode }, kind: mode }), code);
    }

    const delayedSpec = runner.commandSpec({ dataRoot: root, env: runnerEnv("delay") });
    await expectCode(new AgentCommandTransport({
      ...delayedSpec,
      runnerId: "codex",
      dataRoot: root,
      timeoutMs: 50
    }).requestJson({ systemPrompt: "system", input: {}, kind: "timeout" }), "MODEL_AGENT_TIMEOUT");

    console.log("codex agent runner smoke passed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

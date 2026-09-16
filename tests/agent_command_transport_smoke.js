const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { AgentCommandTransport } = require("../src/adapters/models/agent_command_transport");

const fixture = path.join(__dirname, "fixtures", "fake_agent_runner.js");

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "offergo-agent-transport-"));
}

function makeTransport(root, env = {}, options = {}) {
  return new AgentCommandTransport({
    runnerId: "fixture",
    command: process.execPath,
    args: [fixture],
    dataRoot: root,
    timeoutMs: options.timeoutMs || 800,
    maxOutputBytes: options.maxOutputBytes || 4096,
    env: { ...process.env, ...env }
  });
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => error?.code === code);
}

(async () => {
  const root = makeRoot();
  try {
    const auditPath = path.join(root, "audit.jsonl");
    const transport = makeTransport(root, { FAKE_AGENT_AUDIT: auditPath });
    const secret = "secret-resume-marker";
    const result = await transport.requestJson({
      systemPrompt: "secret-system-marker",
      input: { resume: secret },
      kind: "fixture"
    });
    assert.deepStrictEqual(result, { accepted: true, taskKind: "fixture" });
    assert.strictEqual(transport.lastIdentity.runner, "fixture");
    const firstAudit = JSON.parse(fs.readFileSync(auditPath, "utf8").trim());
    assert.ok(!JSON.stringify(firstAudit.args).includes(secret));
    assert.ok(firstAudit.cwd.startsWith(path.join(root, ".runtime", "agent-requests")));

    for (const [mode, code] of [
      ["invalid_json", "MODEL_AGENT_PROTOCOL_INVALID"],
      ["mismatch", "MODEL_AGENT_PROTOCOL_INVALID"],
      ["oversize", "MODEL_AGENT_PROTOCOL_INVALID"],
      ["exit", "MODEL_AGENT_PROCESS_FAILED"],
      ["auth", "MODEL_AGENT_AUTH_REQUIRED"]
    ]) {
      await expectCode(makeTransport(root, { FAKE_AGENT_MODE: mode }).requestJson({
        systemPrompt: "system",
        input: { mode },
        kind: mode
      }), code);
    }

    await expectCode(makeTransport(root, {
      FAKE_AGENT_DELAY_MS: "250"
    }, { timeoutMs: 40 }).requestJson({
      systemPrompt: "system",
      input: { timeout: true },
      kind: "timeout"
    }), "MODEL_AGENT_TIMEOUT");

    const controller = new AbortController();
    const aborted = makeTransport(root, { FAKE_AGENT_DELAY_MS: "250" }).requestJson({
      systemPrompt: "system",
      input: { abort: true },
      kind: "abort",
      signal: controller.signal
    });
    setTimeout(() => controller.abort(), 20);
    await expectCode(aborted, "MODEL_AGENT_CANCELLED");

    fs.writeFileSync(auditPath, "");
    const coalesced = makeTransport(root, {
      FAKE_AGENT_AUDIT: auditPath,
      FAKE_AGENT_DELAY_MS: "60"
    });
    const same = { systemPrompt: "system", input: { same: true }, kind: "same" };
    const [left, right] = await Promise.all([
      coalesced.requestJson(same),
      coalesced.requestJson(same)
    ]);
    assert.deepStrictEqual(left, right);
    assert.strictEqual(fs.readFileSync(auditPath, "utf8").trim().split(/\r?\n/).length, 1);

    fs.writeFileSync(auditPath, "");
    await Promise.all([
      coalesced.requestJson({ systemPrompt: "system", input: { id: 1 }, kind: "first" }),
      coalesced.requestJson({ systemPrompt: "system", input: { id: 2 }, kind: "second" })
    ]);
    const serial = fs.readFileSync(auditPath, "utf8").trim().split(/\r?\n/).map(JSON.parse);
    assert.strictEqual(serial.length, 2);
    assert.ok(serial[0].endedAt <= serial[1].startedAt, JSON.stringify(serial));

    fs.writeFileSync(auditPath, "");
    const peer = makeTransport(root, {
      FAKE_AGENT_AUDIT: auditPath,
      FAKE_AGENT_DELAY_MS: "60"
    });
    await Promise.all([
      coalesced.requestJson({ systemPrompt: "system", input: { peer: 1 }, kind: "peer-first" }),
      peer.requestJson({ systemPrompt: "system", input: { peer: 2 }, kind: "peer-second" })
    ]);
    const sharedSerial = fs.readFileSync(auditPath, "utf8").trim().split(/\r?\n/).map(JSON.parse);
    assert.strictEqual(sharedSerial.length, 2);
    assert.ok(sharedSerial[0].endedAt <= sharedSerial[1].startedAt, JSON.stringify(sharedSerial));

    const requestRoot = path.join(root, ".runtime", "agent-requests");
    assert.deepStrictEqual(fs.existsSync(requestRoot) ? fs.readdirSync(requestRoot) : [], []);
    console.log("agent command transport smoke passed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

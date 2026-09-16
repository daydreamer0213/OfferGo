const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  loadModelSettings,
  resolveRuntimeModelConfig,
  isModelReady,
  saveVerifiedAgentConfiguration,
  saveVerifiedModelConfiguration,
  secretIdForSettings,
  settingsPath
} = require("../src/core/model_settings");
const { inspectSecret, loadSecret } = require("../src/core/secret_store");
const { createModelAdapter, StructuredModelAdapter } = require("../src/adapters/models");

const fallback = { provider: "mock", providers: { mock: { model: "offline-structured-mock" } } };
const apiVerified = async () => ({ status: "verified", checkedAt: new Date().toISOString(), latencyMs: 4, httpStatus: 200 });
const agentVerified = async ({ runnerId }) => ({
  status: "ready",
  runnerId,
  capabilityFingerprint: "fixture-capability-v1",
  identity: { runner: runnerId, model: "account-default", runnerVersion: "9.9.9" }
});

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "offergo-agent-settings-"));
  const freshRoot = fs.mkdtempSync(path.join(os.tmpdir(), "offergo-agent-settings-fresh-"));
  try {
    const initial = loadModelSettings({ root, fallbackModelConfig: fallback });
    assert.strictEqual(initial.settings.inferenceMode, "api");

    const api = await saveVerifiedModelConfiguration({
      root,
      fallbackModelConfig: fallback,
      connectionTester: apiVerified,
      input: { preset: "deepseek", model: "deepseek-v4-pro", apiKey: "preserved-api-key" }
    });
    const apiSecretId = secretIdForSettings(api.settings);
    assert.strictEqual(loadSecret(root, apiSecretId), "preserved-api-key");

    const saved = await saveVerifiedAgentConfiguration({
      root,
      fallbackModelConfig: fallback,
      agentConnectionTester: agentVerified,
      input: { inferenceMode: "agent", runnerId: "codex" }
    });
    assert.strictEqual(saved.settings.inferenceMode, "agent");
    assert.strictEqual(saved.settings.agent.runnerId, "codex");
    assert.strictEqual(saved.settings.agent.capabilityFingerprint, "fixture-capability-v1");
    assert.strictEqual(saved.settings.agent.identity.runnerVersion, "9.9.9");
    assert.strictEqual(isModelReady(saved, { taskProfile: "deep_analysis" }), true);
    assert.strictEqual(isModelReady(saved, { taskProfile: "batch_screening" }), true);
    assert.strictEqual(loadSecret(root, apiSecretId), "preserved-api-key", "Agent mode must preserve the saved API credential");

    const runtime = resolveRuntimeModelConfig({ root, fallbackModelConfig: fallback, taskProfile: "deep_analysis" });
    assert.strictEqual(runtime.modelConfig.provider, "agent_command");
    assert.strictEqual(runtime.modelConfig.providers.agent_command.runnerId, "codex");
    assert.strictEqual(runtime.modelConfig.providers.agent_command.dataRoot, root);
    assert.strictEqual(runtime.modelConfig.providers.agent_command.model, "account-default");
    assert.strictEqual(runtime.modelConfig.providers.agent_command.timeoutMs, 300000,
      "Agent runtime must allow for real Codex cold-start latency");
    assert.strictEqual(runtime.keyConfigured, false, "Agent runtime must not load an API credential");
    const adapter = createModelAdapter(runtime.modelConfig);
    assert.ok(adapter instanceof StructuredModelAdapter);
    assert.strictEqual(adapter.provider, "agent_command");

    const publicText = fs.readFileSync(settingsPath(root), "utf8");
    assert.ok(!publicText.includes("preserved-api-key"));
    assert.ok(!publicText.includes("apiKey"));

    const fresh = await saveVerifiedAgentConfiguration({
      root: freshRoot,
      fallbackModelConfig: fallback,
      agentConnectionTester: agentVerified,
      input: { inferenceMode: "agent", runnerId: "codex" }
    });
    assert.strictEqual(fresh.settings.inferenceMode, "agent");
    assert.strictEqual(inspectSecret(freshRoot, "model-api-key-shared-deepseek").stored, false);

    await assert.rejects(() => saveVerifiedAgentConfiguration({
      root,
      fallbackModelConfig: fallback,
      agentConnectionTester: agentVerified,
      input: { inferenceMode: "agent", runnerId: "arbitrary-command" }
    }), (error) => error.code === "MODEL_AGENT_RUNNER_INVALID");

    const backToApi = await saveVerifiedModelConfiguration({
      root,
      fallbackModelConfig: fallback,
      connectionTester: apiVerified,
      input: { preset: "deepseek", model: "deepseek-v4-pro" }
    });
    assert.strictEqual(backToApi.settings.inferenceMode, "api");
    assert.strictEqual(loadSecret(root, apiSecretId), "preserved-api-key");
    assert.strictEqual(resolveRuntimeModelConfig({ root, fallbackModelConfig: fallback }).modelConfig.provider, "openai_compatible");

    console.log("agent model settings smoke passed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(freshRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

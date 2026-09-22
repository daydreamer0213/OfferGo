const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createModelRuntimeCache, modelRuntimeFileSignature } = require("../src/application/model_runtime_cache");

let signature = "settings-v1";
let calls = 0;
const cache = createModelRuntimeCache({
  signature: () => signature,
  resolve: (taskProfile) => ({ taskProfile, generation: ++calls })
});

const first = cache.get("deep_analysis");
const repeated = cache.get("deep_analysis");
assert.strictEqual(first, repeated, "the same task profile and file signature must reuse one runtime state");
assert.strictEqual(calls, 1);

const batch = cache.get("batch_screening");
assert.strictEqual(batch.taskProfile, "batch_screening");
assert.strictEqual(calls, 2, "each task profile must resolve independently");

signature = "settings-v2";
const changed = cache.get("deep_analysis");
assert.notStrictEqual(changed, first, "a changed file signature must invalidate cached secrets and settings");
assert.strictEqual(changed.generation, 3);

cache.invalidate();
const invalidated = cache.get("deep_analysis");
assert.strictEqual(invalidated.generation, 4, "an explicit settings save must invalidate the runtime cache");

assert.throws(() => cache.get(""), /taskProfile/, "empty task profile names must be rejected");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "offergo-model-cache-"));
try {
  const settingsDir = path.join(root, ".runtime", "settings");
  const secretsDir = path.join(root, ".runtime", "secrets");
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.mkdirSync(secretsDir, { recursive: true });
  fs.writeFileSync(path.join(settingsDir, "model.json"), "{}\n");
  const beforeSecret = modelRuntimeFileSignature(root);
  fs.writeFileSync(path.join(secretsDir, "shared.dpapi"), "ciphertext-one");
  const afterSecret = modelRuntimeFileSignature(root);
  assert.notStrictEqual(afterSecret, beforeSecret, "adding a secret file must change the runtime signature");
  fs.writeFileSync(path.join(settingsDir, "model.json"), '{"schemaVersion":2}\n');
  assert.notStrictEqual(modelRuntimeFileSignature(root), afterSecret, "changing model settings must change the runtime signature");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("model_runtime_cache_smoke ok");

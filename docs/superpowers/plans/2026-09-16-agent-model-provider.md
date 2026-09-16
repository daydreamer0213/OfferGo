# OfferGo Agent Model Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow a user with a supported, already signed-in local Agent to use every OfferGo model feature without entering an API Key, while preserving the existing API Key path.

**Architecture:** Move the existing provider-neutral prompts, task orchestration, contract validation, and repair into `StructuredModelAdapter`, then give it either an OpenAI-compatible HTTP transport or a generic JSON-over-stdio Agent transport. The first bundled Agent runner invokes Codex in an isolated ephemeral invocation; future Agents only need another runner that implements the same request/response protocol.

**Tech Stack:** Node.js 22 CommonJS, `node:child_process`, AbortSignal, JSON/JSON Schema, existing SQLite/settings stores, existing server-rendered dashboard, Windows PowerShell packaging, current smoke-test harness.

## Global Constraints

- API Key mode must preserve the current encrypted-secret, model-quality, retry, and error behavior.
- Agent mode must cover all existing model tasks; no later feature may unexpectedly ask for an API Key.
- Agent credentials must never be read, copied, displayed, logged, or saved by OfferGo.
- Model inputs go through child-process stdin, never command arguments, settings JSON, SQLite, or logs.
- Browser forms must select an allowlisted `runnerId`; they must not accept an arbitrary executable or command string.
- Agent invocations use an empty per-request working directory, ephemeral sessions, ignored project/user rules, read-only sandboxing, bounded output, timeout, cancellation, and cleanup.
- Agent model tasks must not gain recruitment-browser control or permission to send messages.
- Do not silently switch between Agent and API billing paths.
- Each runner is serial. Identical in-flight requests coalesce; refresh/repeated clicks cannot create duplicate Agent processes.
- Use capability probing rather than a hard-coded Codex version comparison.
- Real acceptance starts with synthetic resume/JD data and performs no recruitment-platform write.
- Preserve JD coverage, recall, and matching quality; the transport change cannot weaken existing output contracts.

---

## File Map

- Create `src/adapters/models/structured.js`: provider-neutral model task methods, prompts, split matching, contract validation, and repair.
- Create `src/adapters/models/openai_transport.js`: existing OpenAI-compatible HTTP request, parsing, adaptive token budget, retry, and safe upstream error logic.
- Keep `src/adapters/models/openai_compatible.js`: backward-compatible composition wrapper exporting `OpenAICompatibleAdapter`, `extractContent`, and `parseJsonContent`.
- Create `src/adapters/models/agent_protocol.js`: protocol version, request/response validation, stable Agent error construction, output bounds, and fingerprints.
- Create `src/adapters/models/agent_command_transport.js`: serialized/coalesced JSON-over-stdio child-process transport.
- Create `src/adapters/models/agent_runners/codex.js`: one-request runner that capability-checks and invokes `codex exec` safely.
- Create `src/adapters/models/agent_runner_registry.js`: allowlisted runner discovery and capability probes.
- Modify `src/adapters/models/index.js`: construct `agent_command` as well as existing providers.
- Modify `src/core/model_settings.js`: persist model mode/runner metadata, test Agent connection, and produce runtime configs.
- Modify `src/dashboard/server.js`: Agent settings endpoints, setup readiness, and UI.
- Modify `src/dashboard/assets/runtime.js`: small client-side model-mode visibility and pending-state behavior if server-rendered controls are insufficient.
- Modify `tests/run_all.js`: register the new focused checks.
- Create `tests/structured_model_adapter_smoke.js`, `tests/agent_command_transport_smoke.js`, `tests/codex_agent_runner_smoke.js`, and `tests/agent_model_settings_smoke.js`.
- Create `tests/fixtures/fake_agent_runner.js`: deterministic protocol peer controlled only by fixture environment variables and stdin.
- Create `docs/agent-assisted-install.md`: agent-readable source installation and safety procedure.
- Modify `docs/onboarding_workflow.md`, `docs/product_spec.md`, and `docs/operations.md`: user path, supported modes, diagnostics, and privacy boundary.

---

### Task 1: Extract the Provider-Neutral Structured Model Adapter

**Files:**
- Create: `src/adapters/models/structured.js`
- Create: `src/adapters/models/openai_transport.js`
- Modify: `src/adapters/models/openai_compatible.js`
- Create: `tests/structured_model_adapter_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- Consumes: current `validateModelResult(kind, value, context)`, split semantic matching helpers, and existing OpenAI-compatible configuration.
- Produces: `new StructuredModelAdapter({ transport, provider, model, thinkingMode, reasoningEffort, logger })`; transport contract `requestJson({ systemPrompt, input, kind, signal }): Promise<object>`; backward-compatible `new OpenAICompatibleAdapter(config)`.

- [x] **Step 1: Add a failing provider-neutral delegation test**

Create `tests/structured_model_adapter_smoke.js` with a recording transport and representative tasks:

```js
const assert = require("node:assert");
const { StructuredModelAdapter } = require("../src/adapters/models/structured");

const calls = [];
const transport = {
  async requestJson(request) {
    calls.push(request);
    if (request.kind === "reviewMockInterviewRetry") {
      return { turnNumber: 1, conclusion: "表达更清楚", improved: true, strengths: [], remainingImprovements: [] };
    }
    throw new Error(`unexpected kind: ${request.kind}`);
  }
};

(async () => {
  const adapter = new StructuredModelAdapter({ transport, provider: "fixture", model: "fixture-model" });
  const result = await adapter.reviewMockInterviewRetry({
    turn: { turnNumber: 1, originalAnswer: "原回答", retryAnswer: "新回答" }
  });
  assert.strictEqual(result.improved, true);
  assert.strictEqual(calls[0].kind, "reviewMockInterviewRetry");
  assert.match(calls[0].systemPrompt, /只比较/);
  assert.deepStrictEqual(calls[0].input.turn.turnNumber, 1);
  console.log("structured model adapter smoke passed");
})().catch((error) => { console.error(error); process.exit(1); });
```

- [x] **Step 2: Run the new test and verify the missing-module failure**

Run: `node tests/structured_model_adapter_smoke.js`

Expected: FAIL because `src/adapters/models/structured.js` does not exist.

- [x] **Step 3: Move model task behavior behind a transport interface**

Move the public task methods and provider-neutral helpers from `openai_compatible.js` into `StructuredModelAdapter`. Its only raw model call is:

```js
async chatJson(systemPrompt, input, { kind = "unknown", signal = null } = {}) {
  return this.transport.requestJson({ systemPrompt, input, kind, signal });
}
```

Keep every existing validation call at its current task/service boundary. Keep split matching, repair inputs, output normalization, and all current prompts byte-for-byte unless an import boundary requires movement. Do not add blanket validation in `chatJson` and do not change matching rules or error semantics.

Move HTTP-only logic into `OpenAICompatibleTransport`:

```js
class OpenAICompatibleTransport {
  constructor(config = {}) { /* current HTTP fields */ }
  async requestJson({ systemPrompt, input, kind, signal }) {
    // current chatJson retry/json-mode/adaptive-budget flow
  }
}
```

Make the compatibility adapter composition explicit:

```js
class OpenAICompatibleAdapter extends StructuredModelAdapter {
  constructor(config = {}) {
    const transport = new OpenAICompatibleTransport(config);
    super({
      transport,
      provider: "openai_compatible",
      model: transport.model,
      thinkingMode: transport.thinkingMode,
      reasoningEffort: transport.reasoningEffort,
      logger: config.logger
    });
    this.transport = transport;
  }
}
```

Re-export the current parser helpers from `openai_compatible.js` so all existing callers remain valid.

- [x] **Step 4: Register and run the focused behavior-preservation tests**

Add `structured_model_adapter_smoke.js` next to `model_adapter_smoke.js` in `tests/run_all.js`.

Run:

```powershell
node tests/structured_model_adapter_smoke.js
node tests/model_adapter_smoke.js
node tests/model_parser_resilience_smoke.js
node tests/profile_quality_smoke.js
node tests/semantic_pipeline_smoke.js
```

Expected: all pass with existing OpenAI request bodies, retries, validation, and output behavior unchanged.

- [x] **Step 5: Commit the behavior-preserving extraction**

```powershell
git add src/adapters/models/structured.js src/adapters/models/openai_transport.js src/adapters/models/openai_compatible.js tests/structured_model_adapter_smoke.js tests/run_all.js
git commit -m "refactor: separate model tasks from transport"
```

---

### Task 2: Add the Generic Agent Protocol and Safe Process Transport

**Files:**
- Create: `src/adapters/models/agent_protocol.js`
- Create: `src/adapters/models/agent_command_transport.js`
- Create: `tests/fixtures/fake_agent_runner.js`
- Create: `tests/agent_command_transport_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- Consumes: `ModelTransport.requestJson({ systemPrompt, input, kind, signal })` from Task 1.
- Produces: `new AgentCommandTransport({ runnerId, command, args, dataRoot, timeoutMs, maxOutputBytes, logger })`; `makeAgentRequest`, `parseAgentResponse`, `agentRequestFingerprint`; protocol version `1`.

- [x] **Step 1: Write protocol and process failure tests**

The fake runner reads one JSON line from stdin and selects behavior using `FAKE_AGENT_MODE`. The test must assert valid success plus invalid JSON, request-ID mismatch, oversized output, non-zero exit, timeout, abort, and input secrecy:

```js
const transport = new AgentCommandTransport({
  runnerId: "fixture",
  command: process.execPath,
  args: [path.join(__dirname, "fixtures", "fake_agent_runner.js")],
  dataRoot: root,
  timeoutMs: 500,
  maxOutputBytes: 4096,
  env: { ...process.env, FAKE_AGENT_MODE: "success", FAKE_AGENT_AUDIT: auditPath }
});
const result = await transport.requestJson({
  systemPrompt: "secret-system-marker",
  input: { resume: "secret-resume-marker" },
  kind: "fixture"
});
assert.deepStrictEqual(result, { accepted: true });
assert.ok(!JSON.stringify(transport.lastSpawn || {}).includes("secret-resume-marker"));
```

Two simultaneous identical calls must increment the fixture process counter once. Two different calls must record non-overlapping start/end intervals.

- [x] **Step 2: Run the test and verify missing transport failure**

Run: `node tests/agent_command_transport_smoke.js`

Expected: FAIL because the protocol and transport modules do not exist.

- [x] **Step 3: Implement strict protocol validation**

Implement protocol construction and parsing around these shapes:

```js
const AGENT_PROTOCOL_VERSION = 1;

function makeAgentRequest({ requestId, taskKind, systemPrompt, input, outputSchema, timeoutMs, maxOutputBytes }) {
  return { protocolVersion: 1, requestId, taskKind, systemPrompt, input, outputSchema, limits: { timeoutMs, maxOutputBytes } };
}

function parseAgentResponse(text, requestId) {
  const value = parseSingleJsonObject(text);
  if (value.protocolVersion !== 1 || value.requestId !== requestId) throw agentError("MODEL_AGENT_PROTOCOL_INVALID");
  if (value.ok !== true) throw agentResponseError(value.error);
  if (!value.result || typeof value.result !== "object" || Array.isArray(value.result)) throw agentError("MODEL_AGENT_PROTOCOL_INVALID");
  return { result: value.result, identity: normalizeIdentity(value.identity) };
}
```

Only allow documented error codes and bounded messages. Hash the stable task inputs plus runner/model revision for coalescing; never place raw input in the fingerprint or logs.

- [x] **Step 4: Implement serial/coalesced child-process execution**

Use `spawn(command, args, { shell: false, windowsHide: true, cwd: requestDir, stdio: ["pipe", "pipe", "pipe"] })`. Write exactly one request to stdin, close it, and bound stdout/stderr while reading. Store no raw stderr after converting it to a stable error. Use a promise tail per transport and a map of fingerprints to in-flight promises:

```js
requestJson(input) {
  const fingerprint = agentRequestFingerprint(input, this.identityRevision);
  const existing = this.inFlight.get(fingerprint);
  if (existing) return existing;
  const pending = this.tail.then(() => this.runRequest(input), () => this.runRequest(input));
  this.tail = pending.then(() => undefined, () => undefined);
  this.inFlight.set(fingerprint, pending);
  return pending.finally(() => {
    if (this.inFlight.get(fingerprint) === pending) this.inFlight.delete(fingerprint);
  });
}
```

On timeout or abort, terminate the process tree with a bounded grace period. Resolve and verify the temporary request directory remains under `<dataRoot>/.runtime/agent-requests` before cleanup.

- [x] **Step 5: Run transport tests and add them to the full gate**

Run: `node tests/agent_command_transport_smoke.js`

Expected: PASS, one process for duplicate input, serial timestamps for distinct input, stable error codes, and no secret marker in arguments/log capture.

Register `agent_command_transport_smoke.js` in `tests/run_all.js`.

- [x] **Step 6: Commit the generic transport**

```powershell
git add src/adapters/models/agent_protocol.js src/adapters/models/agent_command_transport.js tests/fixtures/fake_agent_runner.js tests/agent_command_transport_smoke.js tests/run_all.js
git commit -m "feat: add generic agent model transport"
```

---

### Task 3: Implement the Allowlisted Codex Runner

**Files:**
- Create: `src/adapters/models/agent_runners/codex.js`
- Create: `src/adapters/models/agent_runner_registry.js`
- Create: `tests/codex_agent_runner_smoke.js`
- Create: `tests/fixtures/fake_codex_cli.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- Consumes: Agent protocol v1 from Task 2.
- Produces: `getAgentRunner("codex")`, `probeAgentRunner({ runnerId, env })`, and a protocol-speaking Codex runner executable invoked through `process.execPath`.

- [x] **Step 1: Write failing capability and invocation tests**

Put a fake `codex` executable first on a temporary PATH. It records argv/cwd/stdin and can simulate help, success, auth, quota, malformed output, timeout, and cancellation. Assertions must include:

```js
assert.strictEqual(probe.status, "ready");
assert.ok(invocation.args.includes("exec"));
assert.ok(invocation.args.includes("--ephemeral"));
assert.ok(invocation.args.includes("--sandbox"));
assert.ok(invocation.args.includes("read-only"));
assert.ok(invocation.args.includes("--ignore-user-config"));
assert.ok(invocation.args.includes("--ignore-rules"));
assert.ok(!invocation.args.join(" ").includes("secret-resume-marker"));
assert.notStrictEqual(invocation.cwd, projectRoot);
```

Also assert that missing flags produce `update_required`, a login failure produces `MODEL_AGENT_AUTH_REQUIRED`, and a quota response produces `MODEL_AGENT_QUOTA_EXHAUSTED`.

- [x] **Step 2: Run the test and verify missing runner failure**

Run: `node tests/codex_agent_runner_smoke.js`

Expected: FAIL because the runner registry does not exist.

- [x] **Step 3: Implement the runner registry and capability probe**

Use a source-owned allowlist:

```js
const RUNNERS = Object.freeze({
  codex: {
    id: "codex",
    label: "Codex",
    modulePath: require.resolve("./agent_runners/codex")
  }
});
```

The probe resolves `codex` from PATH, runs `codex exec --help`, checks the exact required flags, then runs a bounded non-sensitive round trip returning `{ ok: true }`. Report only `ready`, `not_installed`, `update_required`, `auth_required`, or `unavailable`, plus a safe action message and capability fingerprint.

- [x] **Step 4: Implement isolated Codex execution**

The runner reads the protocol request from stdin, writes a permissive object JSON Schema into its request directory, and invokes Codex without shell interpolation. Use capability-confirmed arguments equivalent to:

```js
[
  "exec", "--ephemeral", "--skip-git-repo-check",
  "--ignore-user-config", "--ignore-rules",
  "--sandbox", "read-only",
  "--output-schema", schemaPath,
  "--output-last-message", resultPath,
  "--cd", isolatedWorkingDirectory,
  "-"
]
```

Build the stdin prompt from the system prompt plus a JSON data block and an explicit ban on tools, file reads, file writes, browsing, and external actions. Parse exactly one JSON object from the last-message file. Convert known CLI failures to stable protocol errors without returning raw stderr.

- [x] **Step 5: Run the fake Codex tests and register them**

Run: `node tests/codex_agent_runner_smoke.js`

Expected: PASS with no prompt content in argv, isolated cwd, required flags, correct auth/quota mapping, and cleanup after every outcome.

Register `codex_agent_runner_smoke.js` in `tests/run_all.js`.

- [x] **Step 6: Commit the Codex runner**

```powershell
git add src/adapters/models/agent_runners/codex.js src/adapters/models/agent_runner_registry.js tests/codex_agent_runner_smoke.js tests/fixtures/fake_codex_cli.js tests/run_all.js
git commit -m "feat: add isolated Codex model runner"
```

---

### Task 4: Add Agent Mode to Model Settings and Runtime Construction

**Files:**
- Modify: `src/adapters/models/index.js`
- Modify: `src/core/model_settings.js`
- Create: `tests/agent_model_settings_smoke.js`
- Modify: `tests/model_settings_smoke.js`
- Modify: `tests/model_task_profiles_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- Consumes: `AgentCommandTransport`, runner registry, and `StructuredModelAdapter`.
- Produces: persisted `inferenceMode: "api" | "agent"`; `agent: { runnerId, capabilityFingerprint, verifiedAt, identity }`; runtime provider `agent_command`; `testAgentConnection({ root, runnerId, ... })`.

- [x] **Step 1: Write failing settings persistence and runtime tests**

Cover legacy settings defaulting to API mode, Agent save without a Key, invalid runner rejection, no credential-store write, separate task-profile revisions, and runtime config:

```js
const saved = await saveVerifiedAgentConfiguration({
  root,
  input: { inferenceMode: "agent", runnerId: "codex" },
  fallbackModelConfig,
  agentConnectionTester: async () => ({
    status: "ready",
    capabilityFingerprint: "cap-v1",
    identity: { runner: "codex", model: "default", runnerVersion: "fixture" }
  })
});
assert.strictEqual(saved.inferenceMode, "agent");
assert.strictEqual(loadModelRuntime({ root, taskProfile: "deep_analysis" }).modelConfig.provider, "agent_command");
assert.strictEqual(inspectSecret(root, "model-api-key-shared").configured, false);
```

Assert switching modes does not delete an already saved API Key and does not silently use it in Agent mode.

- [x] **Step 2: Run settings tests and verify the missing API**

Run: `node tests/agent_model_settings_smoke.js`

Expected: FAIL because `saveVerifiedAgentConfiguration` is not exported.

- [x] **Step 3: Extend normalized settings without breaking legacy files**

Normalize absent `inferenceMode` to `api`. Store Agent metadata separately from shared/independent API credentials. Do not include executable paths or commands in saved settings. Compute task-profile revisions from mode, runner ID, capability fingerprint, identity, and existing task parameters.

Runtime construction for Agent mode must produce:

```js
{
  provider: "agent_command",
  providers: {
    agent_command: {
      runnerId: "codex",
      dataRoot: root,
      model: identity.model || "default",
      runnerVersion: identity.runnerVersion || "unknown",
      timeoutMs: profile.timeoutMs,
      maxRetries: profile.maxRetries
    }
  }
}
```

API mode continues to use `modelConfigFromProfile` and the encrypted secret store.

- [x] **Step 4: Construct the Agent adapter from the central factory**

In `src/adapters/models/index.js`, add only the generic provider branch:

```js
if (provider === "agent_command") {
  const runner = getAgentRunner(providerConfig.runnerId);
  const transport = new AgentCommandTransport({ ...runner.commandSpec(providerConfig), ...providerConfig, logger: options.logger });
  return new StructuredModelAdapter({
    transport,
    provider: "agent_command",
    model: providerConfig.model || providerConfig.runnerId,
    logger: options.logger
  });
}
```

Do not add Codex-specific conditions to `StructuredModelAdapter`, workflow services, or dashboard controllers.

- [x] **Step 5: Run focused settings and factory tests**

Run:

```powershell
node tests/agent_model_settings_smoke.js
node tests/model_settings_smoke.js
node tests/model_task_profiles_smoke.js
node tests/analyzer_initialization_smoke.js
```

Expected: all pass; legacy/API settings remain compatible, and Agent mode constructs one generic adapter.

- [x] **Step 6: Register and commit Agent settings**

Add `agent_model_settings_smoke.js` to `tests/run_all.js`, then:

```powershell
git add src/adapters/models/index.js src/core/model_settings.js tests/agent_model_settings_smoke.js tests/model_settings_smoke.js tests/model_task_profiles_smoke.js tests/run_all.js
git commit -m "feat: add keyless agent model settings"
```

---

### Task 5: Add the Agent Setup Experience to the Dashboard

**Files:**
- Modify: `src/dashboard/server.js`
- Modify: `src/dashboard/assets/runtime.js`
- Modify: `tests/model_settings_ui_smoke.js`
- Modify: `tests/onboarding_progress_ui_smoke.js`

**Interfaces:**
- Consumes: public normalized settings, `probeAgentRunner`, and `saveVerifiedAgentConfiguration` from Task 4.
- Produces: settings form field `inferenceMode`; Agent status card; POST action for test-and-save; first-run readiness satisfied by either verified API or verified Agent mode.

- [x] **Step 1: Write failing dashboard tests**

Extend `model_settings_ui_smoke.js` to assert:

```js
assert.match(page, /使用 API Key/);
assert.match(page, /使用本机 Agent/);
assert.match(page, /免填 API Key不等于免费|免填 API Key.*套餐额度/);
assert.doesNotMatch(agentSection, /name="apiKey"/);
```

Post Agent mode with an injected delayed tester and assert the local GET remains responsive, two identical saves invoke the tester once, success redirects with `modelConfigured=1`, and auth/update/quota errors render an exact next action. Extend onboarding tests so a verified Agent configuration unlocks the same next step as a verified API configuration.

- [x] **Step 2: Run UI tests and verify they fail on missing mode controls**

Run:

```powershell
node tests/model_settings_ui_smoke.js
node tests/onboarding_progress_ui_smoke.js
```

Expected: FAIL because the Agent option is absent.

- [x] **Step 3: Render server-owned mode controls and status**

Add a two-choice mode selector above the existing API settings. Agent mode renders only allowlisted runners, detection status, safe action text, “测试并使用本机 Agent”, last verification metadata, and disclosure that resume/JD content goes to the Agent provider and consumes that account's allowance.

Keep the existing API form intact inside its mode panel. Client JavaScript only toggles panels and disables a form during its own request; server validation remains authoritative.

- [x] **Step 4: Add serialized/coalesced save handling**

Reuse the existing model-settings save flight/tail mechanism. Fingerprint Agent saves using normalized mode and runner ID, never private input. The POST operation calls the injected `agentConnectionTester`, persists only after success, and redirects. Stable errors return to the Agent panel with no partial “verified” state.

- [x] **Step 5: Verify dashboard and onboarding behavior**

Run:

```powershell
node tests/model_settings_ui_smoke.js
node tests/onboarding_progress_ui_smoke.js
node tests/dashboard_shell_smoke.js
node tests/dashboard_runtime_smoke.js
```

Expected: all pass; API UI remains available, Agent mode needs no Key, duplicate tests coalesce, and other local pages remain responsive.

- [x] **Step 6: Commit the Agent settings UI**

```powershell
git add src/dashboard/server.js src/dashboard/assets/runtime.js tests/model_settings_ui_smoke.js tests/onboarding_progress_ui_smoke.js
git commit -m "feat: add local Agent setup flow"
```

---

### Task 6: Cover Every Model Task Through the Agent Transport

**Files:**
- Modify: `tests/structured_model_adapter_smoke.js`
- Modify: `tests/agent_command_transport_smoke.js`
- Modify: `tests/resume_optimization_service_smoke.js`
- Modify: `tests/mock_interview_service_smoke.js`
- Modify: `tests/message_reply_learning_smoke.js`
- Modify: `tests/workflow_analysis_executor_smoke.js`

**Interfaces:**
- Consumes: generic `agent_command` runtime from Task 4.
- Produces: regression evidence that all product model entry points use the same Agent transport and retain current workflow recovery semantics.

- [x] **Step 1: Add a contract fixture for every public model method**

Build a map keyed by the full public adapter surface:

```js
const CASES = {
  analyzeResume: { input: resumeInput, output: validCandidateProfile },
  recommendSearchPlan: { input: planInput, output: validSearchPlan },
  buildCandidateMatchCard: { input: cardInput, output: validMatchingCard },
  understandJob: { input: jobInput, output: validJobUnderstanding },
  matchJob: { input: matchInput, output: validMatchDecision },
  draftCommunication: { input: draftInput, output: validDraft },
  draftMessageGroup: { input: groupInput, output: validGroup },
  extractReplyEditFacts: { input: editInput, output: validFacts },
  generateResumeOptimization: { input: optimizationInput, output: validOptimization },
  generateMockInterviewStep: { input: interviewInput, output: validInterviewStep },
  reviewMockInterview: { input: reviewInput, output: validReview },
  reviewMockInterviewRetry: { input: retryInput, output: validRetryReview }
};
```

For split matching, assert both evidence stages travel through the same transport and local combination/validation still runs.

- [x] **Step 2: Run the expanded test and identify uncovered task behavior**

Run: `node tests/structured_model_adapter_smoke.js`

Expected before fixture completion: FAIL on the first missing/invalid task response.

- [x] **Step 3: Complete generic transport routing without per-feature Agent branches**

Fix only shared adapter/transport boundaries. Do not add Agent checks to resume optimization, interviews, message learning, job analysis, or workflow services. Those callers must keep using `createModelAdapter(modelConfig)`.

- [x] **Step 4: Verify recovery, cancellation, and no API-Key dependency**

Run:

```powershell
node tests/structured_model_adapter_smoke.js
node tests/resume_optimization_service_smoke.js
node tests/mock_interview_service_smoke.js
node tests/message_reply_learning_smoke.js
node tests/workflow_analysis_executor_smoke.js
```

Expected: all pass; Agent auth/config errors pause or fail through existing stable model error paths, and cancellation reaches the child process.

- [x] **Step 5: Commit full feature coverage**

```powershell
git add tests/structured_model_adapter_smoke.js tests/agent_command_transport_smoke.js tests/resume_optimization_service_smoke.js tests/mock_interview_service_smoke.js tests/message_reply_learning_smoke.js tests/workflow_analysis_executor_smoke.js src/adapters/models src/core
git commit -m "test: cover all model tasks through Agent transport"
```

---

### Task 7: Document Agent-Assisted Installation and Operational Safety

**Files:**
- Create: `docs/agent-assisted-install.md`
- Modify: `docs/onboarding_workflow.md`
- Modify: `docs/product_spec.md`
- Modify: `docs/operations.md`
- Modify: `tests/startup_scripts_smoke.js`
- Modify: `tests/windows_installer_smoke.js`

**Interfaces:**
- Consumes: final UI labels, runner statuses, and diagnostics from Tasks 3–5.
- Produces: a deterministic agent-readable install path and packaging checks that the runner ships in source and installer builds.

- [x] **Step 1: Add failing packaging/source assertions**

Assert source and staged installer include:

```js
for (const relative of [
  "src/adapters/models/agent_protocol.js",
  "src/adapters/models/agent_command_transport.js",
  "src/adapters/models/agent_runners/codex.js",
  "docs/agent-assisted-install.md"
]) assert.ok(fs.existsSync(path.join(stageRoot, relative)), relative);
```

Run: `node tests/windows_installer_smoke.js`

Expected: FAIL until the new files are included by the normal stage/build path.

- [x] **Step 2: Write the deterministic installation guide**

The guide tells an installing Agent to download the repository, preserve private data boundaries, use D: for large generated data when available, verify Node/Edge/Codex capabilities, run `npm test`, build or launch using existing scripts, open the local settings page, and stop before recruitment login or external sends. Include exact success signals and recovery instructions; never tell the Agent to inspect credentials.

- [x] **Step 3: Update product and operations documentation**

Document both model modes, allowance disclosure, stable Agent errors, non-sensitive diagnostics, no automatic billing-path fallback, and synthetic-first acceptance. Update first-use flow so either a verified API connection or a verified Agent connection satisfies model readiness.

- [x] **Step 4: Run startup and packaging checks**

Run:

```powershell
node tests/startup_scripts_smoke.js
node tests/windows_installer_smoke.js
node tests/cross_machine_runtime_smoke.js
```

Expected: all pass; no global Codex install is accidentally bundled, and the app resolves the user's existing CLI at runtime.

- [ ] **Step 5: Commit documentation and packaging coverage**

```powershell
git add docs/agent-assisted-install.md docs/onboarding_workflow.md docs/product_spec.md docs/operations.md tests/startup_scripts_smoke.js tests/windows_installer_smoke.js
git commit -m "docs: add Agent-assisted OfferGo setup"
```

---

### Task 8: Run the Full Gate and Real Codex Synthetic Acceptance

**Files:**
- Modify if evidence requires a fix: only files already listed in Tasks 1–7.
- Create outside Git: `D:\DevData\OfferGo-agent-provider-acceptance-20260916\` for temporary data, logs, synthetic fixtures, and receipts.

**Interfaces:**
- Consumes: the complete implementation.
- Produces: exact-SHA offline gate, installed-stage self-check, synthetic Codex acceptance receipt, and a clean branch.

- [ ] **Step 1: Run focused checks from a clean process**

```powershell
node tests/structured_model_adapter_smoke.js
node tests/agent_command_transport_smoke.js
node tests/codex_agent_runner_smoke.js
node tests/agent_model_settings_smoke.js
node tests/model_settings_ui_smoke.js
```

Expected: all pass.

- [ ] **Step 2: Run the complete offline gate with D: temporary/cache paths**

```powershell
$env:TEMP='D:\DevData\OfferGo-agent-provider-acceptance-20260916\temp'
$env:TMP=$env:TEMP
$env:npm_config_cache='D:\DevData\npm-cache'
npm test
```

Expected: every registered offline check passes; optional checks may skip only through their existing explicit skip behavior.

- [ ] **Step 3: Build and self-check an isolated candidate**

Use `scripts/build-installer.ps1` with build/output roots under `D:\DevData\OfferGo-agent-provider-acceptance-20260916`. Run `scripts/installed-self-check.ps1` against the staged install and a fresh isolated data root. Expected: `SELF_CHECK_OK`, no old user database/profile copied, and the Agent runner files present.

- [ ] **Step 4: Run real Codex synthetic model acceptance**

Use the existing logged-in Codex CLI with a fresh OfferGo data root. Do not open BOSS/智联. Verify connection plus all task kinds using synthetic resume, JD, HR message, and interview answers. Record only task kind, duration, stable status, model identity, process cleanup result, and hashes of synthetic fixtures; exclude prompts and model output bodies.

Expected: no API Key saved, all task contracts pass, no project files change, no resumable Codex session is created for the calls, cancellation leaves no child process, and logs contain no synthetic secret marker.

- [ ] **Step 5: Verify the final tree and commit any receipt documentation intended for Git**

```powershell
git diff --check
git status --short
git rev-parse HEAD
```

Keep private/runtime receipts under `D:\DevData`, not Git. If the implementation already has commits and the tree is clean, do not add an empty completion commit.

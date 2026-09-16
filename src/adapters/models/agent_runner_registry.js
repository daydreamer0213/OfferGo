const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { AgentCommandTransport } = require("./agent_command_transport");

const REQUIRED_CODEX_FLAGS = Object.freeze([
  "--ephemeral",
  "--skip-git-repo-check",
  "--ignore-user-config",
  "--ignore-rules",
  "--sandbox",
  "--output-schema",
  "--output-last-message",
  "--cd"
]);

const RUNNERS = Object.freeze({
  codex: Object.freeze({
    id: "codex",
    label: "Codex",
    modulePath: require.resolve("./agent_runners/codex"),
    commandSpec({ env = process.env, capabilityFingerprint = "codex-unprobed" } = {}) {
      return {
        command: process.execPath,
        args: [require.resolve("./agent_runners/codex")],
        env: { ...env },
        identityRevision: capabilityFingerprint
      };
    }
  })
});

function getAgentRunner(runnerId) {
  const runner = RUNNERS[String(runnerId || "")];
  if (!runner) throw new Error(`不支持的本机 Agent：${String(runnerId || "未选择")}`);
  return runner;
}

function listAgentRunners() {
  return Object.values(RUNNERS).map(({ id, label }) => ({ id, label }));
}

async function probeAgentRunner({ runnerId, env = process.env, dataRoot, connectionTest = true } = {}) {
  const runner = getAgentRunner(runnerId);
  const command = String(env.OFFERGO_CODEX_COMMAND || "codex");
  const prefix = parseArgsPrefix(env.OFFERGO_CODEX_ARGS_JSON);
  let versionResult;
  try {
    versionResult = await capture(command, [...prefix, "--version"], { env, timeoutMs: 10000 });
  } catch (error) {
    if (error?.code === "ENOENT") return probeResult("not_installed", runner, "没有找到 Codex，请先安装。" );
    return probeResult("unavailable", runner, "暂时无法启动 Codex，请检查安装。" );
  }
  if (versionResult.code !== 0) return probeResult("unavailable", runner, "暂时无法读取 Codex 版本。" );
  const version = parseVersion(versionResult.stdout);
  const helpResult = await capture(command, [...prefix, "exec", "--help"], { env, timeoutMs: 10000 });
  if (helpResult.code !== 0) return probeResult("unavailable", runner, "暂时无法检查 Codex 能力。" );
  const missing = REQUIRED_CODEX_FLAGS.filter((flag) => !helpResult.stdout.includes(flag));
  if (missing.length) {
    return {
      ...probeResult("update_required", runner, "当前 Codex 版本缺少安全运行能力，请更新 Codex。"),
      runnerVersion: version,
      missingCapabilities: missing
    };
  }
  const capabilityFingerprint = crypto.createHash("sha256")
    .update(JSON.stringify({ runnerId, version, flags: REQUIRED_CODEX_FLAGS }))
    .digest("hex");
  const identity = { runner: runner.id, model: "account-default", runnerVersion: version };
  if (!connectionTest) return { status: "ready", runnerId: runner.id, label: runner.label, capabilityFingerprint, identity };
  const runtimeEnv = { ...env, OFFERGO_CODEX_VERSION: version };
  const spec = runner.commandSpec({ env: runtimeEnv, capabilityFingerprint });
  const transport = new AgentCommandTransport({
    ...spec,
    runnerId: runner.id,
    dataRoot,
    timeoutMs: 60000,
    maxOutputBytes: 65536
  });
  try {
    const result = await transport.requestJson({
      systemPrompt: "Return exactly one JSON object with ok set to true.",
      input: { connectionTest: true },
      kind: "connectionTest",
      outputSchema: {
        type: "object",
        properties: { ok: { type: "boolean", const: true } },
        required: ["ok"],
        additionalProperties: false
      }
    });
    if (result.ok !== true) return probeResult("unavailable", runner, "Codex 已响应，但连接测试结果无效。" );
    return { status: "ready", runnerId: runner.id, label: runner.label, capabilityFingerprint, identity };
  } catch (error) {
    if (error?.code === "MODEL_AGENT_AUTH_REQUIRED") return probeResult("auth_required", runner, error.message);
    if (error?.code === "MODEL_AGENT_QUOTA_EXHAUSTED") return probeResult("unavailable", runner, error.message, { errorCode: error.code });
    return probeResult("unavailable", runner, "Codex 连接测试失败，请检查网络和账号状态。", { errorCode: error?.code || "MODEL_AGENT_UNAVAILABLE" });
  }
}

function capture(command, args, { env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { if (stdout.length < 131072) stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { if (stderr.length < 131072) stderr += chunk.toString("utf8"); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ code: Number(code), stdout, stderr }); });
  });
}

function probeResult(status, runner, message, extra = {}) {
  return { status, runnerId: runner.id, label: runner.label, message, ...extra };
}

function parseVersion(value) {
  return String(value || "").match(/\d+\.\d+\.\d+(?:[-.][\w.]+)?/)?.[0] || "unknown";
}

function parseArgsPrefix(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch { return []; }
}

module.exports = { REQUIRED_CODEX_FLAGS, getAgentRunner, listAgentRunners, probeAgentRunner };

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  makeAgentRequest,
  parseAgentResponse,
  agentRequestFingerprint,
  agentError
} = require("./agent_protocol");

const RUNNER_SCHEDULERS = new Map();

class AgentCommandTransport {
  constructor(config = {}) {
    this.runnerId = requiredText(config.runnerId, "runnerId");
    this.command = requiredText(config.command, "command");
    this.args = Array.isArray(config.args) ? config.args.map(String) : [];
    this.dataRoot = path.resolve(requiredText(config.dataRoot, "dataRoot"));
    this.timeoutMs = boundedInteger(config.timeoutMs, 120000, 10, 600000);
    this.maxOutputBytes = boundedInteger(config.maxOutputBytes, 1048576, 1024, 8388608);
    this.env = config.env && typeof config.env === "object" ? { ...config.env } : { ...process.env };
    this.logger = config.logger || null;
    this.identityRevision = String(config.identityRevision || this.runnerId);
    this.scheduler = runnerScheduler(this.runnerId, this.identityRevision, this.command, this.args);
    this.lastIdentity = { runner: this.runnerId, model: "default", runnerVersion: "unknown" };
  }

  requestJson(input = {}) {
    const fingerprint = agentRequestFingerprint(input, this.identityRevision);
    const existing = this.scheduler.inFlight.get(fingerprint);
    if (existing) return existing;
    const operation = () => this.runRequest(input);
    const pending = this.scheduler.tail.then(operation, operation);
    this.scheduler.tail = pending.then(() => undefined, () => undefined);
    this.scheduler.inFlight.set(fingerprint, pending);
    pending.finally(() => {
      if (this.scheduler.inFlight.get(fingerprint) === pending) this.scheduler.inFlight.delete(fingerprint);
    }).catch(() => undefined);
    return pending;
  }

  async runRequest(input) {
    const requestId = crypto.randomUUID();
    const request = makeAgentRequest({
      requestId,
      taskKind: input.kind || "unknown",
      systemPrompt: input.systemPrompt,
      input: input.input,
      outputSchema: input.outputSchema,
      timeoutMs: this.timeoutMs,
      maxOutputBytes: this.maxOutputBytes
    });
    const requestBase = path.resolve(this.dataRoot, ".runtime", "agent-requests");
    fs.mkdirSync(requestBase, { recursive: true });
    const requestDir = path.resolve(requestBase, requestId);
    ensureWithin(requestBase, requestDir);
    fs.mkdirSync(requestDir, { recursive: false });
    const startedAt = Date.now();
    try {
      const responseText = await runChild({
        command: this.command,
        args: this.args,
        cwd: requestDir,
        env: this.env,
        stdin: `${JSON.stringify(request)}\n`,
        timeoutMs: this.timeoutMs,
        maxOutputBytes: this.maxOutputBytes,
        signal: input.signal
      });
      const parsed = parseAgentResponse(responseText, requestId);
      this.lastIdentity = parsed.identity;
      this.logger?.info("agent_model_call_completed", {
        requestId,
        kind: request.taskKind,
        runner: this.runnerId,
        model: parsed.identity.model,
        runnerVersion: parsed.identity.runnerVersion,
        latencyMs: Date.now() - startedAt
      });
      return parsed.result;
    } catch (error) {
      const normalized = normalizeProcessError(error);
      this.logger?.warn("agent_model_call_failed", {
        requestId,
        kind: request.taskKind,
        runner: this.runnerId,
        latencyMs: Date.now() - startedAt,
        errorCode: normalized.code
      });
      throw normalized;
    } finally {
      ensureWithin(requestBase, requestDir);
      fs.rmSync(requestDir, { recursive: true, force: true });
    }
  }
}

function runnerScheduler(runnerId, identityRevision, command, args) {
  const key = crypto.createHash("sha256")
    .update(JSON.stringify([runnerId, identityRevision, command, args]))
    .digest("hex");
  let scheduler = RUNNER_SCHEDULERS.get(key);
  if (!scheduler) {
    scheduler = { tail: Promise.resolve(), inFlight: new Map() };
    RUNNER_SCHEDULERS.set(key, scheduler);
  }
  return scheduler;
}

function runChild({ command, args, cwd, env, stdin, timeoutMs, maxOutputBytes, signal }) {
  if (signal?.aborted) return Promise.reject(agentError("MODEL_AGENT_CANCELLED", "本机 Agent 调用已取消。"));
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let forcedError = null;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const stopWith = (error) => {
      if (forcedError) return;
      forcedError = error;
      terminate(child);
    };
    const onAbort = () => stopWith(agentError("MODEL_AGENT_CANCELLED", "本机 Agent 调用已取消。"));
    const timer = setTimeout(() => {
      stopWith(agentError("MODEL_AGENT_TIMEOUT", `本机 Agent 调用超时（${timeoutMs}ms）。`, { retryable: true }));
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > maxOutputBytes) {
        stopWith(agentError("MODEL_AGENT_PROTOCOL_INVALID", "本机 Agent 返回内容超过大小限制。"));
        return;
      }
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxOutputBytes) {
        stopWith(agentError("MODEL_AGENT_PROTOCOL_INVALID", "本机 Agent 错误输出超过大小限制。"));
      }
    });
    child.once("error", (error) => {
      if (error?.code === "ENOENT") {
        finish(agentError("MODEL_AGENT_NOT_INSTALLED", "没有找到本机 Agent，请先安装。"));
      } else {
        finish(agentError("MODEL_AGENT_PROCESS_FAILED", "无法启动本机 Agent。"));
      }
    });
    child.once("close", (code) => {
      if (forcedError) return finish(forcedError);
      if (code !== 0) {
        if (stdout.trim()) {
          try {
            parseAgentResponse(stdout, JSON.parse(stdin).requestId);
          } catch (error) {
            if (error?.code && error.code !== "MODEL_AGENT_PROTOCOL_INVALID") return finish(error);
          }
        }
        return finish(agentError("MODEL_AGENT_PROCESS_FAILED", `本机 Agent 进程异常退出（${Number(code)}）。`));
      }
      finish(null, stdout);
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin);
  });
}

function terminate(child) {
  if (!child || child.killed) return;
  if (process.platform === "win32" && Number.isSafeInteger(Number(child.pid))) {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore"
      }).unref();
    } catch { /* already gone */ }
    return;
  }
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
}

function normalizeProcessError(error) {
  if (error?.code && String(error.code).startsWith("MODEL_AGENT_")) return error;
  return agentError("MODEL_AGENT_PROCESS_FAILED", "本机 Agent 调用失败。");
}

function ensureWithin(base, target) {
  const relative = path.relative(path.resolve(base), path.resolve(target));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("agent request path escaped its data root");
  }
}

function requiredText(value, name) {
  const text = String(value || "").trim();
  if (!text) throw new TypeError(`${name} is required`);
  return text;
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

module.exports = { AgentCommandTransport, runChild };

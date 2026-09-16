const crypto = require("node:crypto");
const readline = require("node:readline");

const { StructuredModelAdapter } = require("./structured");

const PROTOCOL = "offergo.agent.stdio";
const VERSION = 1;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

class AgentStdioTransport {
  constructor(config = {}) {
    this.provider = "agent_stdio";
    this.model = "current-agent";
    this.input = config.input || process.stdin;
    this.output = config.output || process.stdout;
    this.timeoutMs = positiveInteger(config.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.maxResponseBytes = positiveInteger(config.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES);
    this.pending = null;
    this.closed = false;
    this.tail = Promise.resolve();
    this.reader = readline.createInterface({ input: this.input, crlfDelay: Infinity, terminal: false });
    this.reader.on("line", (line) => this.handleLine(line));
    this.reader.on("close", () => this.handleClose());
  }

  requestJson(request = {}) {
    const run = () => this.issueRequest(request);
    const result = this.tail.then(run, run);
    this.tail = result.catch(() => undefined);
    return result;
  }

  issueRequest({ systemPrompt = "", input = {}, kind = "unknown", signal = null } = {}) {
    if (this.closed) return Promise.reject(protocolError("AGENT_STDIO_CLOSED", "Agent 标准输入已关闭。"));
    if (this.pending) return Promise.reject(protocolError("AGENT_STDIO_BUSY", "Agent 标准输入通道正忙。"));
    if (signal?.aborted) return Promise.reject(abortError(signal));

    const id = crypto.randomUUID();
    const envelope = {
      protocol: PROTOCOL,
      version: VERSION,
      type: "model_request",
      id,
      task: String(kind || "unknown"),
      instruction: String(systemPrompt || ""),
      input: input && typeof input === "object" ? input : {},
      replyFormat: `Write one JSON line with protocol=${PROTOCOL}, version=${VERSION}, type=model_response, the same id, and a result object.`
    };

    return new Promise((resolve, reject) => {
      const finish = (error, result) => {
        const current = this.pending;
        if (!current || current.id !== id) return;
        clearTimeout(current.timer);
        signal?.removeEventListener("abort", current.onAbort);
        this.pending = null;
        if (error) reject(error);
        else resolve(result);
      };
      const onAbort = () => finish(abortError(signal));
      const timer = setTimeout(() => {
        finish(protocolError("AGENT_STDIO_TIMEOUT", `等待 Agent 返回结果超时（${this.timeoutMs}ms）。`));
      }, this.timeoutMs);
      this.pending = { id, finish, timer, onAbort };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        this.output.write(`${JSON.stringify(envelope)}\n`, "utf8");
      } catch (error) {
        finish(protocolError("AGENT_STDIO_WRITE_FAILED", "无法向当前 Agent 输出任务。", error));
      }
    });
  }

  handleLine(line) {
    const current = this.pending;
    if (!current || !String(line).trim()) return;
    if (Buffer.byteLength(String(line), "utf8") > this.maxResponseBytes) {
      current.finish(protocolError("AGENT_STDIO_RESPONSE_TOO_LARGE", "Agent 返回结果超过大小限制。"));
      return;
    }
    let response;
    try {
      response = JSON.parse(String(line));
    } catch (error) {
      current.finish(protocolError("AGENT_STDIO_RESPONSE_INVALID", "Agent 返回的不是有效 JSON 行。", error));
      return;
    }
    if (response?.protocol !== PROTOCOL || response?.version !== VERSION || response?.type !== "model_response") {
      current.finish(protocolError("AGENT_STDIO_RESPONSE_INVALID", "Agent 返回的协议版本或消息类型无效。"));
      return;
    }
    if (response.id !== current.id) {
      current.finish(protocolError("AGENT_STDIO_RESPONSE_MISMATCH", "Agent 返回的任务 ID 与当前请求不一致。"));
      return;
    }
    if (response.error) {
      current.finish(protocolError("AGENT_STDIO_TASK_FAILED", safeAgentError(response.error)));
      return;
    }
    if (!response.result || typeof response.result !== "object" || Array.isArray(response.result)) {
      current.finish(protocolError("AGENT_STDIO_RESPONSE_INVALID", "Agent 必须返回一个 JSON 对象结果。"));
      return;
    }
    current.finish(null, response.result);
  }

  handleClose() {
    this.closed = true;
    this.pending?.finish(protocolError("AGENT_STDIO_CLOSED", "Agent 标准输入已关闭。"));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.pending?.finish(protocolError("AGENT_STDIO_CLOSED", "Agent 标准输入已关闭。"));
    this.reader.close();
  }
}

class AgentStdioAdapter extends StructuredModelAdapter {
  constructor(config = {}) {
    const transport = config.transport || new AgentStdioTransport(config);
    super({ transport, provider: "agent_stdio", model: "current-agent", logger: config.logger });
  }

  close() {
    this.transport.close?.();
  }
}

function protocolError(code, message, cause = null) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function abortError(signal) {
  const error = new Error(signal?.reason?.message || "Agent 任务已取消。");
  error.code = "AGENT_STDIO_CANCELLED";
  if (signal?.reason instanceof Error) error.cause = signal.reason;
  return error;
}

function safeAgentError(value) {
  const message = typeof value === "string" ? value : value?.message;
  return String(message || "Agent 无法完成当前任务。").slice(0, 500);
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

module.exports = {
  AgentStdioTransport,
  AgentStdioAdapter,
  PROTOCOL,
  VERSION
};

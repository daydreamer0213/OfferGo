const crypto = require("node:crypto");

const AGENT_PROTOCOL_VERSION = 1;
const AGENT_ERROR_CODES = new Set([
  "MODEL_AGENT_NOT_INSTALLED",
  "MODEL_AGENT_UPDATE_REQUIRED",
  "MODEL_AGENT_AUTH_REQUIRED",
  "MODEL_AGENT_QUOTA_EXHAUSTED",
  "MODEL_AGENT_TIMEOUT",
  "MODEL_AGENT_CANCELLED",
  "MODEL_AGENT_PROTOCOL_INVALID",
  "MODEL_AGENT_PROCESS_FAILED",
  "MODEL_AGENT_UNAVAILABLE"
]);

function makeAgentRequest({
  requestId,
  taskKind,
  systemPrompt,
  input,
  outputSchema = { type: "object" },
  timeoutMs,
  maxOutputBytes
}) {
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    requestId: requiredText(requestId, "requestId"),
    taskKind: requiredText(taskKind, "taskKind"),
    systemPrompt: requiredText(systemPrompt, "systemPrompt"),
    input: input && typeof input === "object" ? input : {},
    outputSchema: outputSchema && typeof outputSchema === "object" ? outputSchema : { type: "object" },
    limits: {
      timeoutMs: positiveInteger(timeoutMs, "timeoutMs"),
      maxOutputBytes: positiveInteger(maxOutputBytes, "maxOutputBytes")
    }
  };
}

function parseAgentResponse(text, requestId) {
  let value;
  try {
    value = JSON.parse(String(text || "").trim());
  } catch {
    throw agentError("MODEL_AGENT_PROTOCOL_INVALID", "本机 Agent 返回的内容不是有效 JSON。");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw agentError("MODEL_AGENT_PROTOCOL_INVALID", "本机 Agent 返回格式无效。");
  }
  if (value.protocolVersion !== AGENT_PROTOCOL_VERSION || value.requestId !== requestId) {
    throw agentError("MODEL_AGENT_PROTOCOL_INVALID", "本机 Agent 返回的协议版本或请求编号不匹配。");
  }
  if (value.ok !== true) {
    const error = value.error;
    if (!error || !AGENT_ERROR_CODES.has(String(error.code || ""))) {
      throw agentError("MODEL_AGENT_PROTOCOL_INVALID", "本机 Agent 返回了未知错误格式。");
    }
    throw agentError(error.code, safeMessage(error.message), { retryable: error.retryable === true });
  }
  if (!value.result || typeof value.result !== "object" || Array.isArray(value.result)) {
    throw agentError("MODEL_AGENT_PROTOCOL_INVALID", "本机 Agent 未返回结构化对象。");
  }
  return { result: value.result, identity: normalizeIdentity(value.identity) };
}

function agentRequestFingerprint(input, identityRevision = "") {
  return crypto.createHash("sha256").update(stableStringify({
    identityRevision: String(identityRevision || ""),
    kind: String(input?.kind || "unknown"),
    systemPrompt: String(input?.systemPrompt || ""),
    input: input?.input || {},
    outputSchema: input?.outputSchema || { type: "object" }
  })).digest("hex");
}

function agentError(code, message = "本机 Agent 调用失败。", details = {}) {
  const normalizedCode = AGENT_ERROR_CODES.has(String(code || ""))
    ? String(code)
    : "MODEL_AGENT_PROCESS_FAILED";
  const error = new Error(safeMessage(message));
  error.code = normalizedCode;
  error.retryable = details.retryable === true;
  return error;
}

function normalizeIdentity(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    runner: safeIdentityText(source.runner, "unknown"),
    model: safeIdentityText(source.model, "default"),
    runnerVersion: safeIdentityText(source.runnerVersion, "unknown")
  };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function safeIdentityText(value, fallback) {
  const text = String(value || "").trim().slice(0, 120);
  return text && /^[\w .:/+@()-]+$/u.test(text) ? text : fallback;
}

function safeMessage(value) {
  return String(value || "本机 Agent 调用失败。").replace(/[\r\n]+/g, " ").slice(0, 240);
}

function requiredText(value, name) {
  const text = String(value || "");
  if (!text) throw new TypeError(`${name} is required`);
  return text;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError(`${name} must be a positive integer`);
  return number;
}

module.exports = {
  AGENT_PROTOCOL_VERSION,
  AGENT_ERROR_CODES,
  makeAgentRequest,
  parseAgentResponse,
  agentRequestFingerprint,
  agentError,
  normalizeIdentity
};

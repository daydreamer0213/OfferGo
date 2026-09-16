const LONG_STRUCTURED_INITIAL_RESPONSE_TOKENS = 8192;
const DEFAULT_MAX_ADAPTIVE_RESPONSE_TOKENS = 8192;
const MAX_ADAPTIVE_RESPONSE_TOKENS = 16384;
const MAX_ADAPTIVE_TIMEOUT_MS = 300000;
const ALWAYS_LONG_STRUCTURED_TASKS = new Set([
  "analyzeResume",
  "recommendSearchPlan"
]);
const THINKING_LONG_STRUCTURED_TASKS = new Set([
  "understandJob",
  "matchResponsibilities",
  "matchRequirements"
]);
const DEEPSEEK_V4_MODELS = new Set(["deepseek-v4-pro", "deepseek-v4-flash"]);
const DETERMINISTIC_EVIDENCE_KINDS = new Set([
  "understandJob",
  "matchJob",
  "matchResponsibilities",
  "matchRequirements"
]);
const EXPANDABLE_RESPONSE_ERRORS = new Set([
  "MODEL_OUTPUT_TRUNCATED",
  "MODEL_INVALID_JSON",
  "MODEL_INVALID_RESPONSE"
]);
const JSON_MODE_RECOVERY_ERRORS = new Set([
  "MODEL_INVALID_JSON",
  "MODEL_INVALID_RESPONSE"
]);
const SAFE_FINISH_REASONS = new Set([
  "stop",
  "length",
  "content_filter",
  "tool_calls",
  "insufficient_system_resource"
]);
const SAFE_RESPONSE_FAILURE_KINDS = new Set([
  "empty_response",
  "truncated_content",
  "invalid_response_json",
  "invalid_envelope",
  "missing_content",
  "invalid_content_json"
]);
const SAFE_RESPONSE_CONTENT_TYPE_KINDS = new Set([
  "json",
  "event_stream",
  "html",
  "plain_text",
  "other",
  "missing"
]);
const SAFE_RESPONSE_ENVELOPE_KINDS = new Set([
  "empty",
  "json_object",
  "json_array",
  "event_stream",
  "html",
  "other"
]);
const SAFE_RESPONSE_PARSE_FAILURE_KINDS = new Set([
  "unexpected_end",
  "unexpected_token",
  "other"
]);
const MULTI_TRACK_SPARSE_REPAIR_MESSAGE =
  "matchJob 模型输出不符合契约：multi-track matching requires sparse evidence";
const MULTI_TRACK_SPARSE_REBUILD_INSTRUCTION =
  "Rebuild the response from candidateProfile, candidateMatchCard, searchPreferences, and jobUnderstanding. Return exactly the six-key sparse JSON object requested by the system prompt; do not copy legacy decision fields.";
const UNDERSTAND_EVIDENCE_REPAIR_INSTRUCTION =
  "对 contractRepair.reason 点名的 evidence，只从 job.description 复制一段连续 JD 原文，以“JD：”开头，包含前缀在内不超过 120 个字符；不得改写或拼接；不得改变其他已验证事实。";
const UNDERSTAND_EVIDENCE_REPAIR_MESSAGES = new Set([
  "understandJob 模型输出不符合契约：responsibilityEvidence 必须以“JD：”开头且不超过 120 个字符",
  "understandJob 模型输出不符合契约：requirements.evidence evidence 必须以 JD：开头、包含原文且最多 120 个字符",
  "understandJob 模型输出不符合契约：riskSignals.evidence evidence 必须以 JD：开头、包含原文且最多 120 个字符"
]);
const QUALITY_REVISION_INSTRUCTIONS = Object.freeze({
  MESSAGE_DRAFT_RECENTLY_SIMILAR: "改写开头和句式，保留事实与语气，不复用近期表达。",
  MESSAGE_DRAFT_FACT_UNSUPPORTED: "删除没有候选人依据的个人事实，不用模糊措辞替代。",
  MESSAGE_DRAFT_EMPTY: "生成至少一条完整、自然且符合既有输出契约的草稿。"
});
const QUALITY_CLAIM_KINDS = new Set([
  "phone", "email", "url", "salary", "percentage", "duration", "numeric_achievement",
  "arrival", "interview_availability", "overtime", "travel", "relocation"
]);

class OpenAICompatibleTransport {
  constructor(config = {}) {
    this.provider = "openai_compatible";
    this.baseUrl = String(config.baseUrl || "").replace(/\/$/, "");
    this.apiKey = String(config.apiKey || "");
    this.apiKeyEnv = Object.prototype.hasOwnProperty.call(config, "apiKeyEnv")
      ? config.apiKeyEnv
      : "OPENAI_API_KEY";
    this.model = config.model || "gpt-4.1-mini";
    this.timeoutMs = Number(config.timeoutMs || 60000);
    this.maxRetries = Math.max(0, Math.min(3, Number(config.maxRetries ?? 1)));
    this.jsonMode = config.jsonMode !== false;
    this.temperature = Number(config.temperature ?? 0.1);
    this.maxTokens = Number(config.maxTokens ?? 4096);
    this.thinkingMode = config.thinkingMode === "enabled" ? "enabled" : "disabled";
    this.reasoningEffort = config.reasoningEffort === "max" ? "max" : "high";
    this.logger = config.logger || null;
  }

  async requestJson({ systemPrompt, input, kind = "unknown", signal = null } = {}) {
    throwIfAborted(signal);
    const apiKey = this.apiKey || (this.apiKeyEnv ? process.env[this.apiKeyEnv] : "");
    if (!apiKey) {
      const guidance = this.apiKeyEnv
        ? `请设置环境变量 ${this.apiKeyEnv}`
        : "请在模型设置中保存并验证当前任务的 API Key";
      throw new Error(`模型 API key 未配置：${guidance}，或把 configs/model.json provider 改回 mock。`);
    }
    if (!this.baseUrl) throw new Error("模型 baseUrl 未配置：请检查 configs/model.json providers.openai_compatible.baseUrl。");

    let lastError;
    let attempts = 0;
    let jsonModeFallback = false;
    let structuredJsonModeFallback = false;
    const longStructuredTask = usesLongStructuredBudget(kind, this.thinkingMode);
    let responseTokenLimit = longStructuredTask
      ? Math.max(this.maxTokens, LONG_STRUCTURED_INITIAL_RESPONSE_TOKENS)
      : this.maxTokens;
    const startedAt = Date.now();
    try {
      for (const jsonMode of this.jsonMode ? [true, false] : [false]) {
        const retryLimit = structuredJsonModeFallback && !jsonMode ? 0 : this.maxRetries;
        for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
          throwIfAborted(signal);
          attempts += 1;
          const attemptStartedAt = Date.now();
          const requestTimeoutMs = adaptiveRequestTimeoutMs(
            this.timeoutMs,
            this.maxTokens,
            responseTokenLimit,
            longStructuredTask
          );
          try {
            const response = await this.requestHttpJson({
              apiKey,
              systemPrompt,
              input,
              kind,
              jsonMode,
              maxTokens: responseTokenLimit,
              timeoutMs: requestTimeoutMs,
              signal
            });
            this.logger?.info("model_call_attempt_completed", modelAttemptEventData({
              kind,
              attempt: attempts,
              startedAt: attemptStartedAt,
              jsonMode,
              requestedMaxTokens: responseTokenLimit,
              response
            }));
            this.logger?.info("model_call_completed", {
              kind, provider: this.provider, model: this.model, cacheHit: false,
              latencyMs: Date.now() - startedAt, attempts, httpStatus: response.httpStatus,
              usage: response.usage, providerRequestId: response.providerRequestId,
              jsonMode, jsonModeFallback, requestedMaxTokens: responseTokenLimit,
              contentLength: response.contentLength
            });
            return response.value;
          } catch (error) {
            lastError = error;
            this.logger?.warn("model_call_attempt_failed", modelAttemptEventData({
              kind,
              attempt: attempts,
              startedAt: attemptStartedAt,
              jsonMode,
              requestedMaxTokens: responseTokenLimit,
              error
            }));
            throwIfAborted(signal);
            if (jsonMode && error.code === "json_mode_unsupported") {
              jsonModeFallback = true;
              break;
            }
            if (attempt < retryLimit && error.retryable) {
              responseTokenLimit = adaptiveResponseTokenLimit(
                responseTokenLimit,
                error,
                longStructuredTask ? MAX_ADAPTIVE_RESPONSE_TOKENS : DEFAULT_MAX_ADAPTIVE_RESPONSE_TOKENS
              );
              await delay(retryDelayMs(error, attempt), signal);
              continue;
            }
            if (jsonMode && this.maxRetries > 0 && error.retryable && JSON_MODE_RECOVERY_ERRORS.has(error.code)) {
              jsonModeFallback = true;
              structuredJsonModeFallback = true;
              break;
            }
            throw error;
          }
        }
      }
      throw lastError || new Error("模型请求失败。");
    } catch (error) {
      this.logger?.warn("model_call_failed", {
        kind, provider: this.provider, model: this.model, cacheHit: false,
        latencyMs: Date.now() - startedAt, attempts, httpStatus: error?.status || error?.httpStatus || null,
        usage: null, providerRequestId: error?.providerRequestId || "", jsonModeFallback,
        errorCode: error?.code || (error?.status ? `HTTP_${error.status}` : "MODEL_REQUEST_FAILED"),
        errorMessage: error?.message || String(error),
        finishReason: safeMetadataEnum(error?.finishReason, SAFE_FINISH_REASONS),
        contentLength: Number.isFinite(Number(error?.contentLength)) ? Number(error.contentLength) : null,
        responseFailureKind: safeMetadataEnum(error?.responseFailureKind, SAFE_RESPONSE_FAILURE_KINDS),
        responseContentTypeKind: safeMetadataEnum(error?.responseContentTypeKind, SAFE_RESPONSE_CONTENT_TYPE_KINDS),
        responseEnvelopeKind: safeMetadataEnum(error?.responseEnvelopeKind, SAFE_RESPONSE_ENVELOPE_KINDS),
        responseParseFailureKind: safeMetadataEnum(error?.responseParseFailureKind, SAFE_RESPONSE_PARSE_FAILURE_KINDS),
        responseHadUtf8Bom: typeof error?.responseHadUtf8Bom === "boolean" ? error.responseHadUtf8Bom : null,
        responseJsonModeApplied: typeof error?.jsonModeApplied === "boolean" ? error.jsonModeApplied : null,
        requestedMaxTokens: Number.isFinite(Number(error?.requestedMaxTokens))
          ? Number(error.requestedMaxTokens)
          : responseTokenLimit
      });
      throw error;
    }
  }

  async requestHttpJson({
    apiKey,
    systemPrompt,
    input,
    kind,
    jsonMode,
    maxTokens = this.maxTokens,
    timeoutMs = this.timeoutMs,
    signal = null
  }) {
    throwIfAborted(signal);
    const controller = new AbortController();
    let externalAbortReason = null;
    const onExternalAbort = () => {
      externalAbortReason = signalAbortReason(signal);
      controller.abort(externalAbortReason);
    };
    signal?.addEventListener("abort", onExternalAbort, { once: true });
    if (signal?.aborted && !externalAbortReason) onExternalAbort();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const body = {
        model: this.model,
        temperature: DETERMINISTIC_EVIDENCE_KINDS.has(kind) ? 0 : this.temperature,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: `${systemPrompt} 只输出 JSON，不要输出 Markdown。` },
          { role: "user", content: JSON.stringify(input) }
        ]
      };
      if (jsonMode) body.response_format = { type: "json_object" };
      applyDeepSeekInferencePolicy(body, {
        officialDeepSeek: isOfficialDeepSeek(this.baseUrl),
        deepSeekV4: DEEPSEEK_V4_MODELS.has(String(this.model || "").trim().toLowerCase()),
        thinkingMode: this.thinkingMode,
        reasoningEffort: this.reasoningEffort
      });
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
        body: JSON.stringify(body)
      });
      const providerRequestId = res.headers.get("x-request-id")
        || res.headers.get("request-id")
        || res.headers.get("x-dashscope-request-id")
        || "";
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 800);
        const error = new Error(`Model request failed (HTTP ${res.status}).`);
        error.status = res.status;
        error.jsonModeApplied = Boolean(jsonMode);
        error.providerRequestId = providerRequestId;
        error.retryable = res.status === 408 || res.status === 429 || res.status >= 500;
        if (res.status === 408 || res.status === 504) error.code = "MODEL_TIMEOUT";
        if (res.status === 429 || res.status >= 500) {
          error.retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
        }
        if (jsonMode && res.status === 400 && /response_format|json[_ -]?object|json mode|json schema/i.test(detail)) error.code = "json_mode_unsupported";
        throw error;
      }
      let data;
      const responseContentTypeKind = classifyResponseContentType(res.headers.get("content-type"));
      const rawEnvelope = await res.text();
      if (!rawEnvelope.trim()) {
        throw modelResponseError("MODEL_EMPTY_RESPONSE", "Model response body was empty.", {
          finishReason: "",
          contentLength: rawEnvelope.length,
          providerRequestId,
          httpStatus: res.status,
          jsonModeApplied: Boolean(jsonMode),
          retryable: true,
          responseFailureKind: "empty_response",
          responseContentTypeKind,
          responseEnvelopeKind: "empty",
          responseParseFailureKind: "",
          responseHadUtf8Bom: false,
          requestedMaxTokens: maxTokens
        });
      }
      try {
        data = JSON.parse(rawEnvelope);
      } catch (parseError) {
        throw modelResponseError("MODEL_INVALID_RESPONSE", "Model response was not valid JSON.", {
          finishReason: "",
          contentLength: rawEnvelope.length,
          providerRequestId,
          httpStatus: res.status,
          jsonModeApplied: Boolean(jsonMode),
          retryable: true,
          responseFailureKind: "invalid_response_json",
          responseContentTypeKind,
          responseEnvelopeKind: classifyResponseEnvelope(rawEnvelope),
          responseParseFailureKind: classifyJsonParseFailure(parseError),
          responseHadUtf8Bom: rawEnvelope.charCodeAt(0) === 0xfeff,
          requestedMaxTokens: maxTokens
        });
      }
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw modelResponseError("MODEL_INVALID_RESPONSE", "Model response envelope was invalid.", {
          finishReason: "",
          contentLength: rawEnvelope.length,
          providerRequestId,
          httpStatus: res.status,
          retryable: true,
          responseFailureKind: "invalid_envelope",
          responseContentTypeKind,
          responseEnvelopeKind: classifyResponseEnvelope(rawEnvelope),
          responseParseFailureKind: "",
          responseHadUtf8Bom: rawEnvelope.charCodeAt(0) === 0xfeff,
          requestedMaxTokens: maxTokens
        });
      }
      const requestId = providerRequestId || String(data.id || "");
      const content = extractContent(data);
      const responseMeta = {
        finishReason: safeMetadataEnum(data.choices?.[0]?.finish_reason, SAFE_FINISH_REASONS),
        contentLength: content.length,
        providerRequestId: requestId,
        httpStatus: res.status,
        jsonModeApplied: Boolean(jsonMode),
        retryable: true,
        requestedMaxTokens: maxTokens
      };
      if (responseMeta.finishReason === "length") {
        throw modelResponseError("MODEL_OUTPUT_TRUNCATED", "Model output was truncated.", {
          ...responseMeta,
          responseFailureKind: "truncated_content"
        });
      }
      if (!hasMessageContent(data)) {
        throw modelResponseError("MODEL_INVALID_RESPONSE", "Model response was missing message content.", {
          ...responseMeta,
          responseFailureKind: "missing_content"
        });
      }
      try {
        return {
          value: parseJsonContent(content),
          usage: normalizeUsage(data.usage),
          httpStatus: res.status,
          providerRequestId: requestId,
          contentLength: content.length
        };
      } catch (error) {
        Object.assign(error, responseMeta, { responseFailureKind: "invalid_content_json" });
        throw error;
      }
    } catch (error) {
      if (externalAbortReason) throw externalAbortReason;
      const normalized = normalizeTransportError(error, timeoutMs);
      if (typeof normalized.jsonModeApplied !== "boolean") normalized.jsonModeApplied = Boolean(jsonMode);
      throw normalized;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onExternalAbort);
    }
  }
}

function adaptiveResponseTokenLimit(current, error, maximum = DEFAULT_MAX_ADAPTIVE_RESPONSE_TOKENS) {
  const value = Number(current);
  if (!EXPANDABLE_RESPONSE_ERRORS.has(error?.code) || !Number.isFinite(value) || value <= 0) return current;
  return Math.max(value, Math.min(maximum, value * 2));
}

function adaptiveRequestTimeoutMs(baseTimeoutMs, baseTokens, responseTokens, longStructuredTask) {
  const timeout = Math.max(1, Number(baseTimeoutMs) || 1);
  if (!longStructuredTask) return timeout;
  const baseline = Math.max(1, Number(baseTokens) || 1);
  const requested = Math.max(baseline, Number(responseTokens) || baseline);
  return Math.min(MAX_ADAPTIVE_TIMEOUT_MS, Math.max(timeout, Math.round(timeout * (requested / baseline))));
}

function usesLongStructuredBudget(kind, thinkingMode) {
  return ALWAYS_LONG_STRUCTURED_TASKS.has(kind)
    || (thinkingMode === "enabled" && THINKING_LONG_STRUCTURED_TASKS.has(kind));
}

function modelAttemptEventData({
  kind,
  attempt,
  startedAt,
  jsonMode,
  requestedMaxTokens,
  response,
  error
}) {
  const source = error || response || {};
  const status = source.httpStatus ?? source.status;
  return {
    kind,
    attempt,
    latencyMs: Math.max(0, Date.now() - startedAt),
    httpStatus: Number.isFinite(Number(status)) ? Number(status) : null,
    errorCode: error
      ? error.code || (error.status ? `HTTP_${error.status}` : "MODEL_REQUEST_FAILED")
      : "",
    responseFailureKind: error
      ? safeMetadataEnum(error.responseFailureKind, SAFE_RESPONSE_FAILURE_KINDS)
      : "",
    responseContentLength: Number.isFinite(Number(source.contentLength))
      ? Number(source.contentLength)
      : null,
    jsonModeApplied: Boolean(jsonMode),
    requestedMaxTokens: Number(requestedMaxTokens)
  };
}

function safeMetadataEnum(value, allowed) {
  const normalized = String(value || "");
  return allowed.has(normalized) ? normalized : "";
}

function classifyResponseContentType(value) {
  const normalized = String(value || "").split(";", 1)[0].trim().toLowerCase();
  if (!normalized) return "missing";
  if (normalized === "application/json" || normalized.endsWith("+json")) return "json";
  if (normalized === "text/event-stream") return "event_stream";
  if (normalized === "text/html" || normalized === "application/xhtml+xml") return "html";
  if (normalized === "text/plain") return "plain_text";
  return "other";
}

function classifyResponseEnvelope(value) {
  const normalized = String(value || "").trim().replace(/^\ufeff/, "");
  if (!normalized) return "empty";
  if (/^data\s*:/i.test(normalized)) return "event_stream";
  if (normalized.startsWith("<")) return "html";
  if (normalized.startsWith("{")) return "json_object";
  if (normalized.startsWith("[")) return "json_array";
  return "other";
}

function classifyJsonParseFailure(error) {
  const message = String(error?.message || "");
  if (/unexpected end|end of json|unterminated/i.test(message)) return "unexpected_end";
  if (/unexpected token|unexpected non-whitespace|not valid json/i.test(message)) return "unexpected_token";
  return "other";
}

function extractContent(data = {}) {
  const content = data.choices?.[0]?.message?.content ?? data.output_text ?? "";
  if (Array.isArray(content)) {
    return content.map((item) => typeof item === "string" ? item : item?.text || item?.content || "").join("");
  }
  if (typeof content === "object" && content) return content.text || content.content || "";
  return String(content || "");
}

function hasMessageContent(data = {}) {
  return data.choices?.[0]?.message?.content != null || data.output_text != null;
}

function parseJsonContent(content) {
  const raw = String(content || "").trim();
  if (!raw) return invalidJson("模型响应缺少可解析的文本内容。");
  const unfenced = raw.replace(/^```(?:json)?\\s*/i, "").replace(/\\s*```$/, "").trim();
  const candidate = unfenced.startsWith("{") ? unfenced : unfenced.slice(unfenced.indexOf("{"), unfenced.lastIndexOf("}") + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return invalidJson("模型响应不是有效 JSON，结果未写入缓存。");
  }
}

function invalidJson(message) {
  throw modelResponseError("MODEL_INVALID_JSON", message, { retryable: true });
}

function modelResponseError(code, message, metadata = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, metadata);
  return error;
}

function normalizeUsage(value = {}) {
  if (!value || typeof value !== "object") return null;
  const result = {};
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens", "input_tokens", "output_tokens"]) {
    if (Number.isFinite(Number(value[key]))) result[key] = Number(value[key]);
  }
  return Object.keys(result).length ? result : null;
}

function parseRetryAfterMs(value, now = Date.now()) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function retryDelayMs(error, attempt) {
  if (Number.isFinite(error?.retryAfterMs)) return error.retryAfterMs;
  const base = 250 * (2 ** attempt);
  return base + Math.floor(Math.random() * base);
}

function normalizeTransportError(error, timeoutMs) {
  const code = error?.code || error?.cause?.code || "";
  const name = error?.name || error?.cause?.name || "";
  if (name === "AbortError" || name === "TimeoutError" || TIMEOUT_ERROR_CODES.has(code)) {
    const timeoutError = new Error(`模型请求超时（${timeoutMs}ms）。`, { cause: error });
    timeoutError.code = "MODEL_TIMEOUT";
    timeoutError.retryable = true;
    return timeoutError;
  }
  if (RETRYABLE_TRANSPORT_CODES.has(code)) error.retryable = true;
  return error;
}

const TIMEOUT_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT"
]);

const RETRYABLE_TRANSPORT_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "EPIPE",
  "UND_ERR_SOCKET"
]);

function delay(ms, signal = null) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signalAbortReason(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signalAbortReason(signal);
}

function signalAbortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return Object.assign(new Error("operation aborted"), {
    name: "AbortError",
    code: "OPERATION_ABORTED"
  });
}

function applyDeepSeekInferencePolicy(body, {
  officialDeepSeek,
  deepSeekV4,
  thinkingMode,
  reasoningEffort
}) {
  if (!officialDeepSeek || !deepSeekV4) return body;
  body.thinking = { type: thinkingMode };
  if (thinkingMode === "enabled") {
    body.reasoning_effort = reasoningEffort;
    delete body.temperature;
  } else {
    delete body.reasoning_effort;
  }
  return body;
}

function isOfficialDeepSeek(baseUrl) {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "api.deepseek.com";
  } catch {
    return false;
  }
}

module.exports = { OpenAICompatibleTransport, extractContent, parseJsonContent };

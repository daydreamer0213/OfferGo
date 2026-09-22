const SUPPORTED_PLATFORMS = new Set(["boss", "zhaopin"]);
const RESUME_REQUEST_ACKNOWLEDGEMENT = "好的，我把简历发您，您先看看。";

function deriveRequestedActions({ platform, messages = [], manualActions = [] } = {}) {
  const source = String(platform || "").trim().toLowerCase();
  const requestedActions = normalizeManualActions(manualActions);
  const replyMessages = [];

  for (const message of Array.isArray(messages) ? messages : []) {
    const messageKey = String(message?.messageKey || "");
    const text = String(message?.text || "").replace(/\r\n?/g, "\n").trim();
    if (!text) continue;
    const remaining = [];
    for (const clause of splitClauses(text)) {
      if (SUPPORTED_PLATFORMS.has(source) && isInPlatformResumeRequest(clause)) {
        addResumeRequest(requestedActions);
      } else {
        remaining.push(clause);
      }
    }
    const actionableRemaining = requestedActions.some((item) => item.kind === "resume_request")
      ? remaining.filter((clause) => !isGreetingOnly(clause))
      : remaining;
    const replyText = actionableRemaining.join("").trim();
    if (replyText) replyMessages.push({ messageKey, text: replyText });
  }

  return { requestedActions, replyMessages };
}

function findPendingResumeRequest({ platform, events = [] } = {}) {
  const source = String(platform || "").trim().toLowerCase();
  if (!SUPPORTED_PLATFORMS.has(source)) return null;
  const values = Array.isArray(events) ? events : [];
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const event = values[index];
    if (String(event?.direction || "") !== "friend") continue;
    if (event?.kind === "resume_request"
      || (event?.kind === "text" && isInPlatformResumeRequest(event?.text))) {
      return { ...event, kind: "resume_request" };
    }
    if (isResumeReceiptAcknowledgement(event?.text)) return null;
  }
  return null;
}

function sanitizeDraftForRequestedActions(value, { platform, requestedActions = [] } = {}) {
  const text = String(value || "").replace(/\r\n?/g, "\n").trim();
  const source = String(platform || "").trim().toLowerCase();
  const sendsResumeInPlatform = SUPPORTED_PLATFORMS.has(source)
    && Array.isArray(requestedActions)
    && requestedActions.some((item) => item?.kind === "resume_request");
  if (!text || !sendsResumeInPlatform) return text;

  let removedResumeHandling = false;
  const remaining = [];
  for (const clause of splitClauses(text)) {
    if (isDraftResumeHandlingClause(clause)) {
      removedResumeHandling = true;
      continue;
    }
    if (isStandaloneResumeTransferPrompt(clause)
      || (removedResumeHandling && isResumeTransferFollowUp(clause))) continue;
    remaining.push(clause);
  }
  const sanitized = remaining.join("").trim();
  return !sanitized || isGenericActionAcknowledgement(sanitized) || isGenericResumeRequestTemplate(sanitized)
    ? RESUME_REQUEST_ACKNOWLEDGEMENT
    : sanitized;
}

function normalizeManualActions(value) {
  const result = [];
  if (Array.isArray(value) && value.some((item) => item?.kind === "resume_request")) {
    result.push({ kind: "resume_request" });
  }
  return result;
}

function addResumeRequest(actions) {
  if (!actions.some((item) => item.kind === "resume_request")) {
    actions.push({ kind: "resume_request" });
  }
}

function splitClauses(text) {
  return String(text || "").match(/[^，,。！？!?；;\n]+[，,。！？!?；;\n]*/g) || [];
}

function isInPlatformResumeRequest(clause) {
  const text = String(clause || "").replace(/\s+/g, "");
  if (!/(?:简历|履历)/i.test(text)) return false;
  if (/(?:邮箱|邮件|e-?mail|微信|wechat|qq|@[^\s，,。；;]+\.[a-z]{2,})/i.test(text)) return false;
  const asksToSend = /(?:发|发送|分享|提供|上传|投递|提交)/.test(text);
  const requestCue = /(?:请|麻烦|方便|能否|可以|可否|劳烦|辛苦|烦请|发下|发一下|发一份|发过来|发给我|把.{0,8}发)/.test(text);
  const alreadyCompleted = /(?:已经|已|收到|看过|查看过|读过).{0,8}(?:简历|履历)|(?:简历|履历).{0,8}(?:已经|已)(?:发|发送|分享|提供|上传|投递|提交|收到)/.test(text);
  return asksToSend && requestCue && !alreadyCompleted;
}

function isGreetingOnly(clause) {
  return /^(?:您好|你好|嗨|hi|hello)[，,。！？!?；;\s]*$/i.test(String(clause || ""));
}

function isResumeReceiptAcknowledgement(value) {
  const text = String(value || "").replace(/\s+/g, "");
  return /(?:已经|已|刚刚)?(?:收到|看到|看过|查看过|下载了).{0,8}(?:简历|履历)|(?:简历|履历).{0,8}(?:已经|已)?(?:收到|看到|看过|查看过|下载)/.test(text);
}

function isDraftResumeHandlingClause(value) {
  const text = String(value || "").replace(/\s+/g, "");
  if (!/(?:简历|履历)/i.test(text)) return false;
  return /(?:发|发送|分享|提供|上传|投递|提交|整理|稍后|随后|邮箱|邮件|e-?mail|微信|wechat|qq|怎么|哪里|哪种方式|什么方式)/i.test(text);
}

function isResumeTransferFollowUp(value) {
  const text = String(value || "").replace(/\s+/g, "");
  return /(?:BOSS直聘|智联|邮箱|邮件|e-?mail|微信|wechat|qq|怎么发|哪里发|哪种方式|什么方式|接收方式)/i.test(text)
    || /^(?:我)?(?:可以|会|马上|稍后|随后|现在)?(?:整理|上传|发送|发|提供|提交).{0,12}(?:过去|给您|给你|一下|一份)?[，,。！？!?；;]*$/i.test(text);
}

function isStandaloneResumeTransferPrompt(value) {
  const text = String(value || "").replace(/\s+/g, "");
  return /^(?:请|麻烦|烦请)?告知.{0,8}(?:简历|履历)?接收方式[，,。！？!?；;]*$/i.test(text);
}

function isGenericActionAcknowledgement(value) {
  return /^(?:好的?|可以|没问题|收到|行|嗯|谢谢)[，,。！？!?；;\s]*$/i.test(String(value || ""));
}

function isGenericResumeRequestTemplate(value) {
  const text = String(value || "").replace(/\s+/g, "");
  if (/^(?:您好|你好)?(?:，|,)?(?:感谢您的?联系|谢谢您的?联系)[，,。！？!?；;]*$/.test(text)) return true;
  return /(?:我对).{0,80}(?:岗位|职位)(?:感兴趣)/.test(text)
    && /(?:工作地点|地点).{0,30}(?:薪资|待遇).{0,40}(?:符合|合适|接受)/.test(text)
    && /(?:期待|等候).{0,12}(?:回复|消息)/.test(text);
}

module.exports = {
  deriveRequestedActions,
  findPendingResumeRequest,
  isInPlatformResumeRequest,
  sanitizeDraftForRequestedActions,
  RESUME_REQUEST_ACKNOWLEDGEMENT
};

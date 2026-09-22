const SUPPORTED_PLATFORMS = new Set(["boss", "zhaopin"]);

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

module.exports = { deriveRequestedActions, isInPlatformResumeRequest };

"use strict";

const { decisionState } = require("./scoring");
const { decisionHardBlockers } = require("./model_contract");
const { normalizeRecommendationTier } = require("./decision_policy");

function isCompetitionPromotion(message = {}) {
  if (message?.metadata?.noticeKind === "competition_promotion") return true;
  if (String(message?.kind || message?.contentKind || "") !== "platform_notice") return false;
  const text = String(message?.text || "").replace(/\s+/g, "");
  return /竞争者PK情况/.test(text) && /查看详细分析/.test(text);
}

const EXPLICIT_REJECTION_PATTERNS = [
  /(?:抱歉|不好意思).{0,8}(?:不太合适|不合适|不匹配)/,
  /(?:岗位|职位).{0,8}(?:不太匹配|不匹配|不太合适|不合适)/,
  /(?:暂不考虑|不再考虑|无法推进|不予推进|结束本次)(?:.{0,12}(?:候选|面试|流程|机会))?/,
  /祝.{0,6}(?:求职顺利|早日找到)/
];

function isExplicitRecruiterRejection(messages = []) {
  return (Array.isArray(messages) ? messages : []).some((message) => {
    if (String(message?.direction || "") !== "friend") return false;
    const text = String(message?.text || "").replace(/[\s，。！？、,.!?；;：:]+/g, "");
    if (!text) return false;
    if (/时间不太合适.{0,12}(?:换|改|调整|明天|后天|周)/.test(text)) return false;
    return EXPLICIT_REJECTION_PATTERNS.some((pattern) => pattern.test(text));
  });
}

function isLatestRecruiterRejection(messages = []) {
  const latest = (Array.isArray(messages) ? messages : [])
    .filter((message) => ["friend", "myself"].includes(String(message?.direction || "")))
    .at(-1);
  return latest?.direction === "friend" && isExplicitRecruiterRejection([latest]);
}

function isClearlyUnmatchedMessageJob(job = {}) {
  const analysis = job?.analysis || {};
  if (analysis.semanticStatus !== "complete") return false;
  return decisionState(job) === "blocked"
    || decisionHardBlockers(analysis).length > 0
    || analysis.jobQuality?.level === "risk"
    || normalizeRecommendationTier(analysis.recommendation, Number(analysis.recommendationSchemaVersion || 1)) === "not_recommended";
}

function isRecruiterReceiptUpdate(classification = {}, messages = []) {
  if (classification.messageIntent !== "information_update" || classification.missingFact
    || (classification.manualActions || []).length || (classification.requiredFactKeys || []).length
    || (classification.responseItems || []).length) return false;
  const text = messages.map(message => String(message?.text || "")).join(" ");
  // A receipt combined with a question or request still requires a reply.
  return /(?:简历|资料)(?:已经|已)?(?:收到了|收到)/.test(text)
    && /(?:有反馈|有消息|有结果|后续).{0,12}(?:联系|通知)/.test(text)
    && !/[?？]|(?:没|未)(?:有)?收到|请|麻烦|方便|能否|是否|补充|回复|确认/.test(text);
}

module.exports = { isCompetitionPromotion, isExplicitRecruiterRejection, isLatestRecruiterRejection, isClearlyUnmatchedMessageJob, isRecruiterReceiptUpdate };

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

function isClearlyUnmatchedMessageJob(job = {}) {
  const analysis = job?.analysis || {};
  if (analysis.semanticStatus !== "complete") return false;
  return decisionState(job) === "blocked"
    || decisionHardBlockers(analysis).length > 0
    || analysis.jobQuality?.level === "risk"
    || normalizeRecommendationTier(analysis.recommendation, Number(analysis.recommendationSchemaVersion || 1)) === "not_recommended";
}

module.exports = { isCompetitionPromotion, isExplicitRecruiterRejection, isClearlyUnmatchedMessageJob };

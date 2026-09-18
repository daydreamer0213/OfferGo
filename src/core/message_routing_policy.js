"use strict";

function isCompetitionPromotion(message = {}) {
  if (message?.metadata?.noticeKind === "competition_promotion") return true;
  if (String(message?.kind || message?.contentKind || "") !== "platform_notice") return false;
  const text = String(message?.text || "").replace(/\s+/g, "");
  return /竞争者PK情况/.test(text) && /查看详细分析/.test(text);
}

module.exports = { isCompetitionPromotion };

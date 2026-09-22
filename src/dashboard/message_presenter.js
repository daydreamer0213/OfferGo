const INTERNAL_LANGUAGE = /(?:可迁移证据|最高归入|硬性要求缺口|决策桶|语义分析|analysis_pending|detail_pending|activity_pending|主投|慎投|可投)/i;
const UNKNOWN_VALUE = /^(?:暂无|未知|待确认|未确认|未说明|工作安排未确认|薪资未说明|地点未说明|公司待确认)$/;

function presentMessageResult(result = {}) {
  const job = result.job || {};
  return {
    recruiterRequest: recruiterRequest(result),
    opportunity: opportunity(job),
    matchHighlights: safeList(job.matchHighlights, 3),
    questionsToConfirm: safeList(job.questionsToConfirm, 3),
    continueCondition: safeText(job.continueCondition),
    knownFacts: compact([
      fact("薪资", job.salary),
      fact("地点", job.location),
      fact("工作安排", job.workSchedule)
    ]),
    details: compact([
      fact("主要工作", job.roleSummary),
      fact("公司业务", job.companyBusiness)
    ])
  };
}

function recruiterRequest(result) {
  const resume = Array.isArray(result.manualActions)
    && result.manualActions.some((item) => item?.kind === "resume_request");
  const hasDraft = (Array.isArray(result.drafts) && result.drafts.length > 0)
    || (Array.isArray(result.messages) && result.messages.length > 0);
  if (resume) return hasDraft
    ? "HR 想请你发送简历，并回复其他问题。"
    : "HR 想请你发送简历。";
  if (result.messageIntent === "interview_invitation") return "HR 邀请你确认面试安排。";
  if (result.missingFactKey) return "HR 需要你补充一项信息后再回复。";
  return {
    interest_check: "HR 想确认你是否愿意继续了解这个岗位。",
    information_request: "HR 正在等你回复一个问题。",
    information_update: "HR 补充了岗位或流程信息。",
    general_communication: "HR 发来了新的沟通消息。",
    manual_review: "这条消息需要确认后再处理。"
  }[result.messageIntent] || "HR 发来了新的消息。";
}

function opportunity(job) {
  if (job.availability === "offline") {
    return { headline: "职位已下线", reason: "保留岗位资料，便于理解这段历史沟通。" };
  }
  const headline = safeText(job.opportunityVerdict);
  const rawReason = safeText(job.opportunitySummary) || safeText(job.fitSummary);
  const reason = rawReason || fitReason(job.fitLabel);
  if (!headline && !reason) return null;
  return {
    headline: headline || fitHeadline(job.fitLabel),
    reason
  };
}

function fitHeadline(value) {
  const label = String(value || "").trim();
  if (/高|强/.test(label)) return "匹配度较高";
  if (/中/.test(label)) return "可以继续了解";
  if (/低|弱/.test(label)) return "建议谨慎判断";
  return "可以继续了解";
}

function fitReason(value) {
  const label = String(value || "").trim();
  if (/高|强/.test(label)) return "现有经历与岗位要求较匹配。";
  if (/中/.test(label)) return "有一定匹配，建议在沟通中确认关键条件。";
  if (/低|弱/.test(label)) return "现有经历与岗位要求的匹配有限。";
  return "";
}

function fact(label, value) {
  const text = safeText(value);
  return text ? { label, value: text } : null;
}

function safeText(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text || UNKNOWN_VALUE.test(text) || INTERNAL_LANGUAGE.test(text)) return "";
  return text;
}

function compact(values) {
  return values.filter(Boolean);
}

function safeList(value, limit) {
  return compact((Array.isArray(value) ? value : []).map(safeText)).slice(0, limit);
}

module.exports = { presentMessageResult };

const INTERNAL_LANGUAGE = /(?:可迁移证据|最高归入|硬性要求缺口|决策桶|语义分析|analysis_pending|detail_pending|activity_pending|主投|慎投|可投)/i;
const UNKNOWN_VALUE = /^(?:暂无|未知|待确认|未确认|未说明|工作安排未确认|薪资未说明|地点未说明|公司待确认)$/;

function presentMessageResult(result = {}) {
  const job = result.job || {};
  return {
    recruiterRequest: recruiterRequest(result),
    roleSummary: plainRoleSummary(job.roleSummary),
    businessContext: businessContext(job.companyBusiness),
    resumeConnections: safeList(job.resumeConnections, 3),
    attentionPoint: safeText(job.attentionPoint),
    recommendationNote: safeText(job.recommendationNote),
    jobFacts: compact([
      fact("薪资", job.salary),
      fact("地点", job.location),
      fact("工作安排", job.workSchedule)
    ])
  };
}

function plainRoleSummary(value) {
  const text = safeText(value);
  if (!text) return "";
  const match = text.match(/^负责(.+?)产品的竞品分析、需求分析与场景梳理，输出需求文档与验收标准，并协调跨团队推进功能从需求到验收的闭环交付[。.]?$/);
  if (match) {
    return `这个岗位主要围绕${readableSpacing(match[1])}做产品工作：先研究竞品和业务场景，把客户或内部需求整理成具体功能和验收标准，再跟进研发、测试等团队把功能真正落地。`;
  }
  return readableSpacing(text.replace(/闭环交付/g, "完整落地"));
}

function businessContext(value) {
  const text = safeText(value);
  if (!text || /暂未说明|待确认|未知/.test(text)) return "";
  let match = text.match(/^JD 显示该岗位(?:服务于|属于)(.+?)(?:相关业务场景)?[。.]?$/);
  if (match) return `业务方向：${readableSpacing(match[1].replace(/相关业务场景$/, ""))}。`;
  return `业务方向：${readableSpacing(text.replace(/[。.]$/, ""))}。`;
}

function readableSpacing(value) {
  return String(value || "")
    .replace(/([\p{Script=Han}])([A-Za-z])/gu, "$1 $2")
    .replace(/([A-Za-z0-9.])([\p{Script=Han}])/gu, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
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

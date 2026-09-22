const PLATFORM_LABELS = Object.freeze({ boss: "BOSS", zhaopin: "智联" });
const STAGES = Object.freeze([
  ["started", "已联系"],
  ["read", "已读"],
  ["replied", "收到回复"],
  ["effectiveConversation", "进入有效沟通"],
  ["resumeRequested", "索要简历"],
  ["interviewInvited", "收到面试邀请"],
  ["interviewConfirmed", "确认面试安排"],
  ["interviewCompleted", "完成面试"],
  ["offerReceived", "收到 Offer"]
]);

function buildHealthView(dashboard = {}) {
  const platformFunnels = (Array.isArray(dashboard.platforms) ? dashboard.platforms : [])
    .map(buildPlatformFunnel);
  const overview = {
    contacted: sum(platformFunnels, "started"),
    replied: sum(platformFunnels, "replied"),
    effectiveConversation: sum(platformFunnels, "effectiveConversation"),
    interviewInvited: sum(platformFunnels, "interviewInvited"),
    interviewCompleted: sum(platformFunnels, "interviewCompleted"),
    offerReceived: sum(platformFunnels, "offerReceived"),
    waiting: platformFunnels.reduce((total, item) => total + count(item.waiting), 0),
    unknown: platformFunnels.reduce((total, item) => total + count(item.unknown), 0)
  };
  const byPlatform = platformFunnels.map((item) => ({ site: item.site, count: item.staleCount }));
  return {
    overview,
    platformFunnels,
    diagnosis: buildDiagnosis(dashboard),
    stale: { total: byPlatform.reduce((total, item) => total + item.count, 0), byPlatform }
  };
}

function buildPlatformFunnel(platform = {}) {
  const site = String(platform.site || "");
  const round = platform.currentRound || {};
  const funnel = round.funnel || {};
  const immediate = round.immediatePositive || {};
  const stages = STAGES
    .filter(([key]) => !(site === "zhaopin" && key === "read"))
    .map(([key, label]) => {
      if (key === "started") {
        const started = count(round.started);
        return { key, label, reached: started, eligible: started, unknown: 0, waiting: 0 };
      }
      const metric = funnel[key] || {};
      return {
        key,
        label,
        reached: count(immediate[key] ?? metric.numerator),
        eligible: count(metric.denominator),
        unknown: count(metric.unknown),
        waiting: count(metric.waiting)
      };
    });
  return {
    site,
    label: PLATFORM_LABELS[site] || site,
    stages,
    waiting: count(round.waiting),
    unknown: count(round.unknown),
    staleCount: count(round.staleCount)
  };
}

function buildDiagnosis(dashboard) {
  const advice = dashboard.advice;
  if (advice) {
    const labels = {
      read: "有阅读状态的岗位",
      replied: "已读岗位",
      effectiveConversation: "已收到回复的岗位",
      interviewInvited: "已进入有效沟通的岗位",
      interviewConfirmed: "已收到面试邀请的岗位",
      interviewCompleted: "已确认面试安排的岗位",
      offerReceived: "已完成面试的岗位"
    };
    return {
      title: String(advice.title || "查看当前最需要改善的环节"),
      detail: `${count(advice.denominator)} 个${labels[advice.stage] || "可核对岗位"}中，${count(advice.numerator)} 个进入下一步。`,
      site: String(advice.site || ""),
      stage: String(advice.stage || "")
    };
  }
  return {
    title: String(dashboard.headline || "现有记录还不足以判断主要问题。"),
    detail: String(dashboard.priorityCheck || "继续记录真实进展，OfferGo 会据此更新判断。"),
    site: "",
    stage: ""
  };
}

function sum(platformFunnels, key) {
  return platformFunnels.reduce((total, item) => total
    + count(item.stages.find((stage) => stage.key === key)?.reached), 0);
}

function count(value) {
  return Math.max(0, Number(value) || 0);
}

module.exports = { buildHealthView };

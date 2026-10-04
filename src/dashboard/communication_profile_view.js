const FACT_LABELS = Object.freeze({
  employment_status: "当前求职状态",
  availability_date: "到岗时间",
  current_city: "当前所在城市",
  expected_salary: "期望薪资",
  interview_availability: "方便面试的时间",
  english_proficiency: "英语能力",
  leaving_reason: "离职原因",
  accepts_travel: "能否接受出差",
  accepts_relocation: "能否接受异地工作",
  accepts_overtime: "对加班的态度"
});
const { getLatestSearchPlan } = require("../application/candidate_queries");

function renderCommunicationProfilePage({ db, searchParams, service, helpers }) {
  const {
    getCandidateProfile,
    renderErrorPage,
    renderFramedPage,
    escapeHtml,
    escapeAttr
  } = helpers;
  const profileId = Number(searchParams.get("profileId"));
  if (!Number.isSafeInteger(profileId) || profileId <= 0) {
    return renderErrorPage("profileId 无效。", "/onboarding", { code: "COMMUNICATION_PROFILE_INVALID" });
  }
  const profile = getCandidateProfile(db, profileId);
  if (!profile) return renderErrorPage("候选人画像不存在。", "/onboarding", { code: "COMMUNICATION_PROFILE_NOT_FOUND" });
  const plan = getLatestSearchPlan(db, profileId);
  const data = service.listCommunicationProfile({ profileId });
  const facts = data.facts.map((fact) => renderFact(fact, { profileId, escapeHtml, escapeAttr })).join("")
    || '<p class="line">目前还没有额外记录。你改写回复后，OfferGo 会把明确的新信息补到这里。</p>';
  const answers = data.answers.map((answer) => renderAnswer(answer, { profileId, escapeHtml, escapeAttr })).join("")
    || '<p class="line">目前还没有你改过并采用的回答。</p>';
  const evidence = (data.evidence || []).map(item => `<article class="message-draft"><h3>${escapeHtml(item.subject)}</h3><p class="line">${item.sourceKind === 'interview_turn' ? '从面试回答确认' : String(item.sourceId || '').startsWith('reply-edit:') ? '来自你改写并采用的回复' : '你补充的经历'} · 更新于 ${escapeHtml(formatTime(item.updatedAt))}</p><form class="form-stack" method="post" action="/api/communication-profile"><input type="hidden" name="profileId" value="${profileId}"><input type="hidden" name="action" value="revise_evidence"><input type="hidden" name="evidenceId" value="${item.id}"><label>主题<input name="subject" maxlength="160" value="${escapeAttr(item.subject)}" required></label><label>我确认的经历<textarea name="text" maxlength="8000" required>${escapeHtml(item.text)}</textarea></label><button>保存修改</button></form><details><summary>查看当时的原话</summary><p>${escapeHtml(item.sourceQuote)}</p></details><form method="post" action="/api/communication-profile"><input type="hidden" name="profileId" value="${profileId}"><input type="hidden" name="action" value="withdraw_evidence"><input type="hidden" name="evidenceId" value="${item.id}"><button class="secondary">不再使用这段经历</button></form></article>`).join('') || '<p>面试练习里确认的经历，以及你改写并采用的回复中的个人经历，会出现在这里。</p>';
  const history = data.revisions.map((revision) => {
    const action = revision.operation === "delete" ? "已删除" : "更新为";
    const value = revision.operation === "delete" ? "" : `：${escapeHtml(revision.factValue)}`;
    return `<li><strong>${escapeHtml(factLabel(revision.factKey))}</strong> ${action}${value}<span class="line"> · ${escapeHtml(formatTime(revision.createdAt))}</span></li>`;
  }).join("") || "<li>还没有历史修改。</li>";
  const messagesPath = `/messages?profileId=${encodeURIComponent(profileId)}`;
  return renderFramedPage({
    title: "我的沟通资料",
    currentPath: `/communication-profile?profileId=${encodeURIComponent(profileId)}`,
    todayPath: plan?.id ? `/plan?planId=${plan.id}` : "/onboarding",
    planId: plan?.id || "",
    stage: "消息",
    brandHref: plan?.id ? `/plan?planId=${plan.id}` : "/onboarding",
    content: `<main id="main-content" class="message-layout"><header class="page-heading"><p class="eyebrow">越用越懂你</p><h1>我的沟通资料</h1><p class="lede">这里保存你亲自修改过的回答和明确资料。回答默认只用于原岗位；你也可以选择让其他岗位的类似问题参考。</p></header><section class="panel"><h2>我目前使用的沟通资料</h2>${facts}</section><section class="panel"><h2>我改过并让 OfferGo 记住的回答</h2>${answers}</section><section class="panel"><h2>我确认过的真实经历</h2>${evidence}</section><details class="panel"><summary>历史修改</summary><ul>${history}</ul></details><p><a class="button-link secondary" href="${escapeAttr(messagesPath)}">返回消息发现</a></p></main>`
  });
}

function renderFact(fact, { profileId, escapeHtml, escapeAttr }) {
  const key = String(fact.factKey || "");
  return `<article class="message-draft"><h3>${escapeHtml(factLabel(key))}</h3><form class="form-stack" method="post" action="/api/communication-profile"><input type="hidden" name="action" value="save_fact"><input type="hidden" name="profileId" value="${profileId}"><input type="hidden" name="factKey" value="${escapeAttr(key)}"><label>当前说法<input name="factValue" value="${escapeAttr(fact.factValue)}" required></label><button>保存修改</button></form><form method="post" action="/api/communication-profile"><input type="hidden" name="action" value="delete_fact"><input type="hidden" name="profileId" value="${profileId}"><input type="hidden" name="factKey" value="${escapeAttr(key)}"><button class="secondary">删除这条资料</button></form></article>`;
}

function renderAnswer(answer, { profileId, escapeHtml, escapeAttr }) {
  const globalScope = answer.scope?.kind === "global";
  const needsRetry = ["failed", "unavailable"].includes(answer.learning?.status);
  const learning = needsRetry
    ? `<p class="line">回答已保存，资料暂未整理。</p><form method="post" action="/api/communication-profile"><input type="hidden" name="action" value="retry_learning"><input type="hidden" name="profileId" value="${profileId}"><input type="hidden" name="memoryId" value="${answer.id}"><button type="submit">补做资料整理</button></form>`
    : answer.learning?.status === "succeeded" ? `<p class="line">回答和资料已保存。</p>` : "";
  return `<article class="message-draft"><h3>${escapeHtml(answer.questionSummary || "我确认过的一次回答")}</h3><p class="line">适用于：${escapeHtml(scopeDescription(answer.scope))} · 更新于 ${escapeHtml(formatTime(answer.updatedAt))}</p>${learning}<form class="form-stack" method="post" action="/api/communication-profile"><input type="hidden" name="action" value="revise_memory"><input type="hidden" name="profileId" value="${profileId}"><input type="hidden" name="memoryId" value="${answer.id}"><label>我希望以后使用的说法<textarea name="finalText" required>${escapeHtml(answer.finalText)}</textarea></label><button>保存修改</button></form><form class="form-stack" method="post" action="/api/communication-profile"><input type="hidden" name="action" value="set_memory_scope"><input type="hidden" name="profileId" value="${profileId}"><input type="hidden" name="memoryId" value="${answer.id}"><label>以后哪些岗位可以参考<select name="scopeKind"><option value="job"${globalScope ? "" : " selected"}>只限这份岗位</option><option value="global"${globalScope ? " selected" : ""}>其他岗位遇到类似问题也可参考</option></select></label><p class="line">到岗时间、薪资等会过期；过期后需要重新确认。</p><button class="secondary">保存使用范围</button></form><form method="post" action="/api/communication-profile"><input type="hidden" name="action" value="withdraw_memory"><input type="hidden" name="profileId" value="${profileId}"><input type="hidden" name="memoryId" value="${answer.id}"><button class="secondary">不再使用这条回答</button></form></article>`;
}

function factLabel(key) {
  if (FACT_LABELS[key]) return FACT_LABELS[key];
  if (String(key).startsWith("gap.")) return "经历空档说明";
  if (String(key).startsWith("leaving_reason.")) return "离职原因说明";
  if (String(key).startsWith("short_project.")) return "短期项目说明";
  return "补充沟通资料";
}

function scopeDescription(scope = {}) {
  return {
    global: "所有合适的同类沟通",
    job: "当前岗位的同类问题",
    company: "这家公司的同类问题",
    experience: "这段经历的同类问题"
  }[scope.kind] || "同类沟通";
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : "时间待确认";
}

module.exports = {
  renderCommunicationProfilePage,
  factLabel
};

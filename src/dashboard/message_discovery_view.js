const crypto = require("node:crypto");
const { listIncomingContacts } = require("../application/funnel_analysis");
const { getSearchPlan, getLatestSearchPlan } = require("../application/candidate_queries");
const { isCompetitionPromotion } = require("../core/message_routing_policy");
const { presentMessageResult } = require("./message_presenter");

function renderMessageDiscoveryPage({ db, searchParams, controller, replySendController = null, messageActionController = null, messageReplyActionToken = "", helpers }) {
  const {
    getCandidateProfile,
    renderErrorPage,
    renderFramedPage,
    escapeHtml,
    escapeAttr,
    progressStageLabel,
    newProgressRequestKey
  } = helpers;
  const profileIdValue = searchParams.get("profileId");
  let profileId = Number(profileIdValue);
  let plan = null;
  if ((!Number.isSafeInteger(profileId) || profileId <= 0) && searchParams.has("planId")) {
    const planId = Number(searchParams.get("planId"));
    if (Number.isSafeInteger(planId) && planId > 0) {
      plan = getSearchPlan(db, planId);
      profileId = Number(plan?.profileId);
    }
  }
  if (!Number.isSafeInteger(profileId) || profileId <= 0) {
    return renderErrorPage("profileId 无效。", "/onboarding", { code: "MESSAGE_DISCOVERY_PROFILE_INVALID" });
  }
  const profile = getCandidateProfile(db, profileId);
  if (!profile) return renderErrorPage("候选人画像不存在。", "/onboarding", { code: "MESSAGE_DISCOVERY_PROFILE_NOT_FOUND" });
  const initialReplySend = replySendController?.latest?.({ profileId }) || null;
  const messageActions = messageActionController?.list?.({ profileId }) || [];
  const pageState = controller.pageState(profileId);
  const inboxState = pageState.inbox || { groups: { needsAction: [], waiting: [], done: [] }, freshness: {}, counts: { total: 0 } };
  const inboxItems = Object.values(inboxState.groups || {}).flat();
  const inboxByConversation = new Map(inboxItems.map((item) => [`${item.platform}\0${item.conversationKey}`, item]));
  const status = pageState;
  plan ||= getLatestSearchPlan(db, profileId);
  const originQuery = searchParams.get("workSite") === "zhaopin" ? "&workSite=zhaopin" : "";
  const todayPath = plan?.id ? `/plan?planId=${plan.id}${originQuery ? "&site=zhaopin" : ""}` : "/onboarding";
  const manualPath = plan?.id ? `/queue?planId=${plan.id}${originQuery ? "&site=zhaopin" : ""}` : "/queue";
  const currentPath = profileIdValue
    ? `/messages?profileId=${encodeURIComponent(profileId)}${originQuery}`
    : `/messages?planId=${encodeURIComponent(plan?.id || "")}${originQuery}`;
  const statusLabel = {
    idle: "尚未开始",
    running: "正在只读发现",
    completed: "本次发现已完成",
    needs_user_action: "需要人工处理",
    stopped: "已安全停止",
    dismissed: "本次草稿已放弃"
  }[status.status] || "需要人工处理";
  const recoveryMessages = messageDiscoveryRecoveryMessages();
  const itemReasonCodes = new Set([
    "BOSS_MESSAGE_CARD_NOT_FOUND", "BOSS_MESSAGE_CARD_AMBIGUOUS", "BOSS_MESSAGE_SALARY_MISMATCH",
    "BOSS_MESSAGE_CITY_MISMATCH", "BOSS_MESSAGE_COMPANY_MISMATCH", "BOSS_MESSAGE_THREAD_MISMATCH",
    "BOSS_MESSAGE_JOB_TARGET_UNAVAILABLE", "MESSAGE_DISCOVERY_JOB_CONTEXT_UNAVAILABLE",
    "MESSAGE_DISCOVERY_JOB_ANALYSIS_INCOMPLETE", "BOSS_MESSAGE_GROUP_LIMIT",
    "BOSS_MESSAGE_GROUP_TEXT_LIMIT", "BOSS_MESSAGE_CONTENT_UNSUPPORTED",
    "ZHAOPIN_MESSAGE_CONTENT_PENDING", "ZHAOPIN_MESSAGE_CONTENT_UNSUPPORTED",
    "ZHAOPIN_MESSAGE_DETAIL_COMPANY_UNVERIFIED", "ZHAOPIN_MESSAGE_DETAIL_INCOMPLETE",
    "ZHAOPIN_MESSAGE_DETAIL_READ_TIMEOUT",
    "ZHAOPIN_MESSAGE_DETAIL_TARGET_UNAVAILABLE",
    "ZHAOPIN_MESSAGE_TARGET_MISMATCH", "ZHAOPIN_MESSAGE_DETAIL_TARGET_MISMATCH",
    "BOSS_MESSAGE_TARGET_MISMATCH", "BOSS_MESSAGE_DETAIL_TARGET_MISMATCH"
  ]);
  const pageReasonCodes = [status.reasonCode, ...(status.platformRuns || [])
    .filter(entry => ["needs_user_action", "stopped"].includes(entry.status)).map(entry => entry.reasonCode)]
    .filter(code => code && !itemReasonCodes.has(code));
  const reason = [...new Set(pageReasonCodes)].map(messageDiscoveryReasonText).join(" ");
  const showPageReason = Boolean(reason);
  const phaseNotice = messageDiscoveryPhaseText(status);
  const contactKey = String(searchParams.get("contact") || "").trim();
  const incomingContacts = listIncomingContacts(db, { profileId });
  const requestedContact = contactKey ? incomingContacts.find((item) => item.key === contactKey) : null;
  const contactMatchesScope = Boolean(requestedContact);
  const resultPending = (result) => Boolean((result.drafts || []).some((draft) => Number(draft?.id) > 0)
    || (result.manualActions || []).length || result.missingFactKey || result.messageIntent === "manual_review");
  const allResults = status.results.filter((result) => result?.messageIntent !== "follow_up"
    && result?.contextComplete === true);
  // Keep every durable result in the DOM so the unified inbox can preserve the
  // selected conversation without a server round trip.
  const displayResults = allResults;
  const resultViews = displayResults.map((result, resultIndex) => {
    const viewKey = messageViewKey("result", [result.platform, result.cardId, result.conversationKey || result.messageGroupKey]);
    const job = result.job || {};
    const presented = presentMessageResult(result);
    const sendable = ["boss", "zhaopin"].includes(result.platform);
    const platformLabel = result.platform === "zhaopin" ? "智联" : sendable ? "BOSS" : "来源待确认";
    const manualActions = (result.manualActions || []).filter((item) => item?.kind === "resume_request");
    const matchingContact = incomingContacts.find((item) => item.platform === result.platform
      && Number(item.cardId) === Number(result.cardId)
      && item.conversationKey === result.conversationKey);
    const inboxItem = inboxByConversation.get(`${result.platform}\0${result.conversationKey}`) || null;
    const expired = inboxItem?.reasonCode === "MESSAGE_REPLY_WINDOW_EXPIRED";
    const pending = !expired && resultPending(result);
    const resumeRequested = Boolean(matchingContact?.resumeRequested || manualActions.length);
    const interviewInvited = Boolean(matchingContact?.interviewInvited || result.messageIntent === "interview_invitation");
    const durableDrafts = Array.isArray(result.drafts) ? result.drafts.filter((draft) => Number(draft?.id) > 0) : [];
    const draftItems = durableDrafts.length
      ? durableDrafts
      : (result.messages || []).map((text) => ({ id: 0, text, revision: 0 }));
    const drafts = draftItems.map((draft, messageIndex) => {
      const id = draft.id > 0 ? `message-draft-${draft.id}` : `message-draft-${resultIndex}-${messageIndex}`;
      const editable = draft.id > 0;
      const sent = editable && sendable
        ? `<form method="post" action="/api/progress" data-sent-draft="${id}"><input type="hidden" name="cardId" value="${result.cardId}"><input type="hidden" name="draftId" value="${draft.id}"><input type="hidden" name="finalText" value=""><input type="hidden" name="idempotencyKey" value="${escapeAttr(newProgressRequestKey())}"><input type="hidden" name="action" value="reply_confirmed_sent"><button class="secondary">我已在 BOSS 手动发送</button></form>`
        : "";
      const alternativeSelector = draftItems.length > 1
        ? `<input type="radio" name="message-send-choice-${Number(result.cardId)}" data-send-select="${draft.id}">选择这版回复`
        : `<input type="checkbox" data-send-select="${draft.id}">加入本次发送`;
      const send = editable && sendable
        ? `<div class="message-draft-actions"><label class="message-send-choice" hidden>${alternativeSelector}</label><button type="button" data-send-single="${draft.id}">确认发送</button></div><p class="message-send-status" data-send-status="${draft.id}" role="status">等待确认</p>`
        : "";
      const saveStatus = editable
        ? `<p class="message-draft-save-status" data-draft-save-status="${draft.id}" role="status">已自动保存</p>`
        : "";
      const qualityNotice = Array.isArray(result.draftQualityWarnings)
        && result.draftQualityWarnings.includes("MESSAGE_DRAFT_RECENTLY_SIMILAR")
        ? '<p class="line message-draft-quality">这条草稿与近期消息的表达比较接近，你可以直接发送，也可以改得更具体。</p>'
        : "";
      const card = `<section class="message-draft" data-draft-card="${draft.id}"><label for="${id}">草稿 ${messageIndex + 1}</label>${qualityNotice}<textarea id="${id}"${editable ? ` data-draft-text data-draft-id="${draft.id}" data-draft-platform="${escapeAttr(result.platform)}" data-revision="${draft.revision}" data-draft-revision="${draft.revision}"` : " readonly"}>${escapeHtml(draft.text)}</textarea>${saveStatus}<button type="button" data-copy-draft="${id}"${editable ? "" : " data-copy-only"}>复制到本机剪贴板</button>${send}${sent}</section>`;
      return messageIndex === 0 ? card : `<details class="message-draft-alternatives"><summary>查看其他回复版本</summary>${card}</details>`;
    }).join("");
    const inboundMessages = Array.isArray(result.inboundMessages) ? result.inboundMessages : [];
    const timelineSection = renderConversationTimeline(inboxItem?.timeline, {
      escapeHtml,
      escapeAttr,
      messageActions,
      allowActions: !expired
    });
    const inboundSection = timelineSection || (inboundMessages.length
      ? `<section class="message-inbound"><h3>HR 消息原文</h3>${inboundMessages.map((message) => `<p class="line">${escapeHtml(message.text)}</p>`).join("")}</section>`
      : "");
    const factRows = presented.jobFacts.map((item) => `<span><strong>${escapeHtml(item.label)}：</strong>${escapeHtml(item.value)}</span>`).join("");
    const connectionRows = presented.resumeConnections.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
    const decisionCard = presented.roleSummary || presented.businessContext || connectionRows || presented.attentionPoint || presented.recommendationNote || factRows
      ? `<section class="message-job-understanding">
        ${presented.roleSummary || presented.businessContext ? `<h3>这个岗位主要做什么</h3>${presented.roleSummary ? `<p class="message-role-summary">${escapeHtml(presented.roleSummary)}</p>` : ""}${presented.businessContext ? `<p class="message-business-context">${escapeHtml(presented.businessContext)}</p>` : ""}` : ""}
        ${connectionRows ? `<h3>你的经历为什么相关</h3><ul class="message-decision-list message-resume-connections">${connectionRows}</ul>` : ""}
        ${presented.attentionPoint ? `<h3>需要留意</h3><p class="message-attention-point">${escapeHtml(presented.attentionPoint)}</p>` : ""}
        ${presented.recommendationNote ? `<h3>是否值得继续聊</h3><p class="message-recommendation-note">${escapeHtml(presented.recommendationNote)}</p>` : ""}
        ${factRows ? `<p class="message-job-facts"><strong>岗位信息</strong>${factRows}</p>` : ""}
      </section>`
      : "";
    const replySection = drafts ? `<h3>回复草稿</h3><h4>推荐回复</h4>${drafts}` : "";
    const missingFactSection = result.missingFactKey ? renderMissingFactForm(result, {
      profileId,
      escapeHtml,
      escapeAttr
    }) : "";
    const responseSection = expired
      ? '<p class="line">这条消息已超过 7 天未回复，系统保留历史记录，不再要求你处理。</p>'
      : `${missingFactSection}${replySection}`;
    const sentForm = !expired && sendable && drafts && !durableDrafts.length
      ? `<form method="post" action="/api/progress"><input type="hidden" name="cardId" value="${result.cardId}"><input type="hidden" name="idempotencyKey" value="${escapeAttr(newProgressRequestKey())}"><input type="hidden" name="action" value="reply_confirmed_sent"><button class="secondary">我已在 BOSS 手动发送</button></form>`
      : "";
    const viewId = `message-view-${viewKey}`;
    const title = job.title || "岗位处理结果";
    const company = job.company || "公司待确认";
    const preview = messagePreview(result);
    return {
      key: viewKey,
      identity: `${result.platform}\0${result.conversationKey}`,
      actionGroup: inboxItem?.actionGroup || (pending ? "needs_action" : "done"),
      contactKey: matchingContact?.key || "",
      list: `<label class="message-list-item" data-platform="${escapeAttr(result.platform || "")}" data-task="${pending ? "pending" : "history"}" data-pending="${pending}" data-resume="${resumeRequested}" data-interview="${interviewInvited}" for="${viewId}"><input id="${viewId}" type="radio" name="message-current" data-message-view="${viewKey}" aria-controls="message-detail-${viewKey}"><span><strong>${escapeHtml(title)}</strong><small><span class="message-source">${escapeHtml(platformLabel)}</span>${inboxItem?.lastActivityAt ? ` · ${escapeHtml(messageTimeLabel(inboxItem.lastActivityAt))}` : ""}</small><small>${escapeHtml(company)} · ${escapeHtml(expired ? "超过 7 天，已结束处理" : messageStatusLabel(result))}</small><em>${escapeHtml(preview)}</em></span></label>`,
      detail: `<section id="message-detail-${viewKey}" class="panel message-result" data-platform="${escapeAttr(result.platform || "")}" data-message-detail-panel="${viewKey}" hidden><button type="button" class="message-back" data-message-back>返回列表</button><h2>${escapeHtml(title)}</h2><p class="line"><span class="message-source">${escapeHtml(platformLabel)}</span> · ${escapeHtml(company)}</p>${inboundSection}${decisionCard}${responseSection}${sentForm}</section>`
    };
  });
  const sendableDraftCount = displayResults.filter(result => ["boss", "zhaopin"].includes(result.platform)).reduce((count, result) => count
    + (Array.isArray(result.drafts) ? result.drafts.filter((draft) => Number(draft?.id) > 0).length : 0), 0);
  const activeReplyBatch = initialReplySend?.batch && !["completed", "stopped", "interrupted"].includes(initialReplySend.batch.status);
  const controls = `<section class="message-controls" aria-label="消息发现操作">
    <form data-discovery-form method="post" action="/api/message-discovery"><input type="hidden" name="action" value="start"><input type="hidden" name="profileId" value="${profileId}"><button data-page-primary="true"${status.status === "running" ? " disabled" : ""}>同步最新消息</button></form>
    ${status.status === "running" ? `<form data-discovery-form method="post" action="/api/message-discovery"><input type="hidden" name="action" value="stop"><input type="hidden" name="profileId" value="${profileId}"><button class="secondary">安全停止</button></form>` : ""}
    ${status.status !== "running" && status.results.length ? `<details class="message-result-actions"><summary>本次读取操作</summary><form data-discovery-form method="post" action="/api/message-discovery"><input type="hidden" name="action" value="dismiss"><input type="hidden" name="profileId" value="${profileId}"><button class="secondary">清除本次结果</button></form></details>` : ""}
    ${sendableDraftCount > 0 ? `<button type="button" class="secondary message-batch-entry" data-send-batch-enter>进入批量发送</button>` : ""}
  </section>`;
  const sendBatchPanel = activeReplyBatch || sendableDraftCount > 0 ? `<section class="message-send-batch" data-send-batch-panel data-state="idle" aria-label="确认发送">
    <div><strong data-send-batch-title>批量发送尚未开始</strong><span data-send-batch-status>单条确认不受影响；需要批量时再选择草稿。</span></div>
    <div class="button-row"><button type="button" data-send-batch hidden disabled>确认并串行发送 0 条</button><button type="button" data-send-batch-exit hidden>退出批量</button><button type="button" data-send-stop hidden disabled>停止后续发送</button></div>
  </section>` : "";
  const resultIdentities = new Set(allResults.filter(result => /^sha256:[a-f0-9]{64}$/.test(result.conversationKey || "")).map((result) => `${result.platform}\0${result.conversationKey}`));
  const incompleteResultIdentities = new Set(status.results.filter((result) => result?.contextComplete !== true
    && /^sha256:[a-f0-9]{64}$/.test(result?.conversationKey || ""))
    .map((result) => `${result.platform}\0${result.conversationKey}`));
  const incomingViews = incomingContacts.filter((item) => {
    const identity = `${item.platform}\0${item.conversationKey}`;
    if (resultIdentities.has(identity)) return false;
    if (incompleteResultIdentities.has(identity)) return false;
    if ((item.sourceKinds || []).length === 1 && item.sourceKinds[0] === "unresolved") return false;
    return true;
  })
    .map((item) => {
      const inboxItem = inboxByConversation.get(`${item.platform}\0${item.conversationKey}`) || null;
      const actionGroup = inboxItem?.actionGroup || (item.pending ? "needs_action" : "done");
      return renderIncomingContactView({
        ...item,
        lastActivityAt: inboxItem?.lastActivityAt || item.observedAt,
        statusText: inboxItem?.reasonCode === "MESSAGE_REPLY_WINDOW_EXPIRED" ? inboxItem.statusText : "",
        reasonCode: inboxItem?.reasonCode || ""
      }, {
        selected: false,
        actionGroup,
        timeline: inboxItem?.timeline,
        messageActions,
        escapeHtml,
        escapeAttr
      });
    });
  const representedIdentities = new Set([...resultViews, ...incomingViews].map((view) => view.identity).filter(Boolean));
  const inboxOnlyViews = inboxItems.filter((item) => !incompleteResultIdentities.has(`${item.platform}\0${item.conversationKey}`)
    && !representedIdentities.has(`${item.platform}\0${item.conversationKey}`))
    .map((item) => renderInboxOnlyView(item, { escapeHtml, escapeAttr, messageActions }));
  const allViews = [...resultViews, ...incomingViews, ...inboxOnlyViews];
  const requestedView = contactMatchesScope ? allViews.find((view) => view.contactKey === requestedContact.key) : null;
  const selectionLocked = Boolean(contactKey && !requestedView);
  const views = allViews;
  const messageGroups = [
    ["needs_action", "现在需要你处理", false],
    ["waiting", "等待对方回复", false],
    ["done", "已结束记录", true]
  ];
  const groupedLists = messageGroups.map(([group, label, collapsed]) => {
    const groupViews = views.filter((view) => view.actionGroup === group);
    if (!groupViews.length && group === "done") return "";
    const content = groupViews.length ? groupViews.map((view) => view.list).join("") : '<p class="message-group-empty">当前没有这类消息</p>';
    return collapsed
      ? `<details class="message-action-group"><summary>${label}<span>${groupViews.length}</span></summary>${content}</details>`
      : `<section class="message-action-group" data-action-group="${group}"><h2>${label}<span>${groupViews.length}</span></h2>${content}</section>`;
  }).join("");
  const messageWorkspace = views.length
    ? `<section class="message-workspace" aria-label="消息行动收件箱"><aside class="message-list" aria-label="行动消息">${groupedLists}</aside><div class="message-detail">${views.map((view) => view.detail).join("")}</div></section>`
    : "";
  const counters = status.counters || {};
  const hasReadDetails = Boolean(status.startedAt || status.status === "running" || (status.platformRuns || []).length || Number(counters.visible) || Number(counters.newReplies));
  const platformNotices =  `<details class="message-read-details"><summary>读取详情</summary><p class="line">BOSS 与智联消息统一在本页展示和处理。</p>${hasReadDetails ? `<p class="line">可见 ${Math.max(0, Number(counters.visible) || 0)} · 已分析回复 ${Math.max(0, Number(counters.newReplies) || 0)} · BOSS 已读 ${Math.max(0, Number(counters.currentRead) || 0)} · 送达 ${Math.max(0, Number(counters.currentDelivered) || 0)}</p><p class="line">智联暂不提供已读/送达统计。</p>` : ""}${(status.platformRuns || []).map(entry => {
    const internalRepair = itemReasonCodes.has(entry.reasonCode);
    const label = internalRepair
      ? "本次读取完成"
      : entry.reasonCode === "MESSAGE_DISCOVERY_WAITING_TURN"
        ? "等待前一平台读取完成"
        : ({ not_connected: "未连接消息页，本次未检查", running: "正在加载并读取消息，可随时安全停止", completed: "本次读取完成", stopped: "已安全停止", needs_user_action: "需要处理后重试" })[entry.status] || "等待读取";
    const detail = !internalRepair && entry.reasonCode && entry.reasonCode !== "MESSAGE_DISCOVERY_WAITING_TURN"
      ? ` · ${escapeHtml(messageDiscoveryReasonText(entry.reasonCode))}`
      : "";
    return `<p class="line">${entry.platform === "zhaopin" ? "智联" : "BOSS"}：${escapeHtml(label)}${detail}</p>`;
  }).join("")}</details>`;
  const freshness = `<section class="message-freshness" aria-label="消息同步状态">${["boss", "zhaopin"].map((platform) => {
    const value = inboxState.freshness?.[platform] || { label: "尚未同步", detail: "" };
    return `<div data-state="${escapeAttr(value.state || "idle")}"><strong>${platform === "zhaopin" ? "智联" : "BOSS"}</strong><span>${escapeHtml(value.label)}</span><small>${escapeHtml(value.detail || "")}</small></div>`;
  }).join("")}</section>`;
  const scriptState = JSON.stringify({
    profileId,
    status: status.status,
    initialSelectedKey: requestedView?.key || "",
    selectionLocked,
    directContact: Boolean(requestedView),
    recoveryMessages,
    initialReplySend,
    messageReplyActionToken: String(messageReplyActionToken || "")
  });
  return renderFramedPage({
    title: "消息发现与回复",
    currentPath,
    todayPath,
    planId: plan?.id || "",
    stage: "消息",
    brandHref: todayPath,
    content: `<main id="main-content" class="message-layout"><header class="page-heading message-heading"><p class="eyebrow">消息工作台</p><h1>行动收件箱</h1><p class="lede">OfferGo 已按下一步整理消息，你只需要打开需要处理的内容。</p></header>${controls}<p class="message-feedback" data-discovery-feedback role="status" aria-live="polite" aria-busy="false"></p>${status.status === "running" || showPageReason ? `<section class="panel message-state"><h2>${escapeHtml(statusLabel)}</h2>${phaseNotice ? `<p class="line">${escapeHtml(phaseNotice)}</p>` : ""}${reason ? `<p class="risk-text">${escapeHtml(reason)}</p>` : ""}</section>` : ""}${freshness}${platformNotices}${selectionLocked ? '<section class="panel message-not-found"><h2>没有找到这条联系</h2><p>它可能已经处理完成，请从列表重新选择。</p></section>' : ''}<p data-source-empty hidden role="status">当前没有消息。</p>${messageWorkspace || (!contactKey ? '<section class="panel"><p class="line">当前没有需要处理的消息。点击“同步最新消息”开始检查。</p></section>' : '')}${sendBatchPanel}<p class="button-row"><a class="button-link secondary" data-flush-drafts href="/communication-profile?profileId=${encodeURIComponent(profileId)}">管理我的沟通资料</a><a class="button-link secondary" data-flush-drafts href="${escapeAttr(manualPath)}">返回人工粘贴流程</a></p></main>`,
    scripts: [messageDiscoveryClientScript(scriptState)]
  });
}

function messagePreview(result, fallback = "") {
  const messages = Array.isArray(result.inboundMessages) ? result.inboundMessages : [];
  const resumeRequested = messages.some(message => message.kind === "resume_request")
    || (result.manualActions || []).some(action => action.kind === "resume_request");
  const text = messages.filter(message => message.kind !== "resume_request")
    .map(message => String(message.text || "").replace(/\s+/gu, " ").trim())
    .filter(Boolean).slice(-2).reverse().join("；");
  const parts = [resumeRequested ? "HR 邀请你发送简历" : "", text].filter(Boolean);
  const preview = parts.join(" · ") || fallback || result.messageSummary || messageIntentLabel(result.messageIntent);
  const characters = Array.from(preview);
  return characters.length > 140 ? `${characters.slice(0, 140).join("")}…` : preview;
}

function messageStatusLabel(result) {
  if ((result.manualActions || []).some((item) => item?.kind === "resume_request")) return "索要简历";
  if (result.messageIntent === "interview_invitation") return "面试邀请";
  if ((result.drafts || []).some((draft) => Number(draft?.id) > 0)) return "待回复";
  return "待人工判断";
}

function renderIncomingContactView(item, { selected, actionGroup = "done", timeline, messageActions, escapeHtml, escapeAttr }) {
  const key = messageViewKey("incoming", [item.key]);
  const inputId = `message-view-${key}`;
  const platform = item.platform === "zhaopin" ? "智联" : "BOSS";
  const status = item.statusText || (item.resumeRequested ? "索要简历" : item.interviewInvited ? "面试邀请" : "已记录联系");
  const activityAt = item.lastActivityAt || item.observedAt;
  const activity = Number.isFinite(Date.parse(String(activityAt || ""))) ? messageTimeLabel(activityAt) : "";
  const original = (item.inboundMessages || []).map((message) => message.text).filter(Boolean);
  return {
    key,
    identity: `${item.platform}\0${item.conversationKey}`,
    actionGroup,
    contactKey: item.key,
    list: `<label class="message-list-item" data-platform="${escapeAttr(item.platform)}" data-task="${actionGroup}" data-pending="${actionGroup === "needs_action" || actionGroup === "needs_review"}" data-resume="${Boolean(item.resumeRequested)}" data-interview="${Boolean(item.interviewInvited)}" for="${inputId}"><input id="${inputId}" type="radio" name="message-current" data-message-view="${key}" aria-controls="message-detail-${key}"${selected ? " checked" : ""}><span><strong>${escapeHtml(item.title || "未关联岗位")}</strong><small><span class="message-source">${escapeHtml(platform)}</span>${activity ? ` · ${escapeHtml(activity)}` : ""} · ${escapeHtml(status)}</small><small>${escapeHtml(item.company || "公司待确认")}</small><em>${escapeHtml(messagePreview(item, "已记录这次联系，原文暂不可查看"))}</em></span></label>`,
    detail: `<section id="message-detail-${key}" class="panel message-result${actionGroup === "done" ? " message-history" : ""}" data-platform="${escapeAttr(item.platform)}" data-message-detail-panel="${key}"${selected ? "" : " hidden"}><button type="button" class="message-back" data-message-back>返回列表</button><h2>${escapeHtml(item.title || "未关联岗位")}</h2><p class="line"><span class="message-source">${escapeHtml(platform)}</span>${activity ? ` · ${escapeHtml(activity)}` : ""} · ${escapeHtml(item.company || "公司待确认")} · ${escapeHtml(status)}</p>${renderConversationTimeline(timeline, { escapeHtml, escapeAttr, messageActions, allowActions: item.reasonCode !== "MESSAGE_REPLY_WINDOW_EXPIRED" }) || `<section class="message-inbound"><h3>会话记录</h3>${original.length ? original.map((text) => `<p class="line">${escapeHtml(text)}</p>`).join("") : '<p class="line">已记录这次联系，完整内容会在下次同步后显示。</p>'}</section>`}<p class="line">${actionGroup === "waiting" ? "你已经回复过这条会话，等待对方继续回复。" : actionGroup === "needs_review" ? "OfferGo 正在补充这条消息所需的岗位资料。" : item.reasonCode === "MESSAGE_REPLY_WINDOW_EXPIRED" ? "这条消息已超过 7 天未回复，系统保留历史记录，不再要求你处理。" : "当前没有需要你处理的操作。"}</p></section>`
  };
}

function renderInboxOnlyView(item, { escapeHtml, escapeAttr, messageActions }) {
  const key = messageViewKey("inbox", [item.platform, item.conversationKey]);
  const inputId = `message-view-${key}`;
  const platform = item.platform === "zhaopin" ? "智联" : "BOSS";
  const title = item.positionTitle || "岗位名称待确认";
  const company = item.company || "公司待确认";
  const statusText = item.statusText || (item.actionGroup === "waiting" ? "已回复，等待对方消息" : "查看这条消息");
  const excerpt = item.latestExcerpt || statusText;
  const reason = item.actionGroup === "needs_review"
    ? messageDiscoveryReasonText(item.reasonCode)
    : item.actionGroup === "waiting" ? "你已经回复过这条会话，新的对方消息出现后会自动移回待处理。" : statusText;
  return {
    key,
    identity: `${item.platform}\0${item.conversationKey}`,
    actionGroup: item.actionGroup,
    contactKey: "",
    list: `<label class="message-list-item" data-platform="${escapeAttr(item.platform)}" data-task="${item.actionGroup}" data-pending="${item.actionGroup === "needs_action" || item.actionGroup === "needs_review"}" data-resume="false" data-interview="false" for="${inputId}"><input id="${inputId}" type="radio" name="message-current" data-message-view="${key}" aria-controls="message-detail-${key}"><span><strong>${escapeHtml(title)}</strong><small><span class="message-source">${escapeHtml(platform)}</span> · ${escapeHtml(messageTimeLabel(item.lastActivityAt))}</small><small>${escapeHtml(company)} · ${escapeHtml(statusText)}</small><em>${escapeHtml(excerpt)}</em></span></label>`,
    detail: `<section id="message-detail-${key}" class="panel message-result${item.actionGroup === "done" ? " message-history" : ""}" data-platform="${escapeAttr(item.platform)}" data-message-detail-panel="${key}" hidden><button type="button" class="message-back" data-message-back>返回列表</button><h2>${escapeHtml(title)}</h2><p class="line"><span class="message-source">${escapeHtml(platform)}</span> · ${escapeHtml(company)} · ${escapeHtml(messageTimeLabel(item.lastActivityAt))}</p>${renderConversationTimeline(item.timeline, { escapeHtml, escapeAttr, messageActions, allowActions: item.reasonCode !== "MESSAGE_REPLY_WINDOW_EXPIRED" }) || `<section class="message-inbound"><h3>${item.lastDirection === "myself" ? "当前会话状态" : "最新消息"}</h3><p class="line">${escapeHtml(excerpt)}</p></section>`}<section class="message-job-understanding"><p class="line"><strong>OfferGo 判断：</strong>${escapeHtml(reason)}</p></section></section>`
  };
}

function renderConversationTimeline(events, { escapeHtml, escapeAttr, messageActions = [], allowActions = true }) {
  if (!Array.isArray(events) || !events.length) return "";
  const bubbles = events.filter((event) => !isCompetitionPromotion(event)).map((event) => {
    const side = event.direction === "myself" ? "self" : event.direction === "friend" ? "friend" : "platform";
    const content = event.kind === "media_ignored"
      ? mediaPlaceholder(event.metadata?.mediaKind)
      : event.text || messageActionLabel(event.kind);
    const time = event.occurredAt ? `<time datetime="${escapeAttr(event.occurredAt)}">${escapeHtml(messageTimeLabel(event.occurredAt))}</time>` : "";
    const action = event.kind === "resume_request" ? messageActions.find((item) => item.platform === event.platform
      && item.conversationKey === event.conversationKey && item.messageKey === event.messageKey) : null;
    const controls = allowActions && event.kind === "resume_request" ? renderMessageActionControls(event, action, { escapeAttr, escapeHtml }) : "";
    return `<article class="message-bubble message-bubble--${side}" data-message-key="${escapeAttr(event.messageKey || "")}"><p>${escapeHtml(content)}</p>${time}${controls}</article>`;
  }).join("");
  if (!bubbles) return "";
  return `<section class="message-timeline" aria-label="完整会话"><h3>完整会话</h3><div class="message-timeline-body">${bubbles}</div></section>`;
}

function renderMessageActionControls(event, action, { escapeAttr, escapeHtml }) {
  const platformLabel = event.platform === "boss" ? "BOSS" : "智联";
  const labels = {
    confirmed: "已确认，等待处理", selecting: "正在核对会话", verified: "已核对操作目标",
    click_dispatched: "正在确认平台结果", succeeded: `已在${platformLabel}完成处理`,
    target_mismatch: "会话已变化，本次未执行", platform_rejected: `${platformLabel}未接受本次操作`,
    ambiguous: "平台结果暂时无法确认，已停止重试", stopped: "本次操作已停止"
  };
  if (action) return `<div class="message-card-action" data-message-action-state="${escapeAttr(action.status)}"><strong>${escapeHtml(action.actionKind === "resume_request_accept" ? "同意发送简历" : "拒绝发送简历")}</strong><span>${escapeHtml(labels[action.status] || "等待处理")}</span></div>`;
  if (event.platform === "boss") return `<div class="message-card-action" data-message-action-group><span>直接处理这项请求</span><div class="button-row"><button type="button" data-message-action-confirm data-platform="boss" data-conversation-key="${escapeAttr(event.conversationKey || "")}" data-message-key="${escapeAttr(event.messageKey || "")}" data-action-kind="accept_resume">确认发送 BOSS 中最近更新的附件简历</button></div><small data-message-action-feedback role="status">点击后 OfferGo 会重新核对当前会话和附件更新时间；无法唯一确认时不会发送。</small></div>`;
  if (event.platform !== "zhaopin") return "";
  return `<div class="message-card-action" data-message-action-group><span>直接处理这项请求</span><div class="button-row"><button type="button" data-message-action-confirm data-platform="zhaopin" data-conversation-key="${escapeAttr(event.conversationKey || "")}" data-message-key="${escapeAttr(event.messageKey || "")}" data-action-kind="accept_resume">同意发送简历</button><button type="button" class="secondary" data-message-action-confirm data-platform="zhaopin" data-conversation-key="${escapeAttr(event.conversationKey || "")}" data-message-key="${escapeAttr(event.messageKey || "")}" data-action-kind="decline_resume">拒绝</button></div><small data-message-action-feedback role="status">点击后 OfferGo 会先核对当前会话，再执行一次。</small></div>`;
}

function mediaPlaceholder(kind) {
  return ({
    voice: "收到一条语音消息，本版本暂不读取内容",
    image: "收到一张图片，本版本暂不读取内容",
    attachment: "收到一个附件，本版本暂不读取内容"
  })[String(kind || "")] || "收到一条媒体消息，本版本暂不读取内容";
}

function messageActionLabel(kind) {
  return ({
    resume_request: "HR 邀请你发送简历",
    interview_invitation: "HR 发来了面试邀请",
    contact_exchange: "HR 请求交换联系方式",
    platform_notice: "平台状态更新",
    unknown_card: "这条消息类型将在后续同步时继续识别"
  })[String(kind || "")] || "消息内容待确认";
}

function messageTimeLabel(value) {
  const timestamp = Date.parse(String(value || ""));
  if (!Number.isFinite(timestamp)) return "时间待确认";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai"
  }).format(new Date(timestamp));
}

function messageDiscoveryClientScript(scriptState) {
  return `<script>(function(){
    const initial=${scriptState};
    const feedback=document.querySelector("[data-discovery-feedback]");
    const forms=Array.from(document.querySelectorAll("[data-discovery-form]"));
    const postStatuses=["running","stopped","completed","needs_user_action","dismissed"];
    const pollStatuses=["idle","running","stopped","completed","needs_user_action","dismissed"];
    let actionPending=false;
    let actionVersion=0;
    let currentStatus=initial.status;
    let reloadPending=false;
    let pollPending=false;
    let pollTimer=null;
    const draftTimers=new Map();
    const draftWrites=new Map();
    const messageFor=(code)=>initial.recoveryMessages[String(code||"")]||initial.recoveryMessages.default;
    const show=(code)=>{if(reloadPending)return;feedback.textContent=messageFor(code);feedback.dataset.errorCode=String(code||"");};
    const liveStatusText=(status)=>{const queued=Math.max(0,Number(status?.queued)||0);const counts=queued?"已发现 "+queued+" 条消息。":"";if(status?.phase==="cooldown"){const seconds=Math.max(1,Math.ceil((Date.parse(status.waitUntil)-Date.now())/1000));const wait=Number.isFinite(seconds)?(seconds>=60?"约 "+Math.ceil(seconds/60)+" 分钟":"约 "+seconds+" 秒"):"一会儿";return counts+"正在按平台安全节奏等待，"+wait+"后继续。";}if(status?.phase==="reading_detail")return counts+"正在后台读取岗位资料，不会抢占前台。";if(status?.phase==="analyzing_job")return counts+"岗位资料已读取，正在完成岗位分析；首次分析可能需要几分钟。";if(status?.phase==="analyzing_messages")return counts+"正在整理消息并生成回复建议，模型响应可能需要一些时间。";if(status?.phase==="reading_messages")return counts+"正在读取最新消息。";return counts+"消息同步正在进行。";};
    const requestReload=(resetSelection=false)=>{if(resetSelection)try{localStorage.removeItem(selectedKeyStorage);}catch{}reloadPending=true;location.reload();};
    const setPending=(pending)=>{feedback.setAttribute("aria-busy",String(pending));if(pending)feedback.textContent="正在处理，请稍候。";for(const form of forms)for(const button of form.querySelectorAll("button")){if(!("discoveryBaseDisabled" in button.dataset))button.dataset.discoveryBaseDisabled=String(button.disabled);button.disabled=pending||button.dataset.discoveryBaseDisabled==="true";}};
    const read=async(response)=>{const text=await response.text();try{return {json:true,body:JSON.parse(text)}}catch{return {json:false,body:null}}};
    const accepted=(response,parsed,statuses)=>Boolean(response.ok&&parsed.json&&parsed.body&&typeof parsed.body==="object"&&!Array.isArray(parsed.body)&&!Object.prototype.hasOwnProperty.call(parsed.body,"errorCode")&&statuses.includes(parsed.body.status));
    const rejectedCode=(parsed)=>parsed.body?.errorCode||"MESSAGE_DISCOVERY_FAILED";
    const schedulePoll=()=>{if(!reloadPending&&!actionPending&&pollTimer===null)pollTimer=setTimeout(poll,2000);};
    for(const form of forms)form.addEventListener("submit",async(event)=>{event.preventDefault();if(actionPending||reloadPending)return;actionPending=true;actionVersion+=1;setPending(true);let succeeded=false;try{const response=await fetch(form.getAttribute("action"),{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams(new FormData(form))});const parsed=await read(response);if(accepted(response,parsed,postStatuses)){succeeded=true;requestReload(parsed.body.status!=="running");return;}show(rejectedCode(parsed));}catch{show("MESSAGE_DISCOVERY_SERVICE_UNAVAILABLE");}finally{actionPending=false;setPending(false);if(!reloadPending&&!succeeded&&currentStatus==="running")schedulePoll();}});
    const cancelDraftSave=(field)=>{const timer=draftTimers.get(field);if(timer!==undefined){clearTimeout(timer);draftTimers.delete(field);}};
    const postDraft=async(field,text,action,completionKind="")=>{const response=await fetch("/api/message-reply-draft",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action,profileId:initial.profileId,draftId:Number(field.dataset.draftId),text,completionKind})});const parsed=await read(response);if(!response.ok||!parsed.json||!parsed.body?.ok)throw new Error(rejectedCode(parsed));return parsed.body;};
    const draftSaveStatus=(field)=>field.closest("[data-draft-card]")?.querySelector("[data-draft-save-status]");
    const setDraftSaveStatus=(field,text)=>{const status=draftSaveStatus(field);if(status)status.textContent=text;};
    const queueDraftWrite=(field,action,completionKind="",text=field.value)=>{const previous=draftWrites.get(field)||Promise.resolve();const pending=previous.catch(()=>undefined).then(()=>{setDraftSaveStatus(field,"正在保存…");return postDraft(field,text,action,completionKind);});draftWrites.set(field,pending);const clear=()=>{if(draftWrites.get(field)===pending)draftWrites.delete(field);};pending.then((result)=>{const revision=Number(result?.revision);if(Number.isSafeInteger(revision)&&revision>=0){field.dataset.revision=String(revision);field.dataset.draftRevision=String(revision);}setDraftSaveStatus(field,field.value===text?"已自动保存":"有修改待保存");clear();},()=>{setDraftSaveStatus(field,field.value===text?"保存失败，请重试":"有修改待保存");clear();});return pending;};
    const saveDraft=async(field)=>{cancelDraftSave(field);return queueDraftWrite(field,"save");};
    const saveStableDrafts=async(fields)=>{for(;;){const texts=fields.map(field=>field.value);await Promise.all(fields.map(saveDraft));if(fields.every((field,index)=>field.value===texts[index]))return;}};
    for(const field of document.querySelectorAll("[data-draft-text]"))field.addEventListener("input",()=>{setDraftSaveStatus(field,"有修改待保存");cancelDraftSave(field);draftTimers.set(field,setTimeout(async()=>{draftTimers.delete(field);try{await queueDraftWrite(field,"save");}catch{feedback.textContent="本次修改还没有保存，请稍后重试。";}},600));});
    for(const button of document.querySelectorAll("[data-copy-draft]"))button.addEventListener("click",async()=>{const field=document.getElementById(button.dataset.copyDraft);if(!field)return;const text=field.value;try{await navigator.clipboard.writeText(text);}catch{feedback.textContent="复制失败，请重试。";return;}if("copyOnly" in button.dataset){feedback.textContent="草稿已复制。";return;}cancelDraftSave(field);try{const result=await queueDraftWrite(field,"complete","copied",text);feedback.textContent=result.changed?"已记住你这次修改的回答":"草稿已复制。";}catch{feedback.textContent="已复制；这次修改暂未保存，请稍后重试";}});
    for(const form of document.querySelectorAll("[data-sent-draft]"))form.addEventListener("submit",()=>{const field=document.getElementById(form.dataset.sentDraft);if(!field)return;cancelDraftSave(field);const hidden=form.querySelector('[name="finalText"]');if(hidden)hidden.value=field.value;});
    const sendPanel=document.querySelector("[data-send-batch-panel]");
    const sendBatchEnterButton=document.querySelector("[data-send-batch-enter]");
    const sendBatchButton=document.querySelector("[data-send-batch]");
    const sendBatchExitButton=document.querySelector("[data-send-batch-exit]");
    const sendStopButton=document.querySelector("[data-send-stop]");
    const sendBatchTitle=document.querySelector("[data-send-batch-title]");
    const sendBatchStatus=document.querySelector("[data-send-batch-status]");
    const sendChoices=Array.from(document.querySelectorAll("[data-send-select]"));
    const messageChoices=Array.from(document.querySelectorAll("[data-message-view]"));
    const messagePanels=Array.from(document.querySelectorAll("[data-message-detail-panel]"));
    const workspace=document.querySelector(".message-workspace");
    const selectedKeyStorage="message-selection-"+initial.profileId;
    let selectedKey=initial.initialSelectedKey||"";
    let selectionLocked=Boolean(initial.selectionLocked);
    if(!selectedKey&&!selectionLocked)try{selectedKey=localStorage.getItem(selectedKeyStorage)||"";}catch{}
    const terminalBatchStatuses=new Set(["completed","stopped","interrupted"]);
    let activeBatchId=0;
    let sendPending=false;
    let batchMode=false;
    let sendPollTimer=null;
    const ownedDraftCards=new WeakSet();
    const sendMessage=(code)=>({
      MESSAGE_REPLY_SEND_PROFILE_BUSY:"已有一批消息正在发送，请等待完成或停止后续发送。",
      MESSAGE_REPLY_SEND_LEASE_BUSY:"招聘平台正在执行另一项任务，请等待完成后再发送。",
      MESSAGE_REPLY_SEND_MIXED_PLATFORM:"BOSS 和智联需要分开确认发送。",
      MESSAGE_REPLY_SEND_REVISION_CONFLICT:"草稿刚刚发生变化，请刷新页面后重新确认。",
      MESSAGE_REPLY_SEND_DRAFT_BUSY:"这条草稿已经属于另一批发送任务。",
      MESSAGE_REPLY_SEND_CONVERSATION_DUPLICATE:"同一条 HR 会话只能选择一个回复版本。",
      MESSAGE_REPLY_SEND_CONTEXT_REQUIRED:"这条草稿缺少可验证的 HR 消息上下文，未发送。",
      MESSAGE_DRAFT_FACT_UNSUPPORTED:"草稿里有系统找不到依据的个人信息，请修改后再发送。",
      MESSAGE_REPLY_SEND_ACTION_REQUIRED:"请从当前消息页面重新点击确认发送。"
    }[String(code||"")]||"发送没有开始，请刷新页面后重试。");
    const fieldForDraft=(draftId)=>document.querySelector('[data-draft-text][data-draft-id="'+Number(draftId)+'"]');
    const selectedFields=()=>sendChoices.filter((choice)=>batchMode&&choice.checked&&!choice.disabled).map((choice)=>fieldForDraft(choice.dataset.sendSelect)).filter(Boolean);
    const clearBatchSelection=()=>{for(const choice of sendChoices)choice.checked=false;};
    const updateSelection=()=>{for(const choice of sendChoices){const label=choice.closest(".message-send-choice");if(label)label.hidden=!batchMode||activeBatchId>0;}if(!sendBatchButton)return;const fields=selectedFields();const count=fields.length;const mixed=new Set(fields.map(field=>field.dataset.draftPlatform)).size>1;const batchVisible=batchMode;sendBatchButton.hidden=!batchVisible||activeBatchId>0;sendBatchButton.disabled=sendPending||count===0||mixed||activeBatchId>0;sendBatchButton.textContent=mixed?"BOSS 和智联请分批发送":"确认并串行发送 "+count+" 条";if(sendBatchEnterButton)sendBatchEnterButton.hidden=batchMode||activeBatchId>0;if(sendBatchExitButton)sendBatchExitButton.hidden=!batchMode||activeBatchId>0;if(sendPanel)sendPanel.hidden=!batchMode&&!activeBatchId&&!sendPending;if(sendBatchTitle&&!activeBatchId)sendBatchTitle.textContent=mixed?"请选择同一平台的草稿":batchMode?"已选择 "+count+" 条草稿":"批量发送尚未开始";};
    const setDiscoveryLocked=(locked)=>{for(const form of forms)for(const button of form.querySelectorAll("button")){if(!("sendBaseDisabled" in button.dataset))button.dataset.sendBaseDisabled=String(button.disabled);button.disabled=locked||button.dataset.sendBaseDisabled==="true";}};
    const setDraftPending=(fields,locked)=>{for(const field of fields){const card=field.closest("[data-draft-card]");if(!card||ownedDraftCards.has(card))continue;for(const control of card.querySelectorAll("button,input,textarea")){if(!("sendPendingBaseDisabled" in control.dataset))control.dataset.sendPendingBaseDisabled=String(control.disabled);control.disabled=locked||control.dataset.sendPendingBaseDisabled==="true";}}};
    const setOwned=(fields)=>{for(const field of fields){field.disabled=true;const card=field.closest("[data-draft-card]");if(!card)continue;ownedDraftCards.add(card);for(const control of card.querySelectorAll("button,input,textarea")){if(!("sendPendingBaseDisabled" in control.dataset))control.dataset.sendPendingBaseDisabled=String(control.disabled);control.disabled=true;}}};
    const releaseOwned=(field)=>{const card=field?.closest("[data-draft-card]");if(!card)return;ownedDraftCards.delete(card);for(const control of card.querySelectorAll("button,input,textarea"))control.disabled=control.dataset.sendPendingBaseDisabled==="true";};
    const sendStatusLabel=(status)=>({pending:"等待发送",selecting:"正在核对会话",verified:"目标已核对",filled:"草稿已填入",click_dispatched:"正在确认发送结果",succeeded:"已发送并记住本次修改",target_mismatch:"岗位或会话已变化，未发送",platform_rejected:"平台未接受本次发送",ambiguous:"发送结果暂时无法确认，已停止后续发送",stopped:"已停止，未发送"}[status]||"等待处理");
    const applySendState=(state)=>{if(!state?.batch||!Array.isArray(state.items))return;activeBatchId=Number(state.batch.id)||activeBatchId;const terminal=terminalBatchStatuses.has(state.batch.status);let finished=0;for(const item of state.items){const node=document.querySelector('[data-send-status="'+Number(item.draftId)+'"]');if(node){node.textContent=sendStatusLabel(item.status);node.dataset.state=item.status;}const field=fieldForDraft(item.draftId);if(field&&terminal&&["target_mismatch","platform_rejected","stopped"].includes(item.status))releaseOwned(field);else if(field)setOwned([field]);if(["succeeded","target_mismatch","platform_rejected","ambiguous","stopped"].includes(item.status))finished+=1;}if(sendPanel)sendPanel.dataset.state=state.batch.status;if(sendBatchTitle)sendBatchTitle.textContent="发送进度 "+finished+" / "+state.items.length;if(sendBatchStatus)sendBatchStatus.textContent=terminal?(state.batch.status==="completed"?"本批次已全部发送":"本批次已停止，未继续发送后续消息"):"正在后台逐条核对并发送，请不要关闭 OfferGo";if(sendStopButton){sendStopButton.hidden=terminal;sendStopButton.disabled=terminal;}setDiscoveryLocked(!terminal);if(terminal){activeBatchId=0;batchMode=false;clearBatchSelection();sendPending=false;if(sendPollTimer!==null)clearTimeout(sendPollTimer);sendPollTimer=null;}else scheduleSendPoll();updateSelection();};
    const readSendResponse=async(response)=>{const parsed=await read(response);if(!response.ok||!parsed.json||!parsed.body?.batch)throw new Error(parsed.body?.errorCode||"MESSAGE_REPLY_SEND_FAILED");return parsed.body;};
    const postSendBatch=async(items)=>readSendResponse(await fetch("/api/message-reply-send-batch",{method:"POST",headers:{"content-type":"application/json","x-roleflow-action":initial.messageReplyActionToken},body:JSON.stringify({profileId:initial.profileId,items})}));
    const scheduleSendPoll=()=>{if(activeBatchId>0&&sendPollTimer===null)sendPollTimer=setTimeout(pollSend,1200);};
    const pollSend=async()=>{sendPollTimer=null;if(!activeBatchId)return;try{const state=await readSendResponse(await fetch("/api/message-reply-send-status?profileId="+encodeURIComponent(initial.profileId)+"&batchId="+encodeURIComponent(activeBatchId)));applySendState(state);}catch(error){feedback.textContent=sendMessage(error.message);}};
    const startSend=async(fields)=>{if(sendPending||activeBatchId||!fields.length)return;sendPending=true;setDraftPending(fields,true);setDiscoveryLocked(true);updateSelection();feedback.textContent="正在保存你确认的草稿。";try{const saved=await Promise.all(fields.map(saveDraft));const items=saved.map((result)=>({draftId:Number(result.draftId),revision:Number(result.revision)}));const state=await postSendBatch(items);setOwned(fields);applySendState(state);feedback.textContent="已确认，正在后台串行发送。";}catch(error){sendPending=false;setDraftPending(fields,false);setDiscoveryLocked(false);feedback.textContent=sendMessage(error.message);updateSelection();}};
    for(const choice of sendChoices)choice.addEventListener("change",updateSelection);
    for(const button of document.querySelectorAll("[data-send-single]"))button.addEventListener("click",()=>{const field=fieldForDraft(button.dataset.sendSingle);if(field)startSend([field]);});
    sendBatchButton?.addEventListener("click",()=>startSend(selectedFields()));
    sendBatchEnterButton?.addEventListener("click",()=>{batchMode=true;clearBatchSelection();updateSelection();});
    sendBatchExitButton?.addEventListener("click",()=>{batchMode=false;clearBatchSelection();updateSelection();});
    sendStopButton?.addEventListener("click",async()=>{if(!activeBatchId||sendStopButton.disabled)return;sendStopButton.disabled=true;try{const state=await readSendResponse(await fetch("/api/message-reply-send-control",{method:"POST",headers:{"content-type":"application/json","x-roleflow-action":initial.messageReplyActionToken},body:JSON.stringify({profileId:initial.profileId,batchId:activeBatchId,action:"stop"})}));applySendState(state);feedback.textContent="已停止后续发送。";}catch(error){sendStopButton.disabled=false;feedback.textContent=sendMessage(error.message);}});
    updateSelection();
    if(initial.initialReplySend)applySendState(initial.initialReplySend);
    const actionTerminal=new Set(["succeeded","target_mismatch","platform_rejected","ambiguous","stopped"]);
    const actionLabel=(status)=>({confirmed:"已确认，等待处理",selecting:"正在核对当前会话",verified:"会话已核对",click_dispatched:"正在确认平台结果",succeeded:"已处理完成",target_mismatch:"会话已变化，本次未执行",platform_rejected:"平台未接受本次操作",ambiguous:"结果暂时无法确认，已停止重试",stopped:"本次操作已停止"}[status]||"等待处理");
    const actionError=(code)=>({MESSAGE_ACTION_PROFILE_BUSY:"已有一项消息操作正在执行，请等待完成。",MESSAGE_ACTION_LEASE_BUSY:"招聘平台正在执行其他任务，请稍后再试。",MESSAGE_ACTION_SOURCE_NOT_ACTIONABLE:"这条请求已经变化，请先同步最新消息。",MESSAGE_ACTION_DECISION_CONFLICT:"这条请求已经处理过。",MESSAGE_ACTION_KIND_UNSUPPORTED:"当前平台不支持这个操作，本次没有执行。",MESSAGE_ACTION_PLATFORM_UNSUPPORTED:"当前平台操作还没有通过安全核验，本次没有执行。",MESSAGE_REPLY_SEND_ACTION_REQUIRED:"请刷新当前消息页面后重新确认。"}[code]||"这项操作没有执行，请同步最新消息后重试。");
    const pollMessageAction=async(actionId,group)=>{try{const response=await fetch("/api/message-action/status?profileId="+encodeURIComponent(initial.profileId)+"&actionId="+encodeURIComponent(actionId));const parsed=await read(response);if(!response.ok||!parsed.json||!parsed.body?.status)throw new Error(parsed.body?.errorCode||"MESSAGE_ACTION_FAILED");const node=group.querySelector("[data-message-action-feedback]");if(node)node.textContent=actionLabel(parsed.body.status);if(actionTerminal.has(parsed.body.status)){if(parsed.body.status==="succeeded")setTimeout(()=>requestReload(true),350);return;}setTimeout(()=>pollMessageAction(actionId,group),700);}catch(error){const node=group.querySelector("[data-message-action-feedback]");if(node)node.textContent=actionError(error.message);}};
    for(const button of document.querySelectorAll("[data-message-action-confirm]"))button.addEventListener("click",async()=>{const group=button.closest("[data-message-action-group]");if(!group||group.dataset.pending==="true")return;group.dataset.pending="true";for(const peer of group.querySelectorAll("button"))peer.disabled=true;const status=group.querySelector("[data-message-action-feedback]");if(status)status.textContent="正在核对当前"+(button.dataset.platform==="boss"?" BOSS":"智联")+"会话…";const actionKind="resume"+"_request_"+(button.dataset.actionKind==="accept_resume"?"accept":"decline");const body={profileId:initial.profileId,platform:button.dataset.platform,conversationKey:button.dataset.conversationKey,messageKey:button.dataset.messageKey,actionKind,idempotencyKey:crypto.randomUUID()};try{const response=await fetch("/api/message-action/confirm",{method:"POST",headers:{"content-type":"application/json","x-roleflow-action":initial.messageReplyActionToken},body:JSON.stringify(body)});const parsed=await read(response);if(!response.ok||!parsed.json||!parsed.body?.id)throw new Error(parsed.body?.errorCode||"MESSAGE_ACTION_FAILED");if(status)status.textContent=actionLabel(parsed.body.status);pollMessageAction(parsed.body.id,group);}catch(error){group.dataset.pending="false";for(const peer of group.querySelectorAll("button"))peer.disabled=false;if(status)status.textContent=actionError(error.message);}});
    const applySelection=(preferredKey=selectedKey,persist=true)=>{
      const rows=Array.from(document.querySelectorAll(".message-list-item[data-platform]"));
      for(const row of rows)row.hidden=false;
      const visibleChoices=messageChoices;
      const next=selectionLocked?null:(visibleChoices.find(choice=>choice.dataset.messageView===preferredKey)||visibleChoices.find(choice=>choice.dataset.messageView===selectedKey)||visibleChoices[0]||null);
      selectedKey=next?.dataset.messageView||"";
      for(const choice of messageChoices)choice.checked=choice===next;
      for(const panel of messagePanels)panel.hidden=panel.dataset.messageDetailPanel!==selectedKey;
      const empty=document.querySelector("[data-source-empty]");if(empty)empty.hidden=visibleChoices.length>0;
      const notFound=document.querySelector(".message-not-found");if(notFound)notFound.hidden=!selectionLocked;
      if(persist)try{if(selectedKey)localStorage.setItem(selectedKeyStorage,selectedKey);else localStorage.removeItem(selectedKeyStorage);}catch{}
      updateSelection();
    };
    let pendingTransition=null;
    let pendingChoiceKey="";
    let transitionRunning=false;
    const requestTransition=(transition)=>{pendingTransition=transition;applySelection(selectedKey,false);runTransitions();};
    const focusDetail=()=>messagePanels.find(panel=>panel.dataset.messageDetailPanel===selectedKey)?.querySelector("[data-message-back], [data-draft-text], button, input")?.focus();
    const runTransitions=async()=>{
      if(transitionRunning)return;
      transitionRunning=true;
      while(pendingTransition){
        let next=pendingTransition;pendingTransition=null;
        const current=messagePanels.find(panel=>panel.dataset.messageDetailPanel===selectedKey);
        const fields=Array.from(current?.querySelectorAll("[data-draft-text]")||[]).filter(field=>!field.disabled);
        try{await saveStableDrafts(fields);}catch{
          pendingTransition=null;pendingChoiceKey="";
          feedback.textContent="当前草稿未能保存，已保留当前消息，请稍后重试。";
          applySelection(selectedKey,false);
          const failed=fields.find(field=>draftSaveStatus(field)?.textContent.includes("失败"))||fields[0];
          // A hidden alternative remains a real draft: reveal its editor when its save fails.
          if(failed&&workspace?.dataset.mobileList!=="true"){const disclosure=failed.closest("details");if(disclosure)disclosure.open=true;failed.focus();}
          else messageChoices.find(choice=>choice.dataset.messageView===selectedKey)?.focus();
          break;
        }
        if(pendingTransition){next=pendingTransition;pendingTransition=null;}
        if(next.key)selectionLocked=false;
        applySelection(next.key||selectedKey);
        pendingChoiceKey="";
        if(next.key){detailChosen=true;if(workspace)delete workspace.dataset.mobileList;if(mobileList())focusDetail();}
        if(next.back&&mobileList()&&workspace){detailChosen=false;workspace.dataset.mobileList="true";messageChoices.find(choice=>choice.dataset.messageView===selectedKey)?.focus();}
      }
      transitionRunning=false;
      if(pendingTransition)runTransitions();
    };
    const mobileList=()=>Boolean(typeof window!=="undefined"&&window.matchMedia&&window.matchMedia("(max-width: 760px)").matches);
    let wasMobile=mobileList();
    let detailChosen=Boolean(initial.directContact);
    workspace?.querySelector(".message-detail")?.addEventListener("focusin",()=>{detailChosen=true;});
    if(wasMobile&&workspace&&!initial.directContact)workspace.dataset.mobileList="true";
    if(typeof window!=="undefined")window.addEventListener("resize",()=>{const nowMobile=mobileList();if(!nowMobile&&workspace)delete workspace.dataset.mobileList;if(nowMobile&&!wasMobile&&workspace&&!detailChosen)workspace.dataset.mobileList="true";wasMobile=nowMobile;});
    const openChoice=(choice)=>{if(!choice.checked)return;const key=choice.dataset.messageView;if(pendingChoiceKey===key)return;if(key===selectedKey&&workspace?.dataset.mobileList!=="true"){detailChosen=true;return;}pendingChoiceKey=key;requestTransition({key});};
    for(const choice of messageChoices){choice.addEventListener("change",()=>openChoice(choice));choice.closest(".message-list-item")?.addEventListener("click",()=>queueMicrotask(()=>openChoice(choice)));}
    for(const choice of messageChoices)choice.addEventListener("keydown",event=>{if(event.key===" "||event.key==="Enter"){event.preventDefault();choice.checked=true;openChoice(choice);}});
    for(const button of document.querySelectorAll("[data-message-back]"))button.addEventListener("click",()=>{if(mobileList())requestTransition({back:true});});
    applySelection();
    for(const link of document.querySelectorAll("[data-flush-drafts], .primary-nav a"))link.addEventListener("click",async(event)=>{const fields=Array.from(document.querySelectorAll("[data-draft-text]")).filter(field=>!field.disabled);if(!fields.length)return;event.preventDefault();try{await saveStableDrafts(fields);location.href=link.href;}catch{feedback.textContent="当前草稿未能保存，请稍后重试。";}});
    const poll=async()=>{pollTimer=null;if(reloadPending||pollPending||actionPending)return;pollPending=true;const version=actionVersion;try{const response=await fetch("/api/message-discovery-status?profileId="+encodeURIComponent(initial.profileId));const parsed=await read(response);if(reloadPending||actionPending||version!==actionVersion)return;if(!accepted(response,parsed,pollStatuses)){show(rejectedCode(parsed));return;}currentStatus=parsed.body.status;if(currentStatus==="running"){feedback.textContent=liveStatusText(parsed.body);feedback.dataset.errorCode="";schedulePoll();}else requestReload(true);}catch{if(!reloadPending&&!actionPending&&version===actionVersion)show("MESSAGE_DISCOVERY_SERVICE_UNAVAILABLE");}finally{pollPending=false;if(!reloadPending&&!actionPending&&version!==actionVersion&&currentStatus==="running")schedulePoll();}};
    if(currentStatus==="running")schedulePoll();
  }());</script>`;
}

function messageViewKey(type, parts) {
  return `${type}-${crypto.createHash("sha256").update(JSON.stringify(parts.map((part) => String(part || "")))).digest("hex")}`;
}

function messageIntentLabel(value) {
  return {
    interview_invitation: "正式面试邀约",
    interest_check: "询问是否有意向",
    information_request: "需要你补充信息",
    information_update: "对方补充了信息",
    general_communication: "普通沟通",
    rejection: "本次机会已结束",
    manual_review: "需要人工判断"
  }[String(value || "")] || "需要人工判断";
}

function messageDiscoveryManualActionText(result) {
  if (result?.missingFactKey) return missingFactQuestion(result);
  if (result?.messageIntent === "manual_review") {
    return result?.manualActionReason || "当前消息需要人工判断，暂不生成草稿。";
  }
  const category = String(result?.messageCategory || "");
  if (category === "salary") return "薪资沟通需人工处理，请确认你的口径后再回复。";
  if (category === "sensitive") return "消息涉及敏感信息，需要人工判断后再回复。";
  if (category === "identity_uncertain") return "岗位或会话身份仍需人工核对，暂不生成草稿。";
  return result?.manualActionReason || "当前结果需要人工处理，暂不生成草稿。";
}

function renderMissingFactForm(result, { profileId, escapeHtml, escapeAttr }) {
  const question = missingFactQuestion(result);
  return `<section class="message-missing-fact"><h4>需要你确认一项个人信息</h4><p class="line">${escapeHtml(question)}</p><p class="line">OfferGo 不会替你编造这个答案。填写后会立即生成可确认的回复草稿。</p><form class="form-stack" data-discovery-form method="post" action="/api/message-discovery"><input type="hidden" name="action" value="answer_fact"><input type="hidden" name="profileId" value="${Number(profileId)}"><input type="hidden" name="cardId" value="${Number(result.cardId)}"><input type="hidden" name="messageGroupKey" value="${escapeAttr(result.messageGroupKey || "")}"><input type="hidden" name="factKey" value="${escapeAttr(result.missingFactKey || "")}"><label>你的回答<textarea name="factValue" required placeholder="例如：本周工作日下午都方便电话沟通"></textarea></label><button>生成回复草稿</button></form></section>`;
}

function missingFactQuestion(result) {
  const explicit = String(result?.missingFactQuestion || "").trim();
  if (explicit) return explicit;
  return ({
    employment_status: "你目前是在职、离职，还是正在寻找新机会？",
    availability_date: "你什么时候方便沟通或到岗？",
    current_city: "你目前所在的城市是哪里？",
    expected_salary: "你的期望薪资范围是多少？",
    accepts_travel: "你是否能接受出差？",
    accepts_relocation: "你是否能接受异地工作？",
    accepts_overtime: "你对加班的接受范围是什么？"
  })[String(result?.missingFactKey || "")] || "请补充 HR 当前询问的个人信息。";
}

function messageDiscoveryPhaseText(status) {
  if (status?.phase === "cooldown") {
    const remainingSeconds = Math.max(1, Math.ceil((Date.parse(status.waitUntil) - Date.now()) / 1000));
    return Number.isFinite(remainingSeconds)
      ? `正在按安全节奏冷却，约 ${remainingSeconds} 秒后继续。`
      : "正在按安全节奏冷却，稍后继续。";
  }
  if (status?.phase === "reading_detail") return "正在后台读取当前岗位详情，不会抢占前台。";
  if (status?.phase === "analyzing_job") return "岗位资料已读取，正在完成岗位分析；首次分析可能需要几分钟。";
  if (status?.phase === "analyzing_messages") return "正在整理消息并生成回复建议，模型响应可能需要一些时间。";
  if (status?.phase === "reading_messages") return "正在加载并读取消息，可随时安全停止。";
  if (status?.phase === "starting") return "正在准备只读消息检查。";
  return "";
}

function messageDiscoveryReasonText(code) {
  return messageDiscoveryRecoveryMessages()[String(code || "")] || (code ? messageDiscoveryRecoveryMessages().default : "");
}

function messageDiscoveryRecoveryMessages() {
  const browserUnavailable = "无法连接 Edge 或读取消息页。请确认 Edge 和本地浏览器控制可用后重试。";
  const verifyIdentity = "无法确认本地岗位与会话是否一致。请在人工粘贴流程中核对后处理。";
  return {
    ZHAOPIN_MESSAGE_CONTENT_PENDING: "这条会话的消息还没有加载完成，已保留待重试。稍后可重新开始只读发现。",
    ZHAOPIN_MESSAGE_CONTENT_UNSUPPORTED: "这条消息包含暂时无法读取的内容，已保留并会在后续同步中继续识别。",
    ZHAOPIN_MESSAGE_STRUCTURE_CHANGED: "智联消息页面暂时无法可靠读取，已保留待重试。",
    ZHAOPIN_MESSAGE_TIMELINE_FAILED: "智联会话内容暂时未能加载，已保留待重试。",
    ZHAOPIN_MESSAGE_TAB_AMBIGUOUS: "连接了多个智联消息页，请只保留一个后重试。",
    ZHAOPIN_MESSAGE_LOGIN_REQUIRED: "智联登录已失效，请登录后重试。",
    ZHAOPIN_MESSAGE_RISK_CONTROL: "智联需要完成安全检查，请处理后重试。",
    ZHAOPIN_MESSAGE_PAGE_LOST: "智联消息页已变化，请恢复消息页后重试。",
    ZHAOPIN_MESSAGE_DETAIL_COMPANY_UNVERIFIED: "会话与岗位详情的公司名称暂时无法核对。消息已保留，系统会继续补充岗位资料。",
    ZHAOPIN_MESSAGE_DETAIL_TARGET_MISMATCH: "这条会话与岗位详情暂时无法确认，已保留待重试；其他消息会继续处理。",
    ZHAOPIN_MESSAGE_DETAIL_INCOMPLETE: "这份岗位详情还不完整，消息已保留，暂不生成草稿。可稍后重新只读发现。",
    ZHAOPIN_MESSAGE_DETAIL_READ_TIMEOUT: "这份岗位详情暂时读取超时，消息已保留；系统会继续处理其他消息，下次同步时可重试。",
    ZHAOPIN_MESSAGE_DETAIL_TARGET_UNAVAILABLE: "这份岗位详情已跳转或暂时不可用，消息已保留；系统会继续处理其他消息。",
    MESSAGE_DISCOVERY_JOB_CONTEXT_UNAVAILABLE: "这份岗位资料暂时还不完整，已保留待重试。下次同步时会继续补全，无需先去今日任务。",
    MESSAGE_DISCOVERY_STOPPED: "已按你的操作安全停止。需要继续时重新开始只读发现。",
    MESSAGE_DISCOVERY_ALREADY_RUNNING: "消息发现正在运行。请等待完成或使用安全停止。",
    MESSAGE_DISCOVERY_RUNNING: "消息发现正在运行。请先安全停止，再放弃草稿。",
    MESSAGE_DISCOVERY_NOT_RUNNING: "消息发现当前未运行。请重新加载页面后重试。",
    MESSAGE_DISCOVERY_SERVICE_UNAVAILABLE: "OfferGo 本地服务已停止或暂时无响应。请重新双击桌面的 OfferGo，再回到消息页继续同步；已保存的结果不会丢失。",
    MESSAGE_DISCOVERY_BROWSER_UNAVAILABLE: browserUnavailable,
    BOSS_BROWSER_DISCONNECTED: browserUnavailable,
    BOSS_BROWSER_TIMEOUT: browserUnavailable,
    BOSS_COMMAND_UNAVAILABLE: browserUnavailable,
    BOSS_MESSAGE_TAB_MISSING: browserUnavailable,
    BOSS_MESSAGE_TAB_AMBIGUOUS: browserUnavailable,
    BOSS_MESSAGE_PAGE_LOST: browserUnavailable,
    BOSS_LOGIN_REQUIRED: "BOSS 登录已失效。请在固定 BOSS 消息页重新登录后重试。",
    BOSS_RISK_CONTROL: "浏览器需要完成安全检查。请完成检查，解除前不要继续本地操作。",
    BOSS_RUNTIME_BLOCKED: "浏览器操作当前被安全限制。请完成安全检查，解除前不要继续本地操作。",
    MESSAGE_DISCOVERY_LEASE_BUSY: "BOSS 正被另一项任务使用。请等待或停止冲突任务后重试。",
    MESSAGE_DISCOVERY_LEASE_LOST: "BOSS 任务控制权已丢失。请等待或停止冲突任务后重试。",
    MESSAGE_DISCOVERY_MODEL_NOT_READY: "深度分析模型尚未就绪。请到模型设置测试深度分析模型。",
    MESSAGE_DISCOVERY_MODEL_QUOTA_EXHAUSTED: "消息已全部读取，但模型服务额度不足，仍有岗位分析尚未完成。请到“模型与设置”检查服务额度后重新同步；已完成结果不会丢失。",
    MESSAGE_DISCOVERY_JOB_ANALYSIS_FAILED: "消息已全部读取，但模型暂时未能完成部分岗位分析。未完成项已保留，请稍后重新同步；已完成结果不会丢失。",
    BOSS_MESSAGE_CARD_NOT_FOUND: verifyIdentity,
    BOSS_MESSAGE_CARD_AMBIGUOUS: verifyIdentity,
    BOSS_MESSAGE_SALARY_MISMATCH: verifyIdentity,
    BOSS_MESSAGE_CITY_MISMATCH: verifyIdentity,
    BOSS_MESSAGE_COMPANY_MISMATCH: verifyIdentity,
    BOSS_MESSAGE_THREAD_MISMATCH: verifyIdentity,
    BOSS_MESSAGE_JOB_TARGET_UNAVAILABLE: "无法确认当前会话对应的岗位入口。该会话已保留，未打开详情，也未生成草稿。",
    BOSS_MESSAGE_DETAIL_BROWSER_FAILED: "后台岗位详情读取遇到浏览器异常。该会话已保留，本次只读发现已安全停止。",
    BOSS_MESSAGE_DETAIL_NOT_BACKGROUND: "岗位详情未能保持后台安全打开；若临时页已创建，系统会先关闭它。该会话已保留，本次只读发现已停止，请保持专用 Edge 的固定标签页不变后重试。",
    BOSS_MESSAGE_DETAIL_TARGET_MISMATCH: "后台打开的岗位与当前会话不一致。临时页会被关闭，该会话已保留待处理。",
    BOSS_MESSAGE_DETAIL_BASELINE_NOT_RESTORED: "岗位详情读取后未能确认浏览器已恢复安全状态。本次只读发现已停止，请检查 BOSS 标签页。",
    MESSAGE_DISCOVERY_JOB_ANALYSIS_INCOMPLETE: "岗位详情已读取，但本地分析还不完整。该会话已保留，请稍后重新开始只读发现。",
    BOSS_MESSAGE_GROUP_LIMIT: "会话内容不适合自动整理。请改用人工粘贴流程处理。",
    BOSS_MESSAGE_GROUP_TEXT_LIMIT: "会话内容过长，无法安全整理。请改用人工粘贴流程处理。",
    BOSS_MESSAGE_CONTENT_UNSUPPORTED: "会话包含无法安全读取的内容。请改用人工粘贴流程处理。",
    default: "消息读取、模型分析或本地服务响应失败，未发送任何消息。请确认本地服务并打开诊断查看详情。"
  };
}

module.exports = {
  renderMessageDiscoveryPage,
  messageDiscoveryClientScript,
  messageDiscoveryReasonText,
  messageIntentLabel
};

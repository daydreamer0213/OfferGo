const { escapeHtml, escapeAttr } = require('../http/response');
const { renderDashboardFrame } = require('../ui/shell');
const { buildHealthView } = require('../../application/funnel_analysis/health_view');
const SITE_LABELS = { boss: 'BOSS', zhaopin: '智联' };

function renderFunnelPage({ plan = {}, dashboard = {}, view = 'current' } = {}) {
  const planId = Number(plan.id || 0);
  const path = `/funnel?planId=${encodeURIComponent(planId)}`;
  const lifetime = view === 'lifetime';
  const platforms = dashboard.platforms || [];
  const started = platforms.reduce((sum, item) => sum + count(lifetime ? item.lifetime?.started : item.currentRound?.started), 0);
  const health = buildHealthView(dashboard);
  return renderDashboardFrame({ currentPath: path, todayPath: `/plan?planId=${planId}`, planId,
    stage: '求职体检', brandHref: `/plan?planId=${planId}`,
    content: `<main id="main-content" class="funnel-main feedback-main">
      <header class="page-heading"><h1>求职体检</h1><p class="lede">${escapeHtml(plan.name || '当前求职方案')}</p></header>
      <section class="feedback-overview" aria-label="投递反馈">
        <div class="feedback-toolbar"><nav aria-label="统计范围">
          <a href="${path}"${!lifetime ? ' aria-current="true"' : ''}>当前方案</a>
          <a href="${path}&amp;view=lifetime"${lifetime ? ' aria-current="true"' : ''}>累计记录</a>
        </nav><a class="feedback-message-link" href="/messages?planId=${planId}">查看消息</a></div>
        <p class="feedback-scope">${lifetime ? '所有方案的本地记录' : '从联系岗位到拿到 Offer，每一步都按已确认的信息统计。'}</p>
        ${lifetime ? renderLifetimeFeedback(platforms) : renderCurrentHealth(health, dashboard.advice, planId, dashboard.feedbackReview)}
        ${!started ? `<p class="feedback-empty">${lifetime ? '还没有联系岗位。' : '当前方案还没有联系岗位。'}<a href="/plan?planId=${planId}">去发现岗位</a></p>` : ''}
      </section>
      ${renderIncomingContacts(dashboard.incomingContacts, planId)}
      ${!lifetime ? renderComparison(platforms) : ''}
      ${renderAdjustment(planId, dashboard.activeRevisionId)}
    </main>` });
}

function renderCurrentHealth(health, advice, planId, review = {}) {
  const overview = health.overview || {};
  const summaries = [
    ['联系岗位', overview.contacted],
    ['收到回复', overview.replied],
    ['有效沟通', overview.effectiveConversation],
    ['面试邀请', overview.interviewInvited],
    ['完成面试', overview.interviewCompleted],
    ['收到 Offer', overview.offerReceived]
  ];
  const primary = review?.primary;
  const destination = primary ? [
    primary.target === 'interview' ? `/queue?planId=${planId}&site=${encodeURIComponent(primary.site)}&pool=interview`
      : primary.target === 'resume' ? `/resume-optimization?planId=${planId}`
        : feedbackMessageUrl(primary.evidence[0], primary.site, planId),
    primary.target === 'interview' ? '查看面试与 Offer 记录' : primary.target === 'resume' ? '打开简历工作室' : '查看这条对话'
  ] : advice ? adviceDestination(advice, planId) : null;
  return `<div class="health-summary" aria-label="求职进展概览">${summaries.map(([label, value]) => `<div><strong>${count(value)}</strong><span>${escapeHtml(label)}</span></div>`).join('')}</div>
    <section class="health-diagnosis" aria-label="当前判断"><div><p class="section-label">${health.diagnosis?.siteLabel ? `${escapeHtml(health.diagnosis.siteLabel)} · ` : ''}现在最值得关注</p><h2>${escapeHtml(health.diagnosis?.title || '继续记录真实进展')}</h2><p>${escapeHtml(health.diagnosis?.detail || '')}</p>${health.diagnosis?.priorityCheck ? `<p>${escapeHtml(health.diagnosis.priorityCheck)}</p>` : ''}</div>${destination ? `<a href="${escapeAttr(destination[0])}">${escapeHtml(destination[1])}</a>` : ''}</section>
    ${renderFeedbackReview(review, planId)}
    <div class="health-platforms">${(health.platformFunnels || []).map(renderHealthPlatform).join('')}</div>
    <p class="feedback-footnote">等待中的岗位还没有到判断时间；状态未知表示平台没有提供可靠信息，不会算作失败。${count(health.stale?.total) ? ` 另有 ${count(health.stale.total)} 个岗位超过 7 天没有新进展。` : ''}</p>`;
}

function feedbackMessageUrl(item = {}, site, planId) {
  return `/messages?planId=${encodeURIComponent(planId)}&source=${encodeURIComponent(site)}&contact=${encodeURIComponent(item.contactKey || '')}&task=all`;
}

function renderFeedbackReview(review, planId) {
  const topics = review?.topics || [];
  return `<section class="feedback-review" data-feedback-review aria-labelledby="feedback-review-title">
    <header><h2 id="feedback-review-title">根据实际反馈，先检查什么</h2><p class="hint">单条具体反馈也可以先处理。指标用来找检查方向，固定比例是内部提醒线，不是行业合格线。</p></header>
    ${topics.length ? topics.map(topic => `<article class="feedback-review-topic" data-feedback-topic="${escapeAttr(topic.key)}">
      <div class="feedback-review-topic-heading"><span>${escapeHtml(SITE_LABELS[topic.site] || topic.site)} · ${count(topic.jobCount)} 个岗位</span><h3>${escapeHtml(topic.title)}</h3></div>
      <p>${escapeHtml(topic.action)}</p>
      <details><summary>查看依据 · ${topic.evidence.some(item => item.quote) ? `${topic.evidence.filter(item => item.quote).length} 条 HR 消息` : '已记录进展'}</summary>
        ${topic.evidence.map(item => `<section class="feedback-review-evidence"><h4>${escapeHtml(item.title || '已关联岗位')} · ${escapeHtml(item.company || '公司未记录')}</h4>
          ${item.quote ? `<p class="section-label">HR 原话</p><blockquote>${escapeHtml(item.quote)}</blockquote>${item.replyText ? `<details class="feedback-review-context"><summary>随后观察到的本人消息</summary><p class="feedback-review-text">${escapeHtml(item.replyText)}</p></details>` : '<p class="hint">未获取到这条消息之后的本人回复；可进入原对话核对。</p>'}` : `<p>当前记录：${escapeHtml(item.cardStage === 'offer_received' ? '已收到 Offer' : item.cardStage === 'interview_completed' ? '已完成面试，后续结果待核对' : '发送简历动作成功，后续反馈待核对')}。</p>`}
          <details class="feedback-review-context"><summary>本地岗位与参考简历</summary>
            <p class="hint">岗位为当前本地记录；简历为联系岗位时绑定的本地版本。</p>
            <h5>岗位说明</h5><p class="feedback-review-text">${escapeHtml(item.description || '没有可用的本地岗位正文。')}</p>
            <h5>${item.resumeVersionId ? `参考简历 · 版本 ${escapeHtml(item.resumeVersionId)}` : '参考简历未记录'}</h5><p class="feedback-review-text">${escapeHtml(item.resumeText || '未获取到当时绑定的简历正文。')}</p>
          </details>
          <div class="button-row">${item.contactKey ? `<a href="${escapeAttr(feedbackMessageUrl(item, topic.site, planId))}">查看原对话</a>` : `<a href="/queue?planId=${escapeAttr(planId)}&amp;site=${escapeAttr(topic.site)}&amp;pool=interview">查看面试记录</a>`}${['responsibility', 'method', 'result', 'project_fact'].includes(topic.category) ? `<a href="/resume-optimization?planId=${escapeAttr(planId)}">检查项目经历描述</a>` : ''}</div>
        </section>`).join('')}
      </details>
    </article>`).join('') : '<p class="feedback-review-empty">当前方案还没有可引用的具体反馈。可以先查看已有指标和实际对话，暂不据此判定需要改哪一段简历。</p>'}
    <p class="feedback-review-next"><strong>改完怎么看：</strong>先处理一项，保留原版本和其他条件，记录本次调整；之后分平台、同类岗位观察回复、约面和后续进展。比例变化本身不能证明由这次修改造成。</p>
  </section>`;
}

function adviceDestination(advice, planId) {
  if (advice.stage === 'interviewInvited') return [`/resume-optimization?planId=${planId}`, '打开简历工作室'];
  if (advice.stage === 'effectiveConversation') return [`/messages?planId=${planId}`, '查看消息与回复'];
  if (['interviewConfirmed', 'interviewCompleted', 'offerReceived'].includes(advice.stage)) {
    return [`/queue?planId=${planId}&site=${encodeURIComponent(advice.site)}&pool=interview`, '查看面试进展'];
  }
  return [`/queue?planId=${planId}&site=${encodeURIComponent(advice.site)}&pool=waiting_reply`, '查看等待回复的岗位'];
}

function renderHealthPlatform(platform) {
  return `<article class="health-platform" data-health-platform="${escapeAttr(platform.site)}"><header><div><p class="section-label">${escapeHtml(platform.label)}</p><h3>进展路径</h3></div><p>${count(platform.waiting)} 个等待中 · ${count(platform.unknown)} 个状态未知${platform.staleCount ? ` · ${count(platform.staleCount)} 个超过 7 天无进展` : ''}</p></header>
    <ol class="health-stage-track">${platform.stages.map(renderHealthStage).join('')}</ol></article>`;
}

function renderHealthStage(stage) {
  const detail = stage.key === 'started'
    ? '已记录的求职动作'
    : stage.eligible
      ? `${stage.eligible} 个可核对${stage.waiting ? ` · ${stage.waiting} 个仍在等待` : ''}${stage.unknown ? ` · ${stage.unknown} 个状态未知` : ''}`
      : stage.unknown || stage.waiting
        ? `${stage.waiting} 个仍在等待 · ${stage.unknown} 个状态未知`
        : '还没有可核对记录';
  return `<li data-health-stage="${escapeAttr(stage.key)}"><strong>${count(stage.reached)}</strong><div><span>${escapeHtml(stage.label)}</span><small>${escapeHtml(detail)}</small></div></li>`;
}

function renderLifetimeFeedback(platforms) {
  return `<div class="feedback-table-scroll" role="region" aria-label="平台累计记录" tabindex="0"><table aria-label="累计记录投递反馈"><thead><tr>
    <th scope="col">平台</th><th scope="col">已联系岗位</th><th scope="col">已回复</th><th scope="col">回复占比</th>
    </tr></thead><tbody>${platforms.map(item => renderPlatform(item, true)).join('')}</tbody></table></div>
    <p class="feedback-footnote">累计记录用于回看总量；当前方案页会展示完整进展路径。</p>`;
}

function renderPlatform(item, lifetime) {
  const round = item.currentRound || {};
  const values = lifetime ? item.lifetime || {} : { started: round.started, ...round.immediatePositive };
  const started = count(values.started), replied = count(values.replied);
  const changed = !lifetime && round.changeKinds?.some(kind => kind !== 'initial');
  return `<tr data-feedback-platform="${escapeAttr(item.site)}"><th scope="row">${escapeHtml(SITE_LABELS[item.site] || item.site)}
    ${changed ? `<small>${escapeHtml(localDate(round.startedAt))}调整后</small>` : ''}</th>
    <td><strong>${started}</strong></td><td><strong>${replied}</strong></td><td><span class="feedback-reply-share">${started ? percent(replied, started) : '—'}</span></td></tr>`;
}

function renderAdvice(dashboard, planId) {
  const advice = dashboard.advice;
  if (!advice) {
    const rounds = (dashboard.platforms || []).map(item => item.currentRound).filter(item => item?.started);
    const waiting = rounds.some(round => round.waiting > 0);
    const enough = rounds.some(round => round.strength !== 'facts' && round.unknown < Math.ceil(round.mature / 2));
    return `<p class="feedback-status">${waiting ? '最近联系的部分岗位还需等待反馈。' : enough
      ? '目前没有足够依据建议调整投递方式。' : '现有反馈还不足以判断是否需要调整。'}</p>`;
  }
  const n = count(advice.numerator), d = count(advice.denominator);
  const reasons = {
    read: `${d} 个已获取阅读状态的岗位中，${n} 个已读。`,
    replied: `${d} 个已读岗位中，${n} 个有回复。`,
    effectiveConversation: `${d} 个已确认回复内容的岗位中，${n} 个进入进一步沟通。`,
    interviewInvited: `${d} 个已进入进一步沟通且反馈明确的岗位中，${n} 个邀请面试。`,
    interviewConfirmed: `${d} 个已收到面试邀请且反馈明确的岗位中，${n} 个已确认安排或后续进展。`
  };
  const destination = advice.stage === 'interviewInvited'
    ? [`/resume-optimization?planId=${planId}`, '打开简历工作室']
    : advice.stage === 'effectiveConversation' ? [`/messages?planId=${planId}`, '查看消息与回复']
      : advice.stage === 'interviewConfirmed' ? [`/queue?planId=${planId}&site=${encodeURIComponent(advice.site)}&pool=interview`, '查看面试进展']
        : [`/queue?planId=${planId}&site=${encodeURIComponent(advice.site)}&pool=waiting_reply`, '查看等待回复的岗位'];
  return `<section class="feedback-advice" aria-label="优先建议"><div><p class="section-label">${escapeHtml(SITE_LABELS[advice.site])} · 优先建议</p>
    <h2>${escapeHtml(advice.title)}</h2><p>${escapeHtml(reasons[advice.stage] || '')}可以先检查这一环节。</p></div>
    <a href="${escapeAttr(destination[0])}">${destination[1]}</a></section>`;
}

function renderComparison(platforms) {
  const ready = platforms.filter(item => item.roundComparison?.status === 'ready');
  if (!ready.length) return '';
  return `<section class="feedback-comparison" aria-label="调整前后"><h2>调整前后</h2>${ready.map(item => {
    const { before, after } = item.roundComparison;
    return `<p><strong>${escapeHtml(SITE_LABELS[item.site])}</strong> · 可比较记录的回复比例：${percent(before.replied.numerator, before.replied.denominator)} → ${percent(after.replied.numerator, after.replied.denominator)}</p>`;
  }).join('')}<p class="feedback-footnote">只比较已等待充分时间且回复状态明确的岗位；变化不一定由这次调整造成。</p></section>`;
}

function renderIncomingContacts(incoming = {}, planId) {
  const items = Array.isArray(incoming.items) ? incoming.items : [];
  const bySite = new Map((Array.isArray(incoming.platforms) ? incoming.platforms : [])
    .map(item => [item.site, item]));
  const platforms = ['boss', 'zhaopin'].map(site => bySite.get(site) || {
    site, contacted: 0, resumeRequested: 0, interviewInvited: 0
  });
  return `<section class="feedback-incoming" aria-label="收到的联系"><h2>收到的联系</h2>
    <p class="feedback-scope">包含 HR 新招呼和对投递的回复，同一会话只计一次。</p>
    <div class="feedback-table-scroll" role="region" aria-label="收到的联系平台统计" tabindex="0"><table aria-label="收到的联系平台统计"><thead><tr>
      <th scope="col">平台</th><th scope="col">已收到联系</th><th scope="col">索要简历</th><th scope="col">面试邀请</th>
    </tr></thead><tbody>${platforms.map(renderIncomingPlatform).join('')}</tbody></table></div>
    ${platforms.map(platform => renderIncomingDetails(platform, items, planId)).join('')}
  </section>`;
}

function renderIncomingPlatform(platform) {
  const site = String(platform.site || '');
  const allTarget = `#incoming-${site}-all-details`;
  const resumeTarget = `#incoming-${site}-resume-details`;
  const interviewTarget = `#incoming-${site}-interview-details`;
  return `<tr data-incoming-platform="${escapeAttr(site)}"><th scope="row">${escapeHtml(SITE_LABELS[site] || site)}</th>
    <td><a href="${allTarget}">${count(platform.contacted)}</a></td>
    <td><a href="${resumeTarget}">${count(platform.resumeRequested)}</a></td>
    <td><a href="${interviewTarget}">${count(platform.interviewInvited)}</a></td></tr>`;
}

function renderIncomingDetails(platform, items, planId) {
  const site = String(platform.site || '');
  const rows = items.filter(item => item?.platform === site);
  return [
    renderIncomingDetail(site, 'all', `${count(platform.contacted)} 条已保存联系`, rows, planId),
    renderIncomingDetail(site, 'resume', `${count(platform.resumeRequested)} 条索要简历`, rows.filter(item => item.resumeRequested), planId),
    renderIncomingDetail(site, 'interview', `${count(platform.interviewInvited)} 条面试邀请`, rows.filter(item => item.interviewInvited), planId)
  ].join('');
}

function renderIncomingDetail(site, kind, label, rows, planId) {
  return `<details id="incoming-${escapeAttr(site)}-${kind}-details" class="feedback-incoming-details" hidden><summary>${escapeHtml(SITE_LABELS[site] || site)}：${escapeHtml(label)}</summary>
    ${rows.length ? `<ul>${rows.map(item => renderIncomingItem(item, planId)).join('')}</ul>` : '<p>暂未保存可核对的会话。</p>'}
  </details>`;
}

function renderIncomingItem(item, planId) {
  const destination = `/messages?planId=${encodeURIComponent(planId)}&source=${encodeURIComponent(item.platform)}&contact=${encodeURIComponent(item.key)}&task=all`;
  const labels = [item.resumeRequested ? '索要简历' : '', item.interviewInvited ? '面试邀请' : ''].filter(Boolean);
  const message = (item.inboundMessages || []).map(entry => entry?.text).filter(Boolean).join(' / ');
  const title = item.title || '未关联岗位';
  return `<li><strong>${escapeHtml(title)}</strong>${item.company ? ` · ${escapeHtml(item.company)}` : ''}
    ${labels.length ? ` <span>${escapeHtml(labels.join('、'))}</span>` : ''}
    ${message ? `<p>${escapeHtml(message)}</p>` : '<p>已保存可靠分类记录；原消息展示内容不可用。</p>'}
    <a href="${escapeAttr(destination)}">查看会话</a></li>`;
}

function renderAdjustment(planId, revisionId) {
  if (!revisionId) return '';
  return `<details class="feedback-adjustment"><summary>记录方案调整</summary>
    <p>已在招聘平台改好招呼语或投递方式？记下这次调整，之后就能查看效果变化。</p>
    <form method="post" action="/api/funnel/strategy-round" data-funnel-strategy-form>
      <input type="hidden" name="planId" value="${escapeAttr(planId)}"><input type="hidden" name="fromRoundId" value="${escapeAttr(revisionId)}">
      <div class="feedback-field"><label for="feedback-platform">调整的平台</label><select id="feedback-platform" name="platformScope"><option value="all">BOSS 和智联</option><option value="boss">仅 BOSS</option><option value="zhaopin">仅智联</option></select></div>
      <fieldset><legend>调整了什么？</legend><label><input type="checkbox" name="changeKinds" value="greeting"> 招呼语</label><label><input type="checkbox" name="changeKinds" value="strategy"> 求职方向或投递方式</label></fieldset>
      <label>调整说明（可选）<textarea name="changeNote" maxlength="300" rows="2" placeholder="例如：招呼语增加相关项目经历"></textarea></label>
      <button type="submit">保存调整记录</button><p class="alert" data-funnel-strategy-error role="alert"></p>
    </form></details>`;
}
function count(value) { return Math.max(0, Number(value) || 0); }
function percent(numerator, denominator) {
  return denominator ? `${Number((100 * numerator / denominator).toFixed(1))}%` : '—';
}
function localDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' }).format(date) : '';
}
const FUNNEL_STRATEGY_SCRIPT = `<script>(()=>{const form=document.querySelector('[data-funnel-strategy-form]');const showIncoming=(id)=>{for(const detail of document.querySelectorAll('.feedback-incoming-details')){detail.hidden=detail.id!==id;detail.open=detail.id===id;}document.getElementById(id)?.scrollIntoView({block:'nearest'});};for(const link of document.querySelectorAll('.feedback-incoming a[href^="#incoming-"]'))link.addEventListener('click',(event)=>{event.preventDefault();showIncoming(link.getAttribute('href').slice(1));});if(!form)return;const choices=Array.from(form.querySelectorAll('input[name="changeKinds"]'));const error=form.querySelector('[data-funnel-strategy-error]');const clear=()=>{if(choices[0])choices[0].setCustomValidity('');if(error)error.textContent='';};for(const choice of choices)choice.addEventListener('change',clear);form.addEventListener('submit',(event)=>{clear();if(choices.some((choice)=>choice.checked))return;event.preventDefault();const message='请选择本次调整的内容。';if(error)error.textContent=message;if(choices[0]){choices[0].setCustomValidity(message);choices[0].reportValidity();}});})();</script>`;
module.exports = { renderFunnelPage, FUNNEL_STRATEGY_SCRIPT };

const { escapeHtml, escapeAttr } = require("../http/response");
const { renderDashboardFrame } = require("../ui/shell");

function renderMockInterviewPage({ dashboard = {}, modelReady = true } = {}) {
  const plan = dashboard.plan || {};
  const planId = Number(plan.id || 0);
  const selected = dashboard.selectedSession || null;
  const currentPath = `/interview?planId=${encodeURIComponent(planId)}${selected ? `&sessionId=${encodeURIComponent(selected.id)}` : ""}`;
  const todayPath = `/plan?planId=${encodeURIComponent(planId)}`;
  return renderDashboardFrame({
    currentPath,
    todayPath,
    planId,
    stage: "模拟面试",
    brandHref: todayPath,
    content: `<main id="main-content" class="interview-main">
      <section class="page-heading interview-heading" aria-labelledby="interview-title">
        <h1 id="interview-title">模拟面试训练</h1>
        <p class="lede">围绕简历练习，也可以选一个岗位。每题答完后看反馈，练完一轮再挑需要改进的题目重练。</p>
        <div class="heading-meta"><span>${escapeHtml(plan.name || "当前筛选方案")}</span><span>文字练习</span><span>记录保存在本机</span></div>
      </section>
      ${selected ? `<details class="interview-new-session"><summary>开始另一轮训练</summary>${renderStartPanel(dashboard, modelReady)}</details>` : renderStartPanel(dashboard, modelReady)}
      ${selected ? renderSession(dashboard, selected) : renderEmptyState()}
    </main><p class="footer-note">练习和记录保存在本机，不会发送给招聘方。回答中的经历需要你确认后，才会用于后续求职。</p>`
  });
}

function renderStartPanel(dashboard, modelReady) {
  const plan = dashboard.plan || {};
  const resumes = (dashboard.resumes || []).filter((resume) => resume.isActive);
  const jobs = dashboard.jobs || [];
  const activeResume = resumes.find((resume) => resume.isActive) || resumes[0] || null;
  return `<section class="card pad interview-start" aria-labelledby="interview-start-title">
    <div class="interview-section-head"><div><p class="section-label">开始一轮训练</p><h2 id="interview-start-title">选好简历，开始练习</h2></div><span class="status ${modelReady ? "good" : "waiting"}">${modelReady ? "深度分析可用" : "模型待配置"}</span></div>
    ${modelReady ? "" : '<p class="alert">当前深度分析模型不可用。<a href="/settings">前往模型设置</a>完成连接后再开始。</p>'}
    <form class="interview-start-form" method="post" action="/api/interview/start" data-interview-submit data-interview-success-target="interview-active-step">
      <input type="hidden" name="planId" value="${escapeAttr(plan.id || "")}">
      <fieldset class="interview-mode-picker"><legend>训练范围</legend>
        <label><input type="radio" name="sessionKind" value="resume_general" checked><span><strong>简历通用面试</strong><small>从简历中的真实经历开始练习，不需要先收到面试邀请。</small></span></label>
        <label><input type="radio" name="sessionKind" value="job_specific"${jobs.length ? "" : " disabled"}><span><strong>岗位专项面试</strong><small>${jobs.length ? "选一个岗位，结合它的要求练习可能被问到的问题。" : "还没有资料完整的岗位，可以先练简历通用面试。"}</small></span></label>
      </fieldset>
      <div class="interview-job-panel" data-interview-job-panel hidden><label>目标岗位<select name="jobId" disabled>${jobs.map((job) => `<option value="${escapeAttr(job.id)}">${escapeHtml(job.title || "未命名岗位")} · ${escapeHtml(job.company || "公司未记录")}</option>`).join("")}</select></label></div>
      <label>简历版本<select name="resumeVersionId" required>${resumes.map((resume) => `<option value="${escapeAttr(resume.id)}"${activeResume?.id === resume.id ? " selected" : ""}>${escapeHtml(resume.name || "简历版本")}${activeResume?.id === resume.id ? " · 默认参考" : ""}</option>`).join("")}</select><small>默认参考最近更新的可用版本，也可以另选。本轮只使用你选的这份简历。</small></label>
      <label>题目侧重<select name="type"><option value="mixed">综合面试</option><option value="technical">技术 / 业务</option><option value="behavioral">行为问题</option><option value="general">自我介绍与沟通</option></select></label>
      <label>难度<select name="difficulty"><option value="standard">标准</option><option value="warmup">热身</option><option value="challenging">高压追问</option></select></label>
      <label>计划题数<select name="plannedQuestions"><option value="3">3 题 · 快速练习</option><option value="5" selected>5 题 · 推荐</option><option value="8">8 题 · 完整练习</option><option value="12">12 题 · 深入练习</option></select></label>
      <div class="button-row"><button${!modelReady || !resumes.length ? " disabled" : ""}>开始模拟面试</button><span class="hint">本轮参考所选简历；之后更新简历，不会改变这轮题目使用的资料。</span></div>
      <div class="alert" data-interview-error role="alert" style="grid-column:1/-1"></div>
    </form>
  </section>`;
}

function renderEmptyState() {
  return `<section class="card pad interview-empty"><p class="section-label">还没有训练记录</p><h2>先从上方开始一轮</h2><p>通用训练的首题会直接使用当前简历；后续会结合回答继续追问或切换到其他重要主题。</p></section>`;
}

function renderSession(dashboard, session) {
  const completed = session.status === "completed";
  const general = sessionKind(session) === "resume_general";
  const title = general ? "简历通用面试" : session.context?.job?.title || "岗位专项面试";
  const subtitle = general
    ? `基于 ${session.context?.resume?.name || `简历版本 ${session.resumeVersionId}`} 的通用训练`
    : session.context?.job?.company || "公司未记录";
  const transcript = renderTranscript(dashboard, session);
  const history = renderHistory(dashboard, session);
  const pastAnswers = transcript && !completed
    ? `<details class="interview-past-answers"><summary>查看已答题目和即时复盘</summary>${transcript}</details>`
    : transcript;
  const pastSessions = history
    ? `<details class="interview-past-sessions"><summary>查看历史训练</summary>${history}</details>`
    : history;
  return `<section class="interview-workspace interview-workbench" aria-labelledby="interview-session-title">
    <div class="interview-session-head"><div><p class="section-label">${completed ? "本轮训练已完成" : "训练进行中"}</p><h2 id="interview-session-title">${escapeHtml(title)}</h2><p>${escapeHtml(subtitle)}</p></div><span class="status ${completed ? "good" : "waiting"}">${completed ? "可复盘和重练" : `第 ${(session.turns || []).length} / ${escapeHtml(session.settings?.plannedQuestions || "-")} 题`}</span></div>
    ${renderBinding(session)}
    ${completed ? renderReport(session) : renderCurrentQuestion(dashboard, session)}
    ${pastAnswers}
    ${renderEvidencePanel(dashboard, session)}
    ${pastSessions}
  </section>`;
}

function renderLatestFeedback(session) {
  const last = [...(session.turns || [])].reverse().find(turn => turn.answerText && turn.answerReview);
  if (!last) return "";
  const review = last.answerReview;
  return `<aside class="card pad interview-latest-feedback" aria-label="上一题反馈"><strong>第 ${escapeHtml(last.turnNumber)} 题答后反馈</strong><p>${escapeHtml(review.conclusion || "")}</p>${review.improvements?.length ? `<p>下次试试：${escapeHtml(review.improvements[0])}</p>` : ""}</aside>`;
}

function renderBinding(session) {
  const general = sessionKind(session) === "resume_general";
  const scope = general
    ? "通用训练 · 不绑定岗位"
    : `${session.context?.job?.title || "岗位"} · ${session.context?.job?.company || "公司未记录"}`;
  return `<dl class="interview-binding"><div><dt>${general ? "训练范围" : "本轮参考岗位"}</dt><dd>${escapeHtml(scope)}</dd></div><div><dt>本轮参考简历</dt><dd>${escapeHtml(session.context?.resume?.name || `简历版本 ${session.resumeVersionId}`)}</dd></div><div><dt>训练设置</dt><dd>${escapeHtml(`${typeLabel(session.settings?.type)} · ${difficultyLabel(session.settings?.difficulty)} · ${session.settings?.plannedQuestions || "-"} 题`)}</dd></div></dl>`;
}

function renderCurrentQuestion(dashboard, session) {
  const turns = session.turns || [];
  const current = turns[turns.length - 1];
  const planId = dashboard.plan?.id || "";
  if (!current) return `<section class="card pad alert"><strong>首题尚未生成</strong><p>请从历史训练重新打开，本轮记录已保留。</p></section>`;
  if (current.answerText) {
    const canFinish = turns.length >= Number(session.settings?.plannedQuestions || 0);
    return canFinish ? `<section id="interview-active-step" class="card pad interview-finish">${renderLatestFeedback(session)}<p class="section-label">题目已完成</p><h3>生成本轮复盘</h3><p>复盘会引用具体题号，不会把训练分数包装成录用概率。</p><form method="post" action="/api/interview/finish" data-interview-submit data-interview-success-target="interview-report-title"><input type="hidden" name="planId" value="${escapeAttr(planId)}"><input type="hidden" name="sessionId" value="${escapeAttr(session.id)}"><button>结束并生成复盘</button><div class="alert" data-interview-error role="alert" style="grid-column:1/-1"></div></form></section>` : "";
  }
  return `<section id="interview-active-step" class="interview-current interview-current-question" aria-labelledby="interview-current-question">
    ${renderLatestFeedback(session)}
    <div class="interview-question-number">Q${escapeHtml(current.turnNumber)}</div>
    <div><p class="section-label">当前问题 · ${escapeHtml(focusLabel(current.questionFocus))}</p><h3 id="interview-current-question">${escapeHtml(current.questionText)}</h3>${renderQuestionEvidence(session, current)}${current.basedOnTurnNumber ? `<p class="interview-followup">这是一道承接第 ${escapeHtml(current.basedOnTurnNumber)} 题回答的追问。</p>` : ""}
      <form method="post" action="/api/interview/answer" data-interview-submit data-interview-draft="answer" data-interview-success-target="interview-active-step"><input type="hidden" name="planId" value="${escapeAttr(planId)}"><input type="hidden" name="sessionId" value="${escapeAttr(session.id)}"><input type="hidden" name="turnNumber" value="${escapeAttr(current.turnNumber)}"><label>我的回答<textarea name="answerText" rows="8" maxlength="20000" required autofocus></textarea><small>按真实经历作答。提交后会直接保存并生成下一题，不会再二次确认。</small></label><button>提交回答并继续</button><div class="alert" data-interview-error role="alert" style="grid-column:1/-1"></div></form>
    </div>
  </section>`;
}

function renderReport(session) {
  const report = session.report || {};
  return `<section class="interview-report" aria-labelledby="interview-report-title">
    <div class="interview-report-lead"><p class="section-label">这次整体怎么样</p><h3 id="interview-report-title">本轮训练复盘</h3><p class="interview-report-conclusion">${escapeHtml(report.conclusion || "本轮复盘已生成")}</p><p>以下建议用于练习，不代表录用结果。</p></div>
    <div class="interview-report-grid"><section><h4>这次答得好的地方</h4>${renderTextList(report.strengths)}</section><section><h4>下次可以改进</h4>${renderTextList(report.improvements)}</section></div>
    <section class="interview-report-practice" aria-labelledby="interview-practice-title"><h4 id="interview-practice-title">建议先练这些题</h4><p>选一道题，按提示再讲一次。原回答会保留，方便比较。</p>${report.retryRecommendations?.length ? renderTurnReasons(report.retryRecommendations, true) : '<p class="muted">这轮没有单独建议重练的题目，可以回看下面的逐题反馈。</p>'}</section>
    <div class="interview-report-details">
      <details class="interview-report-disclosure"><summary>还可能被追问什么</summary><div>${renderTurnReasons(report.followUpRisks)}</div></details>
      <details class="interview-report-disclosure"><summary>项目经历怎样讲清楚</summary><div><p>先说项目解决什么问题，再说你负责什么、怎么做，以及实际结果。技术名词放在具体做法里解释。</p>${renderStructures(report.answerStructures)}</div></details>
    </div>
  </section>`;
}

function renderTranscript(dashboard, session) {
  const turns = (session.turns || []).filter((turn) => turn.answerText);
  const planId = dashboard.plan?.id || "";
  if (!turns.length) return "";
  return `<section class="interview-transcript" aria-labelledby="interview-transcript-title"><div class="interview-section-head"><div><p class="section-label">逐题记录</p><h3 id="interview-transcript-title">回看回答，选择一题重练</h3></div><span>${turns.length} 题已答</span></div><div class="interview-turn-list">${turns.map((turn) => `<article id="interview-turn-${escapeAttr(turn.turnNumber)}" class="interview-turn"><header><span>Q${escapeHtml(turn.turnNumber)}</span><div><h4>${escapeHtml(turn.questionText)}</h4></div></header>${session.status === "completed" ? `<details class="interview-turn-detail"><summary>查看回答、反馈或重练</summary>` : ""}<div class="interview-question-focus"><strong>这题在问什么</strong><p>${escapeHtml(focusLabel(turn.questionFocus))}</p></div>${renderQuestionEvidence(session, turn, session.status === "completed")}<div class="interview-answer"><strong>你当时的回答</strong><p>${escapeHtml(turn.answerText)}</p></div>${renderAnswerReview(turn.answerReview)}${renderRetries(turn.retries)}${session.status === "completed" ? `<form class="interview-retry-form" method="post" action="/api/interview/retry" data-interview-submit data-interview-draft="retry" data-interview-success-target="interview-turn-${escapeAttr(turn.turnNumber)}"><input type="hidden" name="planId" value="${escapeAttr(planId)}"><input type="hidden" name="sessionId" value="${escapeAttr(session.id)}"><input type="hidden" name="turnNumber" value="${escapeAttr(turn.turnNumber)}"><label>重答这题<textarea name="answerText" rows="5" maxlength="20000" required></textarea><small>新回答和原回答都会保留，方便比较。</small></label><button class="secondary">保存重答并比较</button><div class="alert" data-interview-error role="alert" style="grid-column:1/-1"></div></form>` : ""}${session.status === "completed" ? "</details>" : ""}</article>`).join("")}</div></section>`;
}

function renderEvidencePanel(dashboard, session) {
  const candidates = session.report?.evidenceCandidates || [];
  const saved = (dashboard.candidateEvidence || []).filter(item => item.sourceKind === 'interview_turn' && item.sourceId === String(session.id));
  const turns = (session.turns || []).filter(turn => turn.answerText);
  if (!turns.length) return '';
  const form = (item, retryId = null) => `<form class="form-stack" method="post" action="/api/interview/evidence" data-interview-submit data-interview-success-target="interview-evidence"><input type="hidden" name="planId" value="${escapeAttr(dashboard.plan.id)}"><input type="hidden" name="sessionId" value="${session.id}"><input type="hidden" name="turnNumber" value="${item.turnNumber}">${retryId ? `<input type="hidden" name="retryId" value="${retryId}">` : ''}<label>原回答中的片段<textarea name="sourceQuote" maxlength="20000" rows="3" required>${escapeHtml(item.sourceQuote)}</textarea></label><p>这里保留回答中的连续原话，只选实际做过或正在做的部分。下面可以整理说法。</p><label>这段经历的标题<input name="subject" maxlength="160" value="${escapeAttr(item.subject)}" required></label><label>整理后的真实经历<textarea name="text" maxlength="8000" rows="4" required>${escapeHtml(item.text)}</textarea></label><button>确认并保存这段经历</button><div class="alert" data-interview-error role="alert" style="grid-column:1/-1"></div></form>`;
  return `<details class="card interview-evidence-panel" id="interview-evidence"><summary>保存这次提到的真实经历</summary><div class="interview-evidence-content"><p>有想留给以后用的经历，可以在这里核对并保存。确认后，回复招聘方、改简历和练面试时都能参考；假设和练习示范不要保存为真实经历。</p>${saved.length ? `<p class="status good">已保存 ${saved.length} 条经历。<a href="/communication-profile?profileId=${session.profileId}">查看、修改或停止使用</a></p>` : ''}${candidates.map(item => `<article class="interview-evidence-item"><h4>第 ${item.turnNumber} 题 · ${escapeHtml(item.subject || '项目经历')}</h4>${form(item)}</article>`).join('')}<details><summary>从其他回答中保存经历</summary>${turns.map(turn => `<details><summary>第 ${turn.turnNumber} 题：${escapeHtml(turn.questionText)}</summary>${form({ turnNumber: turn.turnNumber, subject: turn.questionFocus || '我的项目经历', sourceQuote: turn.answerText.slice(0, 8000), text: turn.answerText.slice(0, 8000) })}${turn.retries.map(retry => `<details><summary>保存第 ${retry.retryIndex} 次重答中的经历</summary>${form({ turnNumber: turn.turnNumber, subject: turn.questionFocus || '我的项目经历', sourceQuote: retry.answerText.slice(0, 8000), text: retry.answerText.slice(0, 8000) }, retry.id)}</details>`).join('')}</details>`).join('')}</details></div></details>`;
}

function renderAnswerReview(review) {
  if (!review) return "";
  return `<div class="interview-turn-review"><strong>这题的反馈</strong><p>${escapeHtml(review.conclusion || "")}</p><div><span>做得好的地方</span>${renderTextList(review.strengths)}</div><div><span>下次可以改进</span>${renderTextList(review.improvements)}</div></div>`;
}

function renderRetries(retries = []) {
  if (!retries.length) return "";
  return `<div class="interview-retries"><strong>重答对比</strong>${retries.map((retry) => `<section><span>第 ${escapeHtml(retry.retryIndex)} 次重答</span><p>${escapeHtml(retry.answerText)}</p><small>${escapeHtml(retry.review?.conclusion || "已保存重答")}</small>${retry.review?.strengths?.length ? `<strong>这次答得好的地方</strong>${renderTextList(retry.review.strengths)}` : ""}${retry.review?.remainingImprovements?.length ? `<strong>还可以改进</strong>${renderTextList(retry.review.remainingImprovements)}` : ""}</section>`).join("")}</div>`;
}

function renderQuestionEvidence(session, turn, collapsed = false) {
  const catalog = new Map((session.context?.resumeEvidenceCatalog || [])
    .map((item) => [String(item?.id || ""), item]));
  const evidence = (turn.resumeEvidenceIds || []).map((id) => catalog.get(String(id))).filter(Boolean);
  if (!evidence.length) return "";
  const content = `<div class="interview-question-evidence"><strong>简历中的相关经历</strong><ul>${evidence.map((item) => `<li>${escapeHtml(compactEvidence(item.text))}</li>`).join("")}</ul></div>`;
  return collapsed ? `<details class="interview-question-source"><summary>查看这题参考的项目经历</summary>${content}</details>` : content;
}

function compactEvidence(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > 360 ? `${text.slice(0, 357)}…` : text;
}

function sessionKind(session) {
  return session.sessionKind || session.context?.sessionKind || "job_specific";
}

function renderHistory(dashboard, selected) {
  const planId = dashboard.plan?.id || "";
  const history = (dashboard.sessions || []).filter((session) => Number(session.id) !== Number(selected.id));
  if (!history.length) return "";
  return `<section class="card pad interview-history"><p class="section-label">历史训练</p><h3>继续或复盘以前的会话</h3><ul>${history.map((session) => `<li><a href="/interview?planId=${escapeAttr(planId)}&amp;sessionId=${escapeAttr(session.id)}">${escapeHtml(sessionKind(session) === "resume_general" ? "简历通用面试" : session.context?.job?.title || `岗位专项面试 ${session.id}`)}</a><span>${session.status === "completed" ? "已完成" : "进行中"}</span></li>`).join("")}</ul></section>`;
}

function renderTextList(items = []) {
  return items.length ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : '<p class="muted">本轮没有单独记录</p>';
}

function renderTurnReasons(items = [], retry = false) {
  return items.length ? `<ul>${items.map((item) => `<li><strong>第 ${escapeHtml(item.turnNumber)} 题</strong><span>${escapeHtml(item.reason)}</span>${retry ? `<a href="#interview-turn-${escapeAttr(item.turnNumber)}" data-interview-retry-link>重练这题</a>` : ""}</li>`).join("")}</ul>` : '<p class="muted">本轮没有单独记录</p>';
}

function renderStructures(items = []) {
  return items.length ? `<ul>${items.map((item) => `<li><details class="interview-answer-structure"><summary>第 ${escapeHtml(item.turnNumber)} 题：查看详细重答提纲</summary>${renderTextList(item.outline || [])}</details></li>`).join("")}</ul>` : '<p class="muted">本轮没有单独记录</p>';
}

function typeLabel(value) {
  return { mixed: "综合面试", technical: "技术 / 业务", behavioral: "行为问题", general: "自我介绍与沟通" }[value] || "综合面试";
}

function difficultyLabel(value) {
  return { warmup: "热身", standard: "标准", challenging: "高压追问" }[value] || "标准";
}

function focusLabel(value) {
  return { general: "求职方向与沟通", contribution: "个人贡献", intro: "自我介绍", motivation: "岗位动机", project: "项目深挖", technical: "技术 / 业务", behavioral: "行为问题", pressure: "压力追问", questions: "反问" }[value] || value || "岗位问题";
}

const MOCK_INTERVIEW_SCRIPT = `<script>(()=>{const reveal=()=>{const target=location.hash&&document.getElementById(location.hash.slice(1));if(target){let parent=target.closest?.('details');while(parent){parent.open=true;parent=parent.parentElement?.closest('details');}const detail=target.querySelector?.('.interview-turn-detail');if(detail)detail.open=true;setTimeout(()=>target.scrollIntoView({block:'start'}),0);}};if(document.readyState==='complete')reveal();else addEventListener('load',reveal,{once:true});for(const link of document.querySelectorAll('[data-interview-retry-link]'))link.addEventListener('click',()=>{const turn=document.getElementById(link.getAttribute('href').slice(1));const field=turn?.querySelector('textarea[name="answerText"]');let detail=field?.closest('details');while(detail){detail.open=true;detail=detail.parentElement?.closest('details');}setTimeout(()=>field?.focus({preventScroll:true}),0);});const start=document.querySelector('.interview-start-form');if(start){const panel=start.querySelector('[data-interview-job-panel]');const job=panel&&panel.querySelector('select[name="jobId"]');const sync=()=>{const selected=start.querySelector('input[name="sessionKind"]:checked');const specific=selected&&selected.value==='job_specific';if(panel)panel.hidden=!specific;if(job){job.disabled=!specific;job.required=!!specific;}};for(const radio of start.querySelectorAll('input[name="sessionKind"]'))radio.addEventListener('change',sync);sync();}const storage={get:(key)=>{try{return localStorage.getItem(key)}catch{return null}},set:(key,value)=>{try{localStorage.setItem(key,value)}catch{}},remove:(key)=>{try{localStorage.removeItem(key)}catch{}}};const navigate=(url,target)=>{const base=String(url||'').split('#')[0];const destination=base+(target?'#'+target:'');if(location.href.split('#')[0]===base){location.hash=target;location.reload();}else location.assign(destination);};for(const form of document.querySelectorAll('[data-interview-submit]')){const field=form.querySelector('textarea[name="answerText"]');const kind=form.dataset.interviewDraft||'';const sessionId=form.elements.sessionId?.value||'';const turnNumber=form.elements.turnNumber?.value||'';const key=field&&kind&&sessionId&&turnNumber?'roleflow:interview-draft:'+sessionId+':'+turnNumber+':'+kind:'';if(key&&!field.value){const saved=storage.get(key);if(saved!==null)field.value=saved;}if(key)field.addEventListener('input',()=>storage.set(key,field.value));form.addEventListener('submit',async(event)=>{event.preventDefault();const button=event.submitter||form.querySelector('button');if(button?.disabled)return;const label=button?.textContent||'';const error=form.querySelector('[data-interview-error]');if(error)error.textContent='';if(button){button.disabled=true;button.textContent=form.action.endsWith('/finish')?'正在生成复盘…':form.action.endsWith('/answer')?'正在分析回答…':form.action.endsWith('/retry')?'正在反馈这次回答…':form.action.endsWith('/evidence')?'正在保存经历…':'正在准备面试题…';}let operationKey='';try{const body=new URLSearchParams(new FormData(form));if(form.action.endsWith('/start')||form.action.endsWith('/retry')){operationKey='offergo:pending-generation:'+form.action+':'+body.toString();let operationId=storage.get(operationKey);if(operationId&&form.action.endsWith('/start')){const query=new URLSearchParams({planId:body.get('planId'),operationId});let statusResponse,statusPayload;try{statusResponse=await fetch('/api/interview/operation?'+query,{cache:'no-store'});statusPayload=JSON.parse(await statusResponse.text());}catch{throw new Error('暂时无法确认上次生成是否完成，请稍后重试。当前输入与操作编号仍保留。');}if(!statusResponse.ok||typeof statusPayload.saved!=='boolean')throw new Error('暂时无法确认上次生成是否完成，请稍后重试。当前输入与操作编号仍保留。');if(statusPayload.saved){storage.remove(operationKey);operationId=null;}}if(!operationId){operationId=typeof crypto!=='undefined'&&crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+Math.random().toString(36).slice(2);storage.set(operationKey,operationId);}body.set('operationId',operationId);}const response=await fetch(form.action,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body});if(!response.ok){const text=await response.text();let message='操作失败，请稍后重试。';let payload={};try{payload=JSON.parse(text);const code=payload.errorCode||payload.code||'';message=code==='MODEL_TIMEOUT'?'模型响应超时，本次生成未完成。请稍后重试，当前输入仍保留。':payload.error||message;}catch{}if(operationKey)storage.remove(operationKey);const failure=new Error(message);failure.requestId=payload.requestId;failure.code=payload.errorCode||payload.code;throw failure;}if(operationKey)storage.remove(operationKey);if(key)storage.remove(key);navigate(response.url||form.action,form.dataset.interviewSuccessTarget||'');}catch(failure){if(error){error.textContent=failure.message||'操作失败，请稍后重试。';if((failure.requestId||failure.code)&&typeof document.createElement==='function'){const details=document.createElement('details');const summary=document.createElement('summary');summary.textContent='排错信息';details.append(summary);const technical=document.createElement('p');technical.textContent=[failure.requestId?'排错编号：'+failure.requestId:'',failure.code?'错误代码：'+failure.code:''].filter(Boolean).join('；');details.append(technical);if(failure.requestId){const link=document.createElement('a');link.textContent='查看运行诊断';link.href='/diagnostics?requestId='+encodeURIComponent(failure.requestId);details.append(link);}error.append(details);}}if(button){button.disabled=false;button.textContent=label;}}});}})();</script>`;

module.exports = { renderMockInterviewPage, MOCK_INTERVIEW_SCRIPT };

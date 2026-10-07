const { escapeHtml, escapeAttr } = require("../http/response");
const { renderDashboardFrame } = require("../ui/shell");

const PRINCIPLE_LABELS = {
  relevance_order: "相关内容排序",
  contribution_clarity: "贡献边界清晰",
  result_visibility: "结果更易看见",
  jd_vocabulary: "岗位用词对齐",
  concision: "表达精简",
  structure: "结构调整"
};

const RESUME_INTEGRITY_MESSAGES = Object.freeze({
  RESUME_PLACEHOLDER_PRESENT: "简历里还有待补充的占位内容。",
  RESUME_CONTACT_REMOVED: "原简历中的姓名或联系方式被删除或改动。",
  RESUME_FACT_UNSUPPORTED: "简历新增了系统找不到依据的日期、数字或联系方式。",
  RESUME_TEXT_TOO_SHORT: "简历正文过短，请补充完整后再启用。",
  RESUME_GENERATED_BASELINE_CHANGED: "系统生成基线与修改记录不一致，请重新生成这份定向简历。",
  RESUME_NEARLY_UNCHANGED: "这份草稿与原简历非常接近，定向调整可能不明显。",
  RESUME_LENGTH_INCREASED: "篇幅比原简历明显增加，建议再精简。",
  RESUME_USER_EXTRA_EDIT: "当前全文包含你在系统优化后继续修改的内容。"
});

function renderResumeOptimizationPage({ dashboard = {}, modelReady = true } = {}) {
  const plan = dashboard.plan || {};
  const planId = Number(plan.id || 0);
  const selected = dashboard.selectedDraft || null;
  const currentPath = `/resume-optimization?planId=${encodeURIComponent(planId)}${selected ? `&draftId=${encodeURIComponent(selected.id)}` : ""}`;
  const todayPath = `/plan?planId=${encodeURIComponent(planId)}`;
  return renderDashboardFrame({
    currentPath,
    todayPath,
    planId,
    stage: "简历优化",
    brandHref: todayPath,
    content: `<main id="main-content" class="resume-opt-main">
      <section class="page-heading" aria-labelledby="resume-opt-title">
        <h1 id="resume-opt-title">简历优化</h1>
        <p class="lede">把经历写得清楚、好读，也可以针对你想投的岗位调整重点。OfferGo 会生成完整草稿，供你继续修改。</p>
        <div class="heading-meta"><span>${escapeHtml(plan.name || "当前筛选方案")}</span><span>原简历永不覆盖</span></div>
      </section>
      ${selected ? `<details class="resume-new-draft"><summary>生成另一个版本</summary>${renderCreatePanel(dashboard, modelReady)}</details>` : renderCreatePanel(dashboard, modelReady)}
      ${selected ? renderSelectedDraft(dashboard, selected) : renderEmptyState()}
    </main><p class="footer-note">本页只读写 OfferGo 本地数据；不会访问 BOSS、不会投递、不会填写或发送任何外部内容。</p>`
  });
}

function renderCreatePanel(dashboard, modelReady) {
  const plan = dashboard.plan || {};
  const resumes = dashboard.resumes || [];
  const jobs = dashboard.jobs || [];
  const activeResume = resumes.find((resume) => resume.isActive) || resumes[0] || null;
  const ready = modelReady && resumes.length > 0;
  return `<section class="card pad resume-opt-create" aria-labelledby="resume-opt-create-title">
    <div class="resume-opt-section-head"><div><p class="section-label">开始一次优化</p><h2 id="resume-opt-create-title">这次想怎么调整</h2></div><span class="status ${modelReady ? "good" : "waiting"}">${modelReady ? "深度分析可用" : "模型待配置"}</span></div>
    ${modelReady ? "" : '<p class="alert">当前深度分析模型不可用。<a href="/settings">前往模型设置</a>完成连接后再生成草稿。</p>'}
    <form class="resume-opt-create-form" method="post" action="/api/resume-optimization" data-resume-submit data-resume-success-target="resume-opt-draft-title">
      <input type="hidden" name="planId" value="${escapeAttr(plan.id || "")}">
      <label>参考简历<select name="sourceResumeVersionId" required>${resumes.map((resume) => `<option value="${escapeAttr(resume.id)}"${activeResume?.id === resume.id ? " selected" : ""}>${escapeHtml(resume.name || "简历版本")}${activeResume?.id === resume.id ? " · 默认参考" : resume.isActive ? " · 可用于匹配" : ""}</option>`).join("")}</select><small>默认参考最近更新的可用版本。这次优化只使用你选的简历。</small></label>
      <label>优化用途<select name="mode" data-resume-mode-picker><option value="general">整理我的简历</option><option value="job_specific"${jobs.length ? "" : " disabled"}>为这份岗位调整</option></select><small>先把工作内容、个人贡献和结果写清楚；选择岗位后，再突出与它相关的经历。</small></label>
      <div data-resume-job-panel hidden><label>想投的岗位<select name="jobId" disabled><option value="">请选择岗位</option>${jobs.map((job) => `<option value="${escapeAttr(job.id)}">${escapeHtml(job.title || "未命名岗位")} · ${escapeHtml(job.company || "公司未记录")}${job.platform ? ` · ${escapeHtml(job.platform === "boss" ? "BOSS" : job.platform === "zhaopin" ? "智联" : job.platform)}` : ""}</option>`).join("")}</select><small>只参考你选的这份岗位，不混入其他岗位的要求。</small></label></div>
      ${jobs.length ? "" : '<p class="muted resume-opt-create-note">现在可以直接整理简历。发现完整岗位后，也可以为某一份岗位调整。</p>'}
      <div class="button-row"><button data-resume-create-ready="${ready}"${ready ? "" : " disabled"}>生成完整草稿</button><span class="hint">生成后可以编辑全文，再启用为新的简历版本。</span></div>
      <div class="alert" data-resume-error role="alert" style="grid-column:1/-1"></div>
    </form>
  </section>${RESUME_SAMPLE_PREVIEW_SCRIPT}`;
}

const RESUME_SAMPLE_PREVIEW_SCRIPT = `<script>(()=>{const picker=document.querySelector('[data-resume-mode-picker]');if(!picker)return;const form=picker.form;const panel=form.querySelector('[data-resume-job-panel]');const job=form.querySelector('select[name="jobId"]');const button=form.querySelector('[data-resume-create-ready]');const update=()=>{const specific=picker.value==='job_specific';panel.hidden=!specific;job.disabled=!specific;job.required=specific;button.disabled=button.dataset.resumeCreateReady!=='true'||(specific&&!job.value);};picker.addEventListener('change',update);job.addEventListener('change',update);update();})();</script>`;

function renderEmptyState() {
  return `<section class="card pad resume-opt-empty"><p class="section-label">尚未生成草稿</p><h2>先选择想调整的简历</h2><p>OfferGo 会生成一份完整版本，你可以直接在全文上继续修改，不需要逐条确认建议。</p></section>`;
}

function renderSelectedDraft(dashboard, draft) {
  const evidence = new Map((draft.evidenceCatalog || []).map((item) => [String(item.id), item]));
  const resume = (dashboard.resumes || []).find((item) => Number(item.id) === Number(draft.sourceResumeVersionId));
  const jobs = dashboard.selectedJobs || [];
  const activated = draft.status === "activated";
  return `<section class="resume-opt-workspace resume-workbench" aria-labelledby="resume-opt-draft-title">
    <div class="resume-opt-conclusion"><div><p class="section-label">当前优化结论</p><h2 id="resume-opt-draft-title">${escapeHtml(draft.headline || "完整定向简历草稿")}</h2></div><span class="status ${activated ? "good" : "waiting"}">${activated ? "已启用新版本" : "可以继续编辑"}</span></div>
    <dl class="resume-opt-binding"><div><dt>参考简历</dt><dd>${escapeHtml(resume?.name || `简历版本 ${draft.sourceResumeVersionId}`)}</dd></div><div><dt>目标投递方向</dt><dd>${escapeHtml(draft.mode === "general" ? "通用整理" : draft.targetDirection || "历史草稿未记录")}</dd></div></dl>
    ${draft.draftFormat === "whole_draft" ? renderWholeDraft(dashboard, draft, evidence) : renderLegacyDraft(draft, evidence)}
    ${draft.mode === "general" ? "" : renderSelectedJobs(jobs, draft)}
    ${activated ? renderActivatedNotice(dashboard, draft) : ""}
    <details class="resume-opt-technical"><summary>技术详情</summary><p>生成模型：${escapeHtml([draft.modelIdentity?.provider, draft.modelIdentity?.model].filter(Boolean).join(" · ") || "本地记录")}</p></details>
    ${renderHistory(dashboard, draft)}
  </section>`;
}

function renderSelectedJobs(jobs, draft = {}) {
  return `<section class="card pad resume-opt-jobs" aria-labelledby="resume-opt-jobs-title"><p class="section-label">本次参考岗位</p><h2 id="resume-opt-jobs-title">${draft.mode === "job_specific" ? "你选择的岗位" : "系统自动选择的代表样本"}</h2><div class="resume-opt-selected-jobs">${jobs.length ? jobs.map((job) => `<article><strong>${escapeHtml(job.title || "未命名岗位")}</strong><span>${escapeHtml(job.company || "公司未记录")}</span></article>`).join("") : '<p class="muted">历史草稿的岗位记录仍保留在本地。</p>'}</div></section>`;
}

function renderWholeDraft(dashboard, draft, evidence) {
  const planId = dashboard.plan?.id || "";
  const activated = draft.status === "activated";
  return `<div class="resume-workbench-columns"><form class="card pad resume-opt-editor" method="post" action="/api/resume-optimization/save" data-resume-editor data-resume-submit data-resume-success-target="resume-opt-draft-title">
    <input type="hidden" name="planId" value="${escapeAttr(planId)}"><input type="hidden" name="draftId" value="${escapeAttr(draft.id)}"><input type="hidden" name="expectedRevision" value="${escapeAttr(draft.revision || '')}">
    <div class="resume-opt-section-head"><div><p class="section-label">完整简历草稿</p><h2>${draft.userEditedAt ? "用户已修改" : "系统生成版本"}</h2></div><button class="secondary" type="button" data-copy-resume>复制当前全文</button></div>
    <label class="resume-opt-full-editor" for="resume-opt-final-text">当前全文<textarea id="resume-opt-final-text" name="finalText" rows="22"${activated ? " readonly" : ""}>${escapeHtml(draft.finalText || draft.generatedText || "")}</textarea></label>
    <div class="button-row"><button class="secondary" type="submit" name="format" value="print" formaction="/api/resume-optimization/export" formtarget="_blank">打印 / 保存 PDF</button><button class="secondary" type="submit" name="format" value="text" formaction="/api/resume-optimization/export">下载文字版</button></div><p class="hint">导出当前全文。启用新版本后，OfferGo 会参考它；招聘平台上的简历附件仍需更新。</p>
    ${renderResumeIntegrity(dashboard.selectedIntegrity)}
    ${activated ? `<p class="notice">当前全文为已启用版本，只读保留。</p>` : `<p class="notice" data-resume-recovery hidden>另有一份未保存的本机修改。<button type="button" class="secondary" data-resume-restore>恢复这份修改</button></p><div class="notice" data-resume-conflict hidden><p>其他页面已更新这份简历，本页修改仍保留。请先复制当前全文，再查看最新内容并合并。</p><a href="/resume-optimization?planId=${escapeAttr(planId)}&amp;draftId=${escapeAttr(draft.id)}" target="_blank" rel="noopener">在新页面查看最新版本</a> <button type="button" class="secondary" data-resume-reload>重新载入最新版本</button></div><div class="resume-opt-savebar"><div data-resume-save-status aria-live="polite">修改后会自动保存。</div><div class="button-row"><button class="secondary" type="submit" data-resume-success-target="resume-opt-draft-title">保存草稿</button><button type="submit" formaction="/api/resume-optimization/activate" data-resume-success-target="resume-opt-activated">启用为新版本</button></div></div>`}
  </form>${renderChangeLedger(draft.changeLedger || draft.suggestions || [], evidence, Boolean(draft.userEditedAt))}</div>`;
}

function publicResumeIntegrityIssues(integrity = {}) {
  integrity = integrity || {};
  const result = [];
  const seen = new Set();
  for (const [level, items] of [["error", integrity.errors], ["warning", integrity.warnings]]) {
    for (const item of Array.isArray(items) ? items : []) {
      const code = String(item?.code || "");
      if (!RESUME_INTEGRITY_MESSAGES[code] || seen.has(code)) continue;
      seen.add(code);
      result.push({ code, message: RESUME_INTEGRITY_MESSAGES[code], level });
    }
  }
  return result;
}

function renderResumeIntegrity(integrity) {
  const issues = publicResumeIntegrityIssues(integrity);
  const state = issues.some((item) => item.level === "error") ? "error" : "warning";
  return `<div class="resume-opt-integrity" data-resume-integrity data-state="${state}" aria-live="polite"${issues.length ? "" : " hidden"}>${issues.length ? `<ul>${issues.map((item) => `<li>${escapeHtml(item.message)}</li>`).join("")}</ul>` : ""}</div>`;
}

function renderChangeLedger(changes, evidence, userEdited) {
  return `<section class="card pad resume-opt-ledger resume-change-ledger" aria-labelledby="resume-opt-ledger-title"><p class="section-label">修改了什么</p><h2 id="resume-opt-ledger-title">这份草稿的修改说明</h2>${userEdited ? '<p class="hint">你后续对全文的修改以当前文字为准；下方说明只对应系统最初生成的版本。</p>' : ""}<div class="resume-opt-list">${changes.map((change, index) => renderLedgerItem(change, index, evidence)).join("")}</div></section>`;
}

function renderLedgerItem(change, index, evidence) {
  const cited = (change.evidenceIds || []).map((id) => evidence.get(String(id))).filter(Boolean);
  return `<article class="resume-opt-ledger-item"><div class="resume-opt-index" aria-hidden="true">${index + 1}</div><div><div class="resume-opt-ledger-head"><span>${escapeHtml(PRINCIPLE_LABELS[change.editingPrinciple] || "结构化修改")}</span><strong>${escapeHtml(change.reason || "让相关经历更清楚")}</strong></div><div class="resume-opt-compare"><div><span>原文</span><p>${escapeHtml(change.originalText || "")}</p></div><div><span>系统生成</span><p>${escapeHtml(change.proposedText || "删除这段文字")}</p></div></div><details><summary>查看 ${cited.length} 条依据</summary><ul>${cited.map((item) => `<li><strong>${escapeHtml(item.id)}</strong><span>${escapeHtml(item.text)}</span></li>`).join("")}</ul></details></div></article>`;
}

function renderLegacyDraft(draft, evidence) {
  return `<section class="card pad resume-opt-legacy"><p class="section-label">历史逐条建议</p><h2>旧版草稿只读保留</h2><p class="hint">这份记录来自旧流程，不再要求逐条接受或忽略。</p>${renderChangeLedger(draft.changeLedger || draft.suggestions || [], evidence, false)}${draft.finalText ? `<label class="resume-opt-full-editor">历史最终文字<textarea readonly rows="18">${escapeHtml(draft.finalText)}</textarea></label>` : ""}</section>`;
}

function renderActivatedNotice(dashboard, draft) {
  return `<section id="resume-opt-activated" class="alert good"><strong>这份草稿已经启用</strong><p>已保存为可用于求职的新版本。还想修改时，可以继续编辑一份副本，原版本保留。</p>${draft.draftFormat === 'whole_draft' ? `<form method="post" action="/api/resume-optimization/copy" data-resume-submit data-resume-success-target="resume-opt-draft-title"><input type="hidden" name="planId" value="${escapeAttr(dashboard.plan?.id || draft.planId)}"><input type="hidden" name="draftId" value="${escapeAttr(draft.id)}"><button class="secondary">以此版本继续编辑</button><div data-resume-error role="alert" style="grid-column:1/-1"></div></form>` : ''}<a href="/resumes?profileId=${escapeAttr(dashboard.profile?.id || draft.profileId)}">查看全部简历版本</a></section>`;
}

function renderHistory(dashboard, selected) {
  const planId = dashboard.plan?.id || "";
  const history = (dashboard.drafts || []).filter((draft) => Number(draft.id) !== Number(selected.id));
  if (!history.length) return "";
  return `<section class="card pad resume-opt-history"><p class="section-label">历史草稿</p><h2>保留每次源材料与处理结果</h2><ul>${history.map((draft) => `<li><a href="/resume-optimization?planId=${escapeAttr(planId)}&amp;draftId=${escapeAttr(draft.id)}">${escapeHtml(draft.headline || `定向简历草稿 ${draft.id}`)}</a><span>${draft.status === "activated" ? "已启用" : "草稿"}</span></li>`).join("")}</ul></section>`;
}

const RESUME_OPTIMIZATION_SCRIPT = `<script>(()=>{
const issueMessages=${JSON.stringify(RESUME_INTEGRITY_MESSAGES)};
const reveal=()=>{const target=location.hash&&document.getElementById(location.hash.slice(1));if(target)setTimeout(()=>target.scrollIntoView({block:'start'}),0);};
if(document.readyState==='complete')reveal();else addEventListener('load',reveal,{once:true});
const form=document.querySelector('[data-resume-editor]');
const editor=document.getElementById('resume-opt-final-text');
const editable=!!(form&&editor&&!editor.readOnly);
const copy=document.querySelector('[data-copy-resume]');
if(copy&&editor)copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(editor.value);copy.textContent='已复制';}catch{copy.textContent='复制失败';}});
const status=form?.querySelector('[data-resume-save-status]');
const integrity=document.querySelector('[data-resume-integrity]');
const planId=form?.elements.planId?.value||'';
const draftId=form?.elements.draftId?.value||'';
const backupKey='offergo:resume-draft:'+planId+':'+draftId;
let timer=0,chain=Promise.resolve(),version=0,savedText=editor?.value||'',savedRevision=form?.elements.expectedRevision?.value||'',conflicted=false;
const setStatus=text=>{if(status)status.textContent=text;};
const failureFrom=payload=>{const code=payload.errorCode||payload.code||'';const reason=code==='MODEL_TIMEOUT'?'模型响应超时，本次生成未完成。请稍后重试，当前输入仍保留。':payload.error||'操作失败，请稍后重试。';const failure=new Error(reason);failure.code=code;failure.requestId=payload.requestId;failure.issues=payload.issues;return failure;};
const displayFailure=(target,failure)=>{if(!target)return;target.textContent=failure.message||'操作失败，请稍后重试。';if((failure.requestId||failure.code)&&typeof document.createElement==='function'){const details=document.createElement('details');const summary=document.createElement('summary');summary.textContent='排错信息';details.append(summary);const technical=document.createElement('p');technical.textContent=[failure.requestId?'排错编号：'+failure.requestId:'',failure.code?'错误代码：'+failure.code:''].filter(Boolean).join('；');details.append(technical);if(failure.requestId){const link=document.createElement('a');link.textContent='查看运行诊断';link.href='/diagnostics?requestId='+encodeURIComponent(failure.requestId);details.append(link);}target.append(details);}};
const showConflict=()=>{conflicted=true;clearTimeout(timer);const notice=form?.querySelector('[data-resume-conflict]');if(notice)notice.hidden=false;remember();};
const remember=(reset=false)=>{if(!editable)return;try{if(editor.value===savedText){const backup=JSON.parse(localStorage.getItem(backupKey)||'null');if(backup?.text===savedText||(reset===true&&backup?.baseText===savedText))localStorage.removeItem(backupKey);}else localStorage.setItem(backupKey,JSON.stringify({baseText:savedText,text:editor.value}));}catch{}};
const updateIntegrity=(value={})=>{if(!integrity)return;const errors=Array.isArray(value.errors)?value.errors:[];const warnings=Array.isArray(value.warnings)?value.warnings:[];const seen=new Set();const messages=[];for(const item of [...errors,...warnings]){const code=String(item?.code||'');if(issueMessages[code]&&!seen.has(code)){seen.add(code);messages.push(issueMessages[code]);}}integrity.hidden=!messages.length;integrity.dataset.state=errors.some(item=>issueMessages[String(item?.code||'')])?'error':'warning';integrity.innerHTML=messages.length?'<ul>'+messages.map(message=>'<li>'+message+'</li>').join('')+'</ul>':'';};
const readPayload=async response=>{const text=await response.text();try{return JSON.parse(text)}catch{return {};}};
const enqueue=(text,revision)=>{chain=chain.then(async()=>{
  if(conflicted)return false;
  setStatus('正在保存…');
  const response=await fetch('/api/resume-optimization/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({planId,draftId,finalText:text,...(savedRevision?{expectedRevision:savedRevision}:{baseText:savedText})})});
  const payload=await readPayload(response);if(!response.ok)throw failureFrom(payload);
  savedText=text;savedRevision=payload.revision||'';if(form?.elements.expectedRevision)form.elements.expectedRevision.value=savedRevision;remember();updateIntegrity(payload.integrity);
  setStatus(revision===version?'已自动保存':'有更新待保存');return true;
}).catch(failure=>{if(failure.code==='RESUME_OPTIMIZATION_REVISION_CONFLICT')showConflict();setStatus(failure.code==='RESUME_OPTIMIZATION_REVISION_CONFLICT'?failure.message:'保存失败，修改仍保留在本机。请点击“保存草稿”重试。');return false;});return chain;};
const changed=()=>{version+=1;remember(true);if(conflicted){setStatus('本页有未保存修改，请查看最新版本并合并。');return;}setStatus('有修改待保存');clearTimeout(timer);timer=setTimeout(()=>enqueue(editor.value,version),600);};
const flush=async()=>{clearTimeout(timer);await chain;while(editor.value!==savedText){if(!await enqueue(editor.value,version))return false;clearTimeout(timer);}return true;};
const navigate=(url,target)=>{const base=String(url||'').split('#')[0];const destination=base+(target?'#'+target:'');if(location.href.split('#')[0]===base){location.hash=target;location.reload();}else location.assign(destination);};
if(editable){
  form.querySelector('[data-resume-reload]')?.addEventListener('click',()=>{remember();location.reload();});
  editor.addEventListener('input',changed);
  try{const backup=JSON.parse(localStorage.getItem(backupKey)||'null');
    if(backup&&typeof backup.text==='string'&&backup.text!==savedText){
      const restore=()=>{editor.value=backup.text;changed();const notice=form.querySelector('[data-resume-recovery]');if(notice)notice.hidden=true;setStatus('已恢复未保存的修改，正在保存…');};
      if(backup.baseText===savedText)restore();
      else{const notice=form.querySelector('[data-resume-recovery]');if(notice)notice.hidden=false;form.querySelector('[data-resume-restore]')?.addEventListener('click',restore);}
    }else if(backup)localStorage.removeItem(backupKey);
  }catch{}
  for(const link of document.querySelectorAll('a[href]'))link.addEventListener('click',async event=>{
    if(event.defaultPrevented||event.button>0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey||link.target||link.hasAttribute('download'))return;
    const destination=new URL(link.href,location.href);const current=new URL(location.href);
    if(destination.pathname===current.pathname&&destination.search===current.search)return;
    if(editor.value===savedText)return;
    event.preventDefault();if(await flush())location.assign(link.href);else editor.focus();
  });
  if(typeof addEventListener==='function'){
    addEventListener('pagehide',remember);
    addEventListener('beforeunload',event=>{if(editor.value!==savedText){remember();event.preventDefault();event.returnValue='';}});
  }
}
for(const submitForm of document.querySelectorAll('[data-resume-submit]'))submitForm.addEventListener('submit',async event=>{
  const exportAction=event.submitter?.getAttribute?.('formaction');if(exportAction==='/api/resume-optimization/export')return;
  event.preventDefault();const button=event.submitter||submitForm.querySelector('button');if(button?.disabled)return;
  const label=button?.textContent||'';const error=submitForm.querySelector('[data-resume-error]')||submitForm.querySelector('[data-resume-save-status]');
  if(error)error.textContent='';
  const action=button?.getAttribute?.('formaction')||submitForm.getAttribute('action')||submitForm.action;
  if(button){button.disabled=true;button.textContent=action.endsWith('/activate')?'正在启用…':action.endsWith('/save')?'正在保存…':action.endsWith('/copy')?'正在打开草稿…':'正在整理简历…';}
  if(submitForm===form){clearTimeout(timer);if(editable)editor.readOnly=true;}
  try{
    if(editable){if(submitForm===form)await chain;else if(!await flush())throw new Error('保存失败，请先重试保存当前简历。');}
    const body=new URLSearchParams(new FormData(submitForm));
    if(submitForm===form&&editable){if(conflicted)throw new Error('这份简历已在其他页面更新，请先查看最新版本并合并。本页修改仍保留。');if(savedRevision)body.set('expectedRevision',savedRevision);else{body.delete('expectedRevision');body.set('baseText',savedText);}}
    let operationKey='';
    if(action.endsWith('/resume-optimization')){operationKey='offergo:pending-generation:'+action+':'+body.toString();let operationId;try{operationId=localStorage.getItem(operationKey);}catch{}if(operationId){const query=new URLSearchParams({planId:body.get('planId'),operationId});let response,payload;try{response=await fetch('/api/resume-optimization/operation?'+query,{cache:'no-store'});payload=await readPayload(response);}catch{throw new Error('暂时无法确认上次生成是否完成，请稍后重试。当前输入与操作编号仍保留。');}if(!response.ok||typeof payload.saved!=='boolean')throw new Error('暂时无法确认上次生成是否完成，请稍后重试。当前输入与操作编号仍保留。');if(payload.saved){try{localStorage.removeItem(operationKey);}catch{}operationId=null;}}if(!operationId){operationId=typeof crypto!=='undefined'&&crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+Math.random().toString(36).slice(2);try{localStorage.setItem(operationKey,operationId);}catch{}}body.set('operationId',operationId);}
    const response=await fetch(action,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body});
    if(!response.ok){const payload=await readPayload(response);if(operationKey){try{localStorage.removeItem(operationKey);}catch{}}throw failureFrom(payload);}
    if(operationKey){try{localStorage.removeItem(operationKey);}catch{}}
    if(submitForm===form&&editable){savedText=body.get('finalText');remember();}
    const target=button?.dataset.resumeSuccessTarget||submitForm.dataset.resumeSuccessTarget||'';navigate(response.url||action,target);
  }catch(failure){
    if(failure.code==='RESUME_OPTIMIZATION_REVISION_CONFLICT')showConflict();
    if(Array.isArray(failure.issues))updateIntegrity({errors:failure.issues,warnings:[]});
    displayFailure(error,failure);
    if(submitForm===form&&editable)editor.readOnly=false;
    if(button){button.disabled=false;button.textContent=label;}
  }
});
})();</script>`;

function renderResumePrintPage(text) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>简历</title><style>
    body{margin:0;color:#1b2530;background:#edf0f3;font-family:"Microsoft YaHei",sans-serif}
    .toolbar{max-width:760px;margin:20px auto;padding:0 24px;display:flex;gap:16px;align-items:center}
    button{padding:10px 18px;border:0;border-radius:8px;background:#243747;color:white;cursor:pointer;font:inherit}
    main{max-width:760px;margin:20px auto;padding:40px;background:white;box-sizing:border-box}
    .resume-text{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:1.8}
    @page{size:A4;margin:18mm}
    @media print{body{background:white}.toolbar{display:none}main{max-width:none;margin:0;padding:0}.resume-text{font-size:11pt;line-height:1.6}}
  </style></head><body><div class="toolbar"><button type="button" onclick="window.print()">打印 / 保存 PDF</button><span>在打印窗口中选择“另存为 PDF”，保存后可上传给 HR。</span></div><main><div class="resume-text">${escapeHtml(text)}</div></main></body></html>`;
}

module.exports = { renderResumeOptimizationPage, RESUME_OPTIMIZATION_SCRIPT, publicResumeIntegrityIssues, renderResumePrintPage };

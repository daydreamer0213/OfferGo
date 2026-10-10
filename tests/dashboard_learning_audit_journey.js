const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const storage = require('../src/core/storage');
const { recordCandidateFactValue } = require('../src/storage/message_learning_store');
const { createMessageReplyLearningService } = require('../src/application/message_learning');
const { createMessageReplyAnalyzer } = require('../src/core/message_reply_analyzer');
const { createDashboardServer } = require('../src/dashboard/server');
const { PIPELINE_VERSIONS } = require('../src/core/analysis_revision');

(async () => {
  let chromium;
  try { ({chromium} = require('playwright')); }
  catch(error) {
    if(process.env.ROLEFLOW_REQUIRE_PLAYWRIGHT==='1') throw error;
    console.log('dashboard_learning_audit_journey SKIP: Playwright unavailable'); return;
  }
  const db = storage.openDb(':memory:');
  let browser,server;
  try {
    const now='2026-10-07T08:00:00.000Z';
    const owner=storage.saveProfileAnalysis(db,{profile:{candidate:{name:'隔离测试用户',city:'杭州',targetTitles:['后端开发']}},
      document:{originalFileName:'fixture.txt',format:'text',contentHash:'learning-audit-journey',text:'后端开发，负责接口测试。',diagnostics:{}},
      searchPlan:{name:'隔离方案',directions:['后端开发'],cities:['杭州'],keywords:[{word:'后端开发',priority:'A'}]}});
    const profileId=owner.profileId;
    const jobId=Number(db.prepare("INSERT INTO jobs(source,source_id,title,company,description,analysis_json,first_seen_at,last_seen_at) VALUES ('boss','learning-audit','后端开发','隔离测试公司',?,'{}',?,?)").run('负责后端接口开发、联调和测试。'.repeat(20),now,now).lastInsertRowid);
    db.prepare('UPDATE jobs SET analysis_json = ? WHERE id = ?').run(JSON.stringify({semanticStatus:'complete',provider:'fixture-model',revision:{pipelineVersions:PIPELINE_VERSIONS},recommendation:'consider'}),jobId);
    const cardId=Number(db.prepare("INSERT INTO candidate_progress_cards(profile_id,plan_id,job_id,source,stage,next_action,last_event_at,created_at,updated_at) VALUES (?,?,?,'boss','reply_ready','review',?,?,?)").run(profileId,owner.planId,jobId,now,now,now).lastInsertRowid);
    const draftFor=index=>storage.recordMessageReplyDrafts(db,{profileId,cardId,jobId,
      messageGroupKey:`sha256:${createHash('sha256').update(String(index)).digest('hex')}`,
      questionSummary:`项目问答 ${index}`,messageIntent:'information_request',messageCategory:'project_fact',messages:['原始草稿'],createdAt:now})[0];
    let oldest;
    for(let index=0;index<121;index++) {
      const draft=draftFor(index);
      const memory=storage.completeMessageReplyDraft(db,{profileId,draftId:draft.id,finalText:index===0?'最早经历检索标记：我负责接口排查。':`我负责项目联调 ${index}。`,
        changedText:'我负责',completionKind:'copied',scope:{kind:'global',key:''},completedAt:now});
      if(index===0)oldest=memory;
    }
    storage.closeMessageReplyDrafts(db,{profileId,cardId,closedAt:now});
    const draft=draftFor('two-tabs');
    recordCandidateFactValue(db,{profileId,factKey:'availability_date',factValue:'确认录用后一周内可到岗',occurredAt:'2026-09-20T08:00:00.000Z'});
    const service=createMessageReplyLearningService({db,now:()=>now});
    const logger={info(){},warn(){},error(){},requestId(){return 'learning-audit-journey';},listRecent(){return [];}};
    server=createDashboardServer({db,forceMock:true,allowOfflineMock:true,logger,messageReplyLearningService:service,
      browserAuthority:{browserMode:'edge',cdpPort:null,profilePath:''},browserFactory(){throw new Error('local journey must not access recruitment platforms');}});
    const base=await new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${server.address().port}`)));
    browser=await chromium.launch({channel:'msedge',headless:true});
    const context=await browser.newContext({permissions:['clipboard-read','clipboard-write']});
    await context.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
    const a=await context.newPage(),b=await context.newPage();
    const errors=[];
    for(const page of [a,b])page.on('pageerror',error=>errors.push(error.message));
    const messages=`${base}/messages?profileId=${profileId}`;
    for(const page of [a,b]) {
      await page.goto(messages); await page.waitForLoadState('networkidle');
      await page.locator('[data-message-view]').first().click();
    }
    if(process.env.ROLEFLOW_LEARNING_AUDIT_OUTPUT) {
      fs.mkdirSync(process.env.ROLEFLOW_LEARNING_AUDIT_OUTPUT,{recursive:true});
      fs.writeFileSync(path.join(process.env.ROLEFLOW_LEARNING_AUDIT_OUTPUT,'messages-fixture.html'),await a.content());
    }
    const fieldA=a.locator(`textarea[data-draft-id="${draft.id}"]:visible`);
    const fieldB=b.locator(`textarea[data-draft-id="${draft.id}"]:visible`);
    await fieldA.fill('页面甲保存的内容');
    await a.locator(`[data-draft-save-status="${draft.id}"]`).filter({hasText:'已自动保存'}).waitFor();
    await fieldB.fill('页面乙仍需保留的输入');
    await b.locator(`[data-draft-save-status="${draft.id}"]`).filter({hasText:'其他页面更新'}).waitFor();
    assert.equal(await fieldB.inputValue(),'页面乙仍需保留的输入');
    assert.equal(storage.getMessageReplyDraft(db,{profileId,draftId:draft.id}).currentText,'页面甲保存的内容');
    await b.locator(`[data-copy-draft="message-draft-${draft.id}"]`).click();
    await b.locator('[data-discovery-feedback]').filter({hasText:'已复制；'}).waitFor();
    assert.equal(await b.evaluate(()=>navigator.clipboard.readText()),'页面乙仍需保留的输入');
    assert.equal(await fieldB.inputValue(),'页面乙仍需保留的输入');
    assert.equal(storage.getMessageReplyDraft(db,{profileId,draftId:draft.id}).currentText,'页面甲保存的内容');
    assert.equal(storage.listCandidateAnswerMemories(db,{profileId,draftId:draft.id,activeOnly:false}).length,0,'stale copy does not learn or replace content');
    await a.reload(); assert.equal(await fieldA.inputValue(),'页面甲保存的内容');

    await a.goto(`${base}/communication-profile?profileId=${profileId}`);
    const fact=a.locator('article.message-draft').filter({has:a.getByRole('heading',{name:'到岗时间',exact:true})});
    assert((await fact.innerText()).includes('需要重新确认'));
    const confirm=a.waitForResponse(response=>response.url().endsWith('/api/communication-profile')&&response.request().method()==='POST');
    await fact.getByRole('button',{name:'保存修改',exact:true}).click();
    assert.equal((await confirm).status(),303); await a.waitForLoadState('networkidle');
    assert((await fact.innerText()).includes('已确认有效'));
    assert.equal(storage.listCandidateFacts(db,profileId)[0].updatedAt,now);
    let modelFacts;
    await createMessageReplyAnalyzer({adapter:{async draftMessageGroup(input){modelFacts=input.facts;return {messageIntent:'information_request',messageCategory:'availability',messageSummary:'确认到岗时间',requiredFactKeys:['availability_date'],usedFactKeys:['availability_date'],responseItems:[{id:'availability_date',kind:'question',required:true}],coverage:[{responseItemId:'availability_date',covered:true}],missingFact:null,messages:['确认录用后一周内可到岗。']};}}})({profile:{},facts:storage.listCandidateFacts(db,profileId),now,messages:[{text:'什么时候能到岗？'}]});
    assert.equal(modelFacts[0].value,'确认录用后一周内可到岗');
    assert(!(await a.locator('#saved-answers').innerText()).includes('最早经历检索标记'));
    await a.getByRole('link',{name:'下一页',exact:true}).click();
    assert((await a.locator('#saved-answers').innerText()).includes('第 2 页'));
    await a.locator('input[name="answerQuery"]').fill('最早经历检索标记');
    await a.getByRole('button',{name:'查找回答',exact:true}).click();
    await a.waitForLoadState('networkidle');
    const answer=a.locator('#saved-answers article.message-draft').filter({has:a.locator(`input[name="memoryId"][value="${oldest.id}"]`)});
    assert.equal(await answer.count(),1);
    await answer.locator('textarea[name="finalText"]').fill('最早经历已修订：我负责请求排查和验证。');
    const revise=a.waitForResponse(response=>response.url().endsWith('/api/communication-profile')&&response.request().method()==='POST');
    await answer.getByRole('button',{name:'保存修改',exact:true}).click(); assert.equal((await revise).status(),303);
    await a.waitForLoadState('networkidle');
    const revised=storage.listCandidateAnswerMemories(db,{profileId,search:'最早经历已修订'})[0];
    assert(revised);
    const revisedArticle=a.locator('#saved-answers article.message-draft').filter({has:a.locator(`input[name="memoryId"][value="${revised.id}"]`)});
    const withdraw=a.waitForResponse(response=>response.url().endsWith('/api/communication-profile')&&response.request().method()==='POST');
    await revisedArticle.getByRole('button',{name:'不再使用这条回答',exact:true}).click(); assert.equal((await withdraw).status(),303);
    await a.waitForLoadState('networkidle');
    assert.equal(storage.listCandidateAnswerMemories(db,{profileId,search:'最早经历'}).length,0);
    assert(!(await a.locator('#saved-answers').innerText()).includes('最早经历'));
    assert.deepEqual(errors,[]);
    if(process.env.ROLEFLOW_LEARNING_AUDIT_OUTPUT) {
      const out=path.resolve(process.env.ROLEFLOW_LEARNING_AUDIT_OUTPUT); fs.mkdirSync(out,{recursive:true});
      await b.screenshot({path:path.join(out,'reply-conflict-preserved.png'),fullPage:true});
      await a.screenshot({path:path.join(out,'profile-managed.png')});
      fs.writeFileSync(path.join(out,'journey-result.json'),JSON.stringify({twoPages:'passed',copyConflict:'passed',reconfirmation:'passed',history121:'passed',reviseWithdraw:'passed',pageErrors:errors},null,2));
    }
    console.log('dashboard_learning_audit_journey ok');
  } finally {if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));db.close();}
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const storage = require('../src/core/storage');
const { zhaopinJobIdentity } = require('../src/core/zhaopin_search_scope');
const { createMessageDiscoveryController } = require('../src/dashboard/message_discovery_controller');
const { createDashboardServer } = require('../src/dashboard/server');
const { recordUnresolvedMessageDiscoveryItem } = require('../src/core/message_preview_state');
const { listIncomingContacts } = require('../src/application/funnel_analysis');
const { upsertMessageInboxItem } = require('../src/storage/message_inbox_store');
const NOW = '2026-09-08T01:00:00.000Z';
const PARAMETERIZED_IM_URL = 'https://i.zhaopin.com/im?refcode=4089&sessionId=' + 'a'.repeat(32) + '#conversation';
const digest = value => 'sha256:' + crypto.createHash('sha256').update(value).digest('hex');
const logger = { info() {}, warn() {}, error() {}, requestId() { return 'unified'; }, listRecent() { return []; } };
function seed(db, platform, profileId, planId, manual = false, suffix = manual ? '8' : '9', messages = ['好的，可以沟通。']) {
  const sourceId = platform + ':CCL1234567890J0012345678' + suffix;
  const storedId = platform === 'zhaopin' ? zhaopinJobIdentity('https://www.zhaopin.com/jobdetail/CCL1234567890J0012345678' + suffix + '.htm').sourceId : sourceId;
  const description = '负责完整岗位流程、业务需求梳理、方案实现、质量验证与跨团队协作，并持续跟进上线后的效果与改进。'.repeat(3);
  const analysis = JSON.stringify({ semanticStatus: 'complete', provider: 'fixture-model', recommendation: 'consider', roleSummary: '负责完整岗位流程和交付', fitSummary: '候选人的项目经验与岗位要求已经完成比对' });
  const jobId = Number(db.prepare("INSERT INTO jobs(source,source_id,title,company,description,analysis_json,first_seen_at,last_seen_at) VALUES (?,?,'同名岗位','合成公司',?,?,?,?)").run(platform, storedId, description, analysis, NOW, NOW).lastInsertRowid);
  if (platform === 'zhaopin') {
    const batchId = Number(db.prepare("INSERT INTO batches(site,keyword,started_at,status,finished_at,profile_id,search_plan_id) VALUES (?,'消息验收',?,'completed',?,?,?)").run(platform, NOW, NOW, profileId, planId).lastInsertRowid);
    db.prepare("INSERT INTO job_observations(job_id,batch_id,title,company,description,analysis_json,content_hash,seen_at) VALUES (?,?,'同名岗位','合成公司',?,?,?,?)")
      .run(jobId, batchId, description, analysis, digest(sourceId), NOW);
  }
  const cardId = Number(db.prepare("INSERT INTO candidate_progress_cards(profile_id,plan_id,job_id,source,stage,next_action,last_event_at,created_at,updated_at) VALUES (?,?,?,?,'reply_ready','人工确认',?,?,?)").run(profileId, planId, jobId, platform, NOW, NOW, NOW).lastInsertRowid);
  const key = digest(sourceId);
  const drafts = manual ? [] : storage.recordMessageReplyDrafts(db, { profileId,cardId,jobId,messageGroupKey:key,messageIntent:'information_request',messageCategory:'other',questionSummary:'确认沟通',messages,createdAt:NOW });
  storage.saveMessageInboundContext(db, { platform,profileId,cardId,messageGroupKey:key,conversationKey:digest('conversation'+sourceId),sourceJobId:sourceId,lastMessageId:'378917037748741',messageIntent:manual?'manual_review':'information_request',messageCategory:'other',inboundMessages:[{kind:manual?'resume_request':'text',text:manual?'HR 邀请你发送简历':platform+' 原始问题'}],manualActions:manual?[{kind:'resume_request'}]:[],createdAt:NOW,updatedAt:NOW });
  return {cardId,jobId,drafts,key};
}
async function settle(controller, profileId) { for(let i=0;i<100;i++){if(controller.status(profileId).status!=='running')return controller.pageState(profileId);await new Promise(r=>setTimeout(r,5));}throw Error('discovery did not settle'); }
function assertUnknownZhaopinReceipts(result) {
  const entry = result.platformRuns.find(item => item.platform === 'zhaopin');
  assert.equal(entry.counters.currentRead, null, `${entry.status}/${entry.reasonCode}: ZL read receipts lack evidence`);
  assert.equal(entry.counters.currentDelivered, null, `${entry.status}/${entry.reasonCode}: ZL delivery receipts lack evidence`);
}
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'roleflow-unified-'));
  const dbPath = path.join(root,'fixture.sqlite');
  const db = storage.openDb(dbPath);
  let server, browser;const controllers=[];
  try {
    const profileId = Number(db.prepare("INSERT INTO candidate_profiles(display_name,profile_json,created_at,updated_at) VALUES ('合成候选人','{}',?,?)").run(NOW,NOW).lastInsertRowid);
    storage.saveWorkspacePlatformPreference(db, ["boss", "zhaopin"]);
    const planId = Number(db.prepare("INSERT INTO search_plans(profile_id,name,plan_json,is_active,created_at,updated_at) VALUES (?,'合成计划','{}',1,?,?)").run(profileId,NOW,NOW).lastInsertRowid);
    const boss = seed(db,'boss',profileId,planId);
    const zl = seed(db,'zhaopin',profileId,planId,false,'9',['好的，可以沟通。','也可以先介绍具体安排。']);
    const manual = seed(db,'zhaopin',profileId,planId,true);
    let nativeScans=0,nativeBossGuards=0,nativeActive=0,nativeMax=0,nativePlatforms=['zhaopin'];const nativeOrder=[], nativeStates=[];
    const nativeController=createMessageDiscoveryController({db,acquireLease:storage.acquireSiteScanLease,renewLease:storage.renewSiteScanLease,releaseLease:storage.releaseSiteScanLease,
      createBrowser:()=>({listTabs:async()=>nativePlatforms.map((platform,index)=>({id:index+1,windowId:1,url:platform==='boss'?'https://www.zhipin.com/web/geek/chat':PARAMETERIZED_IM_URL}))}),
      assertRuntimeAvailable:()=>{nativeBossGuards++;},createReader:({platform})=>({async scanConversationRows(){nativeStates.push(nativeController.status(profileId).platformRuns);assert(nativeController.status(profileId).platformRuns.every(entry=>['not_connected','running','completed','stopped','needs_user_action'].includes(entry.status)));nativeScans++;nativeOrder.push(platform);nativeActive++;nativeMax=Math.max(nativeMax,nativeActive);await new Promise(resolve=>setTimeout(resolve,1));nativeActive--;return {platform,rows:[]};}}),createAnalyzer:()=>async()=>({}),createDetailSafety:()=>({}),createDetailReader:()=>({}),createJobContextResolver:()=>async()=>({})});
    controllers.push(nativeController);nativeController.start(profileId);const nativeResult=await settle(nativeController,profileId);assert.equal(nativeScans,1,'shared production pipeline reaches the ZL reader');assert.equal(nativeBossGuards,0);
    assert.equal(nativeResult.results.length,3,'a sync with no new replies must retain every durable pending action');
    assertUnknownZhaopinReceipts({ platformRuns: nativeStates[0] });
    const nativeZl = nativeResult.platformRuns.find(entry => entry.platform === 'zhaopin');
    assert.equal(nativeZl.counters.currentRead, null, 'public platformRuns must preserve unknown ZL read receipts');
    assert.equal(nativeZl.counters.currentDelivered, null, 'public platformRuns must preserve unknown ZL delivery receipts');
    assert.equal(nativeResult.counters.currentRead, 0, 'aggregate receipts remain BOSS-only numbers');
    assert.equal(nativeResult.counters.currentDelivered, 0);
    nativePlatforms=['zhaopin','boss'];nativeController.start(profileId);await settle(nativeController,profileId);assert.deepEqual(nativeOrder,['zhaopin','boss','zhaopin']);assert.equal(nativeMax,1,'production pipelines must never overlap browser reads');
    assertUnknownZhaopinReceipts({ platformRuns: nativeStates[1] });
    assert.equal(nativeStates[1].find(entry => entry.platform === 'zhaopin').reasonCode, 'MESSAGE_DISCOVERY_WAITING_TURN');
    await nativeController.close();
    let bossReadCalls=0,zhaopinReadCalls=0,operations=0,maxOperations=0,cleanup=0;const riskRecords=[];
    let connected=['zhaopin']; const order=[];
    const deps={db,acquireLease:storage.acquireSiteScanLease,renewLease:storage.renewSiteScanLease,releaseLease:storage.releaseSiteScanLease,
      createBrowser:()=>({
        listTabs:async()=>connected.map((p,i)=>({id:i+1,windowId:1,url:p==='boss'?'https://www.zhipin.com/web/geek/chat':p==='boss_stale'||p==='boss_risk'?'https://www.zhipin.com/web/geek/jobs?_security_check=fixture':PARAMETERIZED_IM_URL})),
        evalValue:async(tabId)=>{
          const platform=connected[tabId-1];
          return {url:platform==='boss'?'https://www.zhipin.com/web/geek/chat':'https://www.zhipin.com/web/geek/jobs?_security_check=fixture',title:platform==='boss_risk'?'安全验证':'BOSS直聘',isBoss:true,isLoginPage:false,isRiskPage:platform==='boss_risk',hasUserSurface:platform!=='boss_risk',loggedIn:platform!=='boss_risk',isSearchPage:platform!=='boss',hasJobStructure:platform!=='boss_risk'};
        }
      }),
      cleanupBrowser:async()=>{cleanup++;},assertRuntimeAvailable:()=>{bossReadCalls++;if(deps.blockBoss)throw Object.assign(Error('existing pause'),{code:'BOSS_RUNTIME_BLOCKED'});},
      recordRiskControl:(input)=>riskRecords.push(input),
      createReader:({platform})=>({platform}),createDetailSafety:()=>({}),createDetailReader:()=>({}),createJobContextResolver:()=>async()=>({}),createAnalyzer:()=>async()=>({}),
      runDiscovery:async({platform,signal,onStatus})=>{operations++;maxOperations=Math.max(maxOperations,operations);order.push(platform);if(platform==='zhaopin')zhaopinReadCalls++;try{if(deps.waitSecond&&platform==='zhaopin'){onStatus({status:'running',phase:'reading_messages',results:[]});await new Promise(r=>signal.addEventListener('abort',r,{once:true}));return {status:'stopped',results:[]};}return {status:'completed',processed:1,counters:{visible:1,newReplies:1,currentRead:platform==='boss'?7:99},results:[{cardId:platform==='boss'?boss.cardId:zl.cardId,jobId:platform==='boss'?boss.jobId:zl.jobId}]};}finally{operations--;}}};
    const controller=createMessageDiscoveryController(deps);
    controllers.push(controller);
    controller.start(profileId); let result=await settle(controller,profileId);
    assert.equal(bossReadCalls,0,'ZL-only discovery must not invoke BOSS safety/read helpers');
    assert.equal(zhaopinReadCalls,1);assert.equal(maxOperations,1);assert.equal(cleanup,1);
    assert.equal(result.platformRuns.find(r=>r.platform==='boss').status,'not_connected');
    connected=['zhaopin','boss'];order.length=0;controller.start(profileId);result=await settle(controller,profileId);
    assert.deepEqual(order,['boss','zhaopin']);assert.equal(result.results.length,3,'current results merge with the existing manual-only pending action');assert.equal(result.counters.visible,2);assert.equal(result.counters.currentRead,7,'ZL cannot contribute invented BOSS read receipts');
    assertUnknownZhaopinReceipts(result);
    deps.waitSecond=true;controller.start(profileId);while(order.length<4)await new Promise(r=>setTimeout(r,5));controller.stop(profileId);result=await settle(controller,profileId);
    assertUnknownZhaopinReceipts(result);
    assert(result.results.some(item=>item.cardId===boss.cardId));assert(storage.getMessageReplyDraft(db,{profileId,draftId:boss.drafts[0].id}));
    deps.waitSecond=false;connected=['boss'];controller.start(profileId);result=await settle(controller,profileId);
    assert(result.results.some(item=>item.cardId===boss.cardId));assert.equal(result.platformRuns.find(r=>r.platform==='zhaopin').status,'not_connected');
    assertUnknownZhaopinReceipts(result);
    connected=['boss','zhaopin','zhaopin'];controller.start(profileId);result=await settle(controller,profileId);
    assert(result.results.some(item=>item.cardId===boss.cardId));assert.equal(result.platformRuns.find(r=>r.platform==='zhaopin').status,'completed');assert.equal(result.platformRuns.find(r=>r.platform==='zhaopin').reasonCode,'','extra same-platform tabs must not block the managed message page');
    connected=['boss','zhaopin'];deps.blockBoss=true;controller.start(profileId);result=await settle(controller,profileId);assert.equal(controller.status(profileId).results[0].cardId,zl.cardId);assert(result.results.some(item=>item.cardId===zl.cardId));assert.equal(result.platformRuns.find(r=>r.platform==='boss').reasonCode,'BOSS_RUNTIME_BLOCKED');deps.blockBoss=false;
    connected=['boss','boss_stale','zhaopin'];order.length=0;controller.start(profileId);result=await settle(controller,profileId);assert.deepEqual(order,['boss','zhaopin'],'a stale security-check query parameter cannot hide a healthy logged-in BOSS session');assert.equal(result.platformRuns.find(r=>r.platform==='boss').status,'completed');
    connected=['boss','boss_risk','zhaopin'];order.length=0;controller.start(profileId);result=await settle(controller,profileId);assert.deepEqual(order,['zhaopin'],'a live BOSS risk page takes precedence over an apparently usable message tab');assert.equal(result.platformRuns.find(r=>r.platform==='boss').status,'needs_user_action');assert.equal(result.platformRuns.find(r=>r.platform==='boss').reasonCode,'BOSS_RISK_CONTROL');assert.equal(riskRecords.at(-1).errorCode,'BOSS_RISK_CONTROL');
    await controller.close();
    const restored=createMessageDiscoveryController({db});const recovered=restored.pageState(profileId);
    assert.equal(recovered.results.length,3,'manual-only inbound context must survive restart');
    assert.equal(recovered.results.find(r=>r.cardId===zl.cardId).contextComplete,true,'published Zhaopin actions retain complete trusted analysis');
    assert.equal(recovered.results.find(r=>r.cardId===zl.cardId).platform,'zhaopin');
    const frozen=storage.createMessageReplySendBatch(db,{profileId,items:[{draftId:boss.drafts[0].id,revision:0}]});
    assert.throws(()=>restored.dismiss(profileId),error=>error.code==='MESSAGE_REPLY_SEND_DRAFT_BUSY');
    assert.equal(storage.listMessageInboundContexts(db,{profileId}).length,3,'busy send prevents any context deletion');
    db.prepare("UPDATE message_reply_send_items SET status='stopped' WHERE batch_id=?").run(frozen.batch.id);
    db.prepare("UPDATE message_reply_send_batches SET status='stopped' WHERE id=?").run(frozen.batch.id);
    await restored.close();
    const historicalConversationKey=digest('historical-boss-pending');
    recordUnresolvedMessageDiscoveryItem(db,{profileId,platform:'boss',conversationKey:historicalConversationKey,previewDigest:digest('historical-boss-preview'),previewKind:'possible_hr_reply',observedAt:'2026-09-07T01:00:00.000Z',reasonCode:'BOSS_MESSAGE_CARD_NOT_FOUND',identity:{positionTitle:'历史待核对岗位',company:'历史合成公司'}});
    const zhaopinPendingConversationKey=digest('historical-zhaopin-pending');
    recordUnresolvedMessageDiscoveryItem(db,{profileId,platform:'zhaopin',conversationKey:zhaopinPendingConversationKey,previewDigest:digest('historical-zhaopin-preview'),previewKind:'possible_hr_reply',observedAt:'2026-09-07T02:00:00.000Z',sourceJobId:'zhaopin:CCL1234567890J0099999999',lastMessageId:'202609070200',reasonCode:'MESSAGE_DISCOVERY_JOB_CONTEXT_UNAVAILABLE',identity:{positionTitle:'待补岗位资料',company:'智联合成公司'},inboundMessages:[{kind:'text',text:'合成待处理原文'}]});
    let httpBrowserCalls=0,httpBossCalls=0,httpReaderCalls=0,httpReaderShouldWait=false;
    server=createDashboardServer({db,dbPath,root,dataRoot:root,forceMock:true,logger,browserAuthority:{browserMode:'portable',cdpPort:9222,profilePath:path.join(root,'profile')},
      browserFactory:()=>{httpBrowserCalls++;return {listTabs:async()=>[{id:2,windowId:1,url:PARAMETERIZED_IM_URL}]};},
      messageDiscoveryDependencies:{assertRuntimeAvailable:()=>{httpBossCalls++;},createAnalyzer:()=>async()=>({}),createReader:()=>({async scanConversationRows(signal){httpReaderCalls++;if(httpReaderShouldWait)await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));return {platform:'zhaopin',rows:[]};}})}});
    await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
    const before=db.prepare('SELECT COUNT(*) n FROM candidate_progress_events').get().n;
    const sent=await fetch(base+'/api/progress',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({cardId:zl.cardId,draftId:zl.drafts[0].id,finalText:'篡改答案',action:'reply_confirmed_sent',idempotencyKey:'zl-forbidden'})});
    assert.equal(sent.status,409);assert.equal((await sent.json()).errorCode,'MESSAGE_REPLY_PLATFORM_UNSUPPORTED');assert.equal(db.prepare('SELECT COUNT(*) n FROM candidate_progress_events').get().n,before);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM candidate_answer_memories').get().n,0,'rejected sent confirmation must not teach an answer');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM candidate_funnel_entries').get().n,0,'rejected sent confirmation must not create funnel entries');
    assert.equal(storage.getMessageReplyDraft(db,{profileId,draftId:zl.drafts[0].id}).currentText,'好的，可以沟通。');
    let chromium;try{({chromium}=require('playwright'));}catch(error){if(process.env.ROLEFLOW_REQUIRE_PLAYWRIGHT==='1')throw error;console.log('dashboard_unified_messages_journey browser SKIP: Playwright unavailable');return;}
    browser=await chromium.launch({channel:'msedge',headless:true});const context=await browser.newContext({permissions:['clipboard-read','clipboard-write']});const page=await context.newPage();const errors=[],external=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',message=>{if(message.type()==='error'&&!message.text().includes('500 (Internal Server Error)'))errors.push(message.text());});await page.route('**/*',route=>{if(new URL(route.request().url()).origin!==base){external.push(route.request().url());return route.abort();}return route.continue();});
    for(const route of ['queue','jobs']){await page.goto(base+'/'+route+'?planId='+planId+'&site=zhaopin');const entry=page.getByRole('link',{name:'消息与回复',exact:true});assert.equal(await entry.count(),1);assert.equal(new URL(await entry.getAttribute('href'),base).searchParams.get('workSite'),'zhaopin');const records=page.getByRole('link',{name:'发送记录',exact:true});assert.equal(await records.count(),1);assert.equal(new URL(await records.getAttribute('href'),base).pathname,'/communication');assert.equal(new URL(await records.getAttribute('href'),base).searchParams.get('site'),'zhaopin');}
    await page.goto(base+'/plan?planId='+planId+'&site=zhaopin');const inbox=page.getByRole('link',{name:'消息与回复',exact:true});assert.equal(await inbox.count(),1);await inbox.click();assert.equal(new URL(page.url()).searchParams.get('workSite'),'zhaopin');
    assert.equal(await page.getByRole('link',{name:'发送记录',exact:true}).count(),1);const today=page.getByRole('link',{name:'今日任务',exact:true});assert.equal(new URL(await today.getAttribute('href'),base).searchParams.get('site'),'zhaopin');
    assert.equal(await page.locator('.message-workspace').count(),1);assert.equal(await page.locator('.message-unresolved:not(.message-workspace *)').count(),0);assert.equal(await page.locator('[data-message-detail-panel]:visible').count(),1);
    const zlCard=page.locator('[data-message-detail-panel].message-result[data-platform="zhaopin"]').filter({has:page.locator('[data-draft-text]')});assert.equal(await zlCard.locator('[data-send-single]').count(),2);assert.equal(await zlCard.locator('[data-send-select]').count(),2);assert.equal(await zlCard.locator('[data-copy-draft]').count(),2);
    const manualCard=page.locator('[data-message-detail-panel].message-result[data-platform="zhaopin"]').filter({hasNot:page.locator('[data-draft-text]')});assert.match(await manualCard.textContent(),/HR 邀请你发送简历/);assert.doesNotMatch(await manualCard.textContent(),/原始会话/);assert.match(await manualCard.textContent(),/没有经过验证的平台操作按钮/);assert.equal(await manualCard.locator('[data-message-action-confirm]').count(),0);assert.equal(await manualCard.locator('form').count(),0);
    assert.equal(await page.locator('[data-send-select]').count(),3,'BOSS and Zhaopin drafts both enter explicit batch selection');
    assert.equal(await page.locator('[data-send-select]:checked').count(),0,'batch starts with no implicit selection');
    assert.equal(await page.locator('.message-send-choice:visible').count(),0,'send selection is available only after explicitly entering batch mode');
    assert.equal(await page.locator('details.message-draft-alternatives:not([open]) [data-draft-text]').count(),1,'only the primary reply is expanded before the user asks for another version');
    await page.getByRole('button',{name:'进入批量发送',exact:true}).click();
    assert.equal(await page.locator('[data-send-batch]').isDisabled(),true,'an empty explicit batch cannot start');
    await page.getByRole('button',{name:'退出批量',exact:true}).click();
    assert.equal(await page.locator('[data-send-select]:checked').count(),0,'leaving batch clears selections');
    await page.setViewportSize({width:584,height:694});await page.waitForFunction(()=>document.querySelector('.message-workspace')?.dataset.mobileList==='true');
    assert((await page.locator('.message-list-item').first().boundingBox()).y + 100 <= 694,'the first contact and its HR preview fit above the fold on the 584px side panel');
    assert.equal(await page.locator('.message-list').isVisible(),true,'narrow view starts with the list');
    assert.equal(await page.locator('.message-detail').isVisible(),false,'narrow view does not cover the list with a preset detail');
    const narrowRow=page.locator('.message-list-item').first();const narrowKey=await narrowRow.locator('[data-message-view]').getAttribute('data-message-view');
    await narrowRow.click();
    await page.locator('[data-message-detail-panel="'+narrowKey+'"]').waitFor({state:'visible'});
    assert.equal(await page.locator('.message-detail').isVisible(),true,'selecting a contact opens its detail on narrow screens');
    assert.equal(await page.locator('[data-message-detail-panel="'+narrowKey+'"] [data-draft-text], [data-message-detail-panel="'+narrowKey+'"] [data-message-back]').first().evaluate(node=>node===document.activeElement),true,'opening the prechecked first row transfers focus into its detail');
    await page.locator('[data-message-detail-panel="'+narrowKey+'"] [data-message-back]').click();
    await page.waitForFunction(()=>document.querySelector('.message-workspace')?.dataset.mobileList==='true');
    assert.equal(await page.locator('.message-list').isVisible(),true,'the narrow-screen return control restores the list');
    await page.setViewportSize({width:1440,height:1000});
    const filteredStart=await context.newPage();
    await filteredStart.goto(base+'/messages?profileId='+profileId+'&source=boss&task=all');
    await filteredStart.locator('.message-list-item[data-platform="zhaopin"]').first().waitFor({state:'visible'});
    await filteredStart.close();
    const unresolvedContact=listIncomingContacts(db,{profileId}).find(item=>item.platform==='zhaopin'&&item.conversationKey===zhaopinPendingConversationKey);
    assert(unresolvedContact,'the durable unresolved contact has a profile-scoped contact key');
    const deepLink=await context.newPage();
    await deepLink.goto(base+'/messages?profileId='+profileId+'&source=zhaopin&task=all&contact='+encodeURIComponent(unresolvedContact.key));
    await deepLink.locator('.message-not-found').waitFor({state:'visible'});
    assert.equal(await deepLink.getByText('合成待处理原文',{exact:true}).count(),0,'internal repair content must not be published through a direct link');
    await deepLink.close();
    const missingContact=await context.newPage();
    await missingContact.goto(base+'/messages?profileId='+profileId+'&source=boss&task=all&contact='+encodeURIComponent('sha256:'+ '0'.repeat(64)));
    await missingContact.locator('.message-not-found').waitFor({state:'visible'});
    assert.equal(await missingContact.locator('[data-message-detail-panel]:visible').count(),0,'a missing or cross-platform contact never borrows another editor');
    assert.equal(await missingContact.locator('[data-message-detail-panel]:visible').count(),0,'changing filters must not clear a missing-contact selection lock');
    await missingContact.locator('.message-list-item:visible').first().click();
    await missingContact.locator('[data-message-detail-panel]:visible').waitFor();
    assert.equal(await missingContact.locator('.message-not-found').isVisible(),false,'deliberately choosing another contact dismisses the missing-target state');
    await missingContact.close();
    assert.equal(await page.locator('.message-list-item[data-platform="boss"]').count(),1);assert.equal(await page.locator('.message-list-item[data-platform="zhaopin"]').count(),2);
    assert.equal(await page.locator('.message-unresolved, form[action="/api/message-discovery-unresolved"]').count(),0,'internal repair work has no user-facing rows or actions');
    assert.equal(await page.getByText('待补岗位资料',{exact:true}).count(),0);assert.equal(await page.getByText('合成待处理原文',{exact:true}).count(),0);
    assert.equal(await page.locator('[data-source-filter], [data-task-filter]').count(),0,'the unified inbox has no platform or task filters');
    const zlKey=await zlCard.getAttribute('data-message-detail-panel');const zlRow=page.locator('.message-list-item').filter({has:page.locator('[data-message-view="'+zlKey+'"]')});await zlRow.click();const fields=zlCard.locator('[data-draft-text]'),field=fields.first(),alternativeField=fields.nth(1);await field.fill('可以的，我们继续沟通。');const bossDraftRow=page.locator('.message-list-item[data-platform="boss"]').filter({has:page.locator('[data-message-view^="result-"]')});await bossDraftRow.click();
    await page.reload();await zlRow.click();await zlCard.waitFor({state:'visible'});assert.equal(await field.inputValue(),'可以的，我们继续沟通。');assert.equal(await page.locator('.message-list-item[data-platform="boss"]').count(),1);assert.equal(await page.locator('.message-list-item[data-platform="zhaopin"]').count(),2);assert.equal(await page.locator('[data-send-batch-panel]').isVisible(),false);
    await zlCard.locator('[data-copy-draft]').first().click();await page.waitForFunction(()=>document.querySelector('[data-discovery-feedback]').textContent.includes('记住')||document.querySelector('[data-discovery-feedback]').textContent.includes('已复制'));assert.equal(db.prepare('SELECT COUNT(*) n FROM candidate_progress_events').get().n,before);
    const firstDraftId=Number(await field.getAttribute('data-draft-id')),secondDraftId=Number(await alternativeField.getAttribute('data-draft-id'));let saveMode='fail',failedSaveCount=0,finishFailedSaves;const failedSavesFinished=new Promise(resolve=>{finishFailedSaves=resolve;});let startSecondSave,secondSaveDeferred=false,releaseSecondSave=()=>{},finishLatestFailure;const secondSaveStarted=new Promise(resolve=>{startSecondSave=resolve;}),latestFailureFinished=new Promise(resolve=>{finishLatestFailure=resolve;});await page.route('**/api/message-reply-draft',async route=>{const body=route.request().postDataJSON();if(saveMode==='fail'){await route.fulfill({status:500,contentType:'application/json',body:'{"errorCode":"SAVE_FAILED"}'});failedSaveCount+=1;if(failedSaveCount===2)finishFailedSaves();return;}if(saveMode==='group-race'&&body.draftId===secondDraftId&&!secondSaveDeferred){secondSaveDeferred=true;startSecondSave();await new Promise(resolve=>{releaseSecondSave=resolve;});return route.continue();}if(saveMode==='group-race'&&body.draftId===firstDraftId&&body.text==='整组等待期间的第二版'){await route.fulfill({status:500,contentType:'application/json',body:'{"errorCode":"SAVE_FAILED"}'});finishLatestFailure();return;}return route.continue();});await field.fill('保存失败时保留的回答');await bossDraftRow.click();await failedSavesFinished;await page.waitForFunction(()=>document.querySelector('[data-discovery-feedback]').textContent==='当前草稿未能保存，已保留当前消息，请稍后重试。');assert.equal(await field.inputValue(),'保存失败时保留的回答');assert.equal(await zlCard.isVisible(),true);assert.equal(await zlRow.locator('[data-message-view]').isChecked(),true);await page.setViewportSize({width:584,height:694});await page.locator('.message-detail [data-message-back]:visible').click();await page.waitForFunction(id=>document.querySelector('[data-discovery-feedback]').textContent==='当前草稿未能保存，已保留当前消息，请稍后重试。'&&document.querySelector('[data-draft-id="'+id+'"]')===document.activeElement,firstDraftId);assert.equal(await zlCard.isVisible(),true,'a failed narrow-screen return keeps the current detail visible');assert.equal(await field.evaluate(node=>node===document.activeElement),true,'a failed narrow-screen return restores focus to the unsaved draft');await page.setViewportSize({width:1440,height:1000});saveMode='pass';
    await field.fill('整组保存的第一版');saveMode='group-race';await bossDraftRow.click();await secondSaveStarted;for(let attempt=0;attempt<100&&storage.getMessageReplyDraft(db,{profileId,draftId:firstDraftId}).currentText!=='整组保存的第一版';attempt++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(storage.getMessageReplyDraft(db,{profileId,draftId:firstDraftId}).currentText,'整组保存的第一版');await field.fill('整组等待期间的第二版');releaseSecondSave();await latestFailureFinished;await page.waitForFunction(id=>document.querySelector('[data-draft-save-status="'+id+'"]').textContent==='保存失败，请重试',firstDraftId);assert.equal(await field.inputValue(),'整组等待期间的第二版');assert.equal(await zlCard.isVisible(),true,'a failed edit made while another draft saves must keep the original message visible');assert.equal(await zlRow.locator('[data-message-view]').isChecked(),true);saveMode='pass';
    const selectedZlKey=await zlRow.locator('[data-message-view]').getAttribute('data-message-view');await page.reload();assert.equal(await page.locator('[data-message-view="'+selectedZlKey+'"]').isChecked(),true);
    recordUnresolvedMessageDiscoveryItem(db,{profileId,platform:'zhaopin',conversationKey:digest('newer-zhaopin-pending'),previewDigest:digest('newer-zhaopin-preview'),previewKind:'possible_hr_reply',observedAt:'2026-09-08T03:00:00.000Z',sourceJobId:'zhaopin:CCL1234567890J0088888888',lastMessageId:'202609080300',reasonCode:'MESSAGE_DISCOVERY_JOB_CONTEXT_UNAVAILABLE',identity:{positionTitle:'后来新增的待处理岗位',company:'另一合成公司'},inboundMessages:[{kind:'text',text:'后来新增的合成原文'}]});
    await page.reload();assert.equal(await page.getByText('后来新增的待处理岗位',{exact:true}).count(),0);assert.equal(await page.getByText('后来新增的合成原文',{exact:true}).count(),0);
    await zlRow.click();await field.fill('快速切换前保存的回答');const bossResultRow=page.locator('.message-list-item[data-platform="boss"]').filter({has:page.locator('[data-message-view^="result-"]')});await bossResultRow.click();await zlRow.click();await page.waitForFunction(key=>{const checked=document.querySelector('[data-message-view]:checked');const visible=document.querySelector('[data-message-detail-panel]:not([hidden])');return checked&&visible&&checked.dataset.messageView===key&&visible.dataset.messageDetailPanel===key;},selectedZlKey);for(let attempt=0;attempt<100&&storage.getMessageReplyDraft(db,{profileId,draftId:zl.drafts[0].id}).currentText!=='快速切换前保存的回答';attempt++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(storage.getMessageReplyDraft(db,{profileId,draftId:zl.drafts[0].id}).currentText,'快速切换前保存的回答');
    await page.reload();const selectedKey=await page.locator('[data-message-view]:checked').getAttribute('data-message-view');assert.equal(await page.locator('[data-message-detail-panel="'+selectedKey+'"]').isVisible(),true);assert.equal(await page.getByText('历史待核对岗位',{exact:true}).count(),0);assert.equal(await page.locator('form[action="/api/message-discovery-unresolved"]').count(),0);
    const evidence='D:/DevData/RoleFlow-zhaopin-messages-20260908';fs.mkdirSync(evidence,{recursive:true});for(const width of [1440,390]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:path.join(evidence,'unified-messages-'+width+'.png'),fullPage:true});}
    assert.equal(await page.locator('[data-source-filter], [data-task-filter]').count(),0);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM candidate_answer_memories WHERE profile_id=? AND final_text=? AND completion_kind='copied'").get(profileId,'可以的，我们继续沟通。').n,1,'edited copy teaches the answer without sent progress');
    assert.equal(httpBrowserCalls,0,'inbox navigation and copying cannot start discovery');
    db.prepare("UPDATE candidate_progress_cards SET source='unknown' WHERE id=?").run(boss.cardId);
    const unknownPage=await context.newPage();await unknownPage.goto(base+'/messages?profileId='+profileId);const unknownCard=unknownPage.locator('[data-message-detail-panel][data-platform=""]');assert.equal(await unknownCard.count(),1);assert.equal(await unknownCard.locator('[data-send-single], [data-send-select], [data-sent-draft]').count(),0);await unknownPage.close();db.prepare("UPDATE candidate_progress_cards SET source='boss' WHERE id=?").run(boss.cardId);
    await today.click();await page.waitForURL('**/plan?**');assert.equal(new URL(page.url()).searchParams.get('site'),'zhaopin');
    const dismiss=await fetch(base+'/api/message-discovery',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'dismiss',profileId})});assert.equal(dismiss.status,200);
    const cleared=createMessageDiscoveryController({db});assert.equal(cleared.pageState(profileId).results.length,0);assert.equal(storage.listMessageInboundContexts(db,{profileId}).length,0);assert.equal(cleared.pageState(profileId).unresolved,3,'dismiss preserves every unprocessed pending message');await cleared.close();
    await page.getByRole('link',{name:'消息与回复',exact:true}).click();assert.equal(await page.getByText('合成待处理原文',{exact:true}).count(),0);assert.equal(await page.getByText('历史待核对岗位',{exact:true}).count(),0);
    db.prepare("DELETE FROM message_discovery_unresolved_items WHERE profile_id=? AND platform='zhaopin'").run(profileId);await page.reload();assert.equal(await page.locator('.message-list-item[data-platform="zhaopin"]').count(),0);assert.equal(await page.locator('.message-list-item[data-platform="boss"]').count(),0);
    await page.getByRole('button',{name:'同步最新消息',exact:true}).click();
    let completedStatus;for(let attempt=0;attempt<100;attempt++){completedStatus=await (await fetch(base+'/api/message-discovery-status?profileId='+profileId)).json();if(completedStatus.status!=='running')break;await new Promise(resolve=>setTimeout(resolve,5));}
    assert.equal(completedStatus.status,'completed');assert.equal(completedStatus.unresolved,0);assert.equal(completedStatus.reasonCode,'');assert(completedStatus.startedAt);
    await page.waitForFunction(()=>document.querySelector('.message-read-details')?.textContent.includes('已分析回复'));
    const completedState=await page.locator('.message-read-details').textContent();assert.doesNotMatch(completedState,/未解决|保留记录|无法确认本地岗位与会话是否一致/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM message_discovery_unresolved_items WHERE profile_id=? AND conversation_key=?').get(profileId,historicalConversationKey).n,1,'the successful current run must retain the old BOSS row');
    const historicalRow=page.locator('.message-list-item[data-platform="boss"]',{hasText:'历史待核对岗位'});
    assert.equal(await historicalRow.count(),0,'old unresolved BOSS work remains internal after a successful sync');
    assert.equal(await page.locator('[data-source-filter], [data-task-filter]').count(),0);
    await page.reload();assert.equal(await historicalRow.count(),0);assert.equal(db.prepare('SELECT COUNT(*) n FROM message_discovery_unresolved_items WHERE profile_id=? AND conversation_key=?').get(profileId,historicalConversationKey).n,1);
    httpReaderShouldWait=true;
    await page.getByRole('button',{name:'同步最新消息',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('button[data-page-primary]')||document.querySelector('button[data-page-primary]').disabled);await page.getByRole('button',{name:'安全停止',exact:true}).waitFor({state:'visible'});
    await page.waitForFunction(()=>Array.from(document.querySelectorAll('form[data-discovery-form]')).find(form=>form.querySelector('[name=action]').value==='stop').querySelector('button').disabled===false);
    assert.match(await page.locator('main').innerText(),/正在加载并读取消息/);assert.equal(httpBossCalls,0);assert.equal(httpReaderCalls,2);
    await page.getByRole('button',{name:'安全停止',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.message-state h2')?.textContent==='已安全停止');assert.equal(httpBrowserCalls,2);
    const stoppedStatus=await (await fetch(base+'/api/message-discovery-status?profileId='+profileId)).json();assert.equal(stoppedStatus.status,'stopped');assert.equal(stoppedStatus.unresolved,0);assert.equal(stoppedStatus.reasonCode,'MESSAGE_DISCOVERY_STOPPED');
    const stoppedState=await page.locator('.message-state').innerText();assert.match(stoppedState,/已按你的操作安全停止/);assert.doesNotMatch(stoppedState,/无法确认本地岗位与会话是否一致/);assert.equal(await historicalRow.count(),0);
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    await contactFiltersAndHistory(context, base, db);
    await activeBatchRemainsStoppableInUnifiedInbox(chromium);
    console.log('dashboard_unified_messages_journey ok: serial discovery, restore, source-safe HTTP/UI, autosave, unified inbox navigation, 1440/390, active BOSS stop after reload');
  }finally{if(browser)await browser.close();if(server)await new Promise(r=>server.close(r));for(const controller of controllers)await controller.close();db.close();fs.rmSync(root,{recursive:true,force:true});}
}
async function contactFiltersAndHistory(context, base, db) {
  const profileId = Number(db.prepare("INSERT INTO candidate_profiles(display_name,profile_json,created_at,updated_at) VALUES ('筛选合成候选人','{}',?,?)").run(NOW,NOW).lastInsertRowid);
  const planId = Number(db.prepare("INSERT INTO search_plans(profile_id,name,plan_json,is_active,created_at,updated_at) VALUES (?,'合成计划','{}',1,?,?)").run(profileId,NOW,NOW).lastInsertRowid);
  const boss = seed(db, 'boss', profileId, planId, false, '6');
  const manual = seed(db, 'zhaopin', profileId, planId, true, '7');
  const bossKey = listIncomingContacts(db,{profileId}).find(item => item.cardId === boss.cardId).conversationKey;
  recordUnresolvedMessageDiscoveryItem(db,{profileId,platform:'boss',conversationKey:bossKey,previewDigest:digest('duplicate-result-preview'),previewKind:'possible_hr_reply',observedAt:NOW,reasonCode:'BOSS_MESSAGE_CARD_NOT_FOUND',identity:{positionTitle:'同名岗位',company:'合成公司'}});
  const manualKey = listIncomingContacts(db,{profileId}).find(item => item.cardId === manual.cardId).conversationKey;
  db.prepare('UPDATE candidate_progress_cards SET thread_key=? WHERE id=?').run(manualKey, manual.cardId);
  const event = (cardId, type, platform, threadKey) => db.prepare("INSERT INTO candidate_progress_events(card_id,idempotency_key,type,actor,summary,metadata_json,occurred_at,created_at) VALUES (?,?,?,'system','',?,?,?)").run(cardId,'filter-'+cardId+'-'+type,type,JSON.stringify({platform,threadKey}),NOW,NOW);
  event(manual.cardId,'interview_invited','zhaopin',manualKey);
  const historyKey = digest('history-filter-contact');
  const historyJob = Number(db.prepare("INSERT INTO jobs(source,source_id,title,company,first_seen_at,last_seen_at) VALUES ('boss','boss:history-filter','历史机会','合成公司',?,?)").run(NOW,NOW).lastInsertRowid);
  const historyCard = Number(db.prepare("INSERT INTO candidate_progress_cards(profile_id,plan_id,job_id,source,thread_key,stage,next_action,last_event_at,created_at,updated_at) VALUES (?,?,?,'boss',?,'replied','',?,?,?)").run(profileId,planId,historyJob,historyKey,NOW,NOW,NOW).lastInsertRowid);
  event(historyCard,'resume_requested','boss',historyKey);
  event(historyCard,'interview_invited','boss',historyKey);
  const pendingKey = digest('pending-resume-contact');
  const pendingJob = Number(db.prepare("INSERT INTO jobs(source,source_id,title,company,first_seen_at,last_seen_at) VALUES ('zhaopin','zhaopin:pending-resume','待确认简历岗位','待确认公司',?,?)").run(NOW,NOW).lastInsertRowid);
  const pendingCard = Number(db.prepare("INSERT INTO candidate_progress_cards(profile_id,plan_id,job_id,source,thread_key,stage,next_action,last_event_at,created_at,updated_at) VALUES (?,?,?,'zhaopin',?,'replied','',?,?,?)").run(profileId,planId,pendingJob,pendingKey,NOW,NOW,NOW).lastInsertRowid);
  event(pendingCard,'resume_requested','zhaopin',pendingKey);
  upsertMessageInboxItem(db, {
    profileId, platform: 'zhaopin', conversationKey: pendingKey, sourceJobId: 'zhaopin:pending-resume',
    jobId: pendingJob, cardId: pendingCard, lastMessageId: 'pending-resume-message', lastActivityAt: NOW,
    lastDirection: 'friend', unread: true, positionTitle: '待确认简历岗位', company: '待确认公司',
    latestExcerpt: 'HR 邀请你发送简历', actionGroup: 'needs_action', actionCode: 'resume_request', observedAt: NOW
  });
  const contacts = listIncomingContacts(db,{profileId});
  const history = contacts.find(item=>item.conversationKey===historyKey);
  const page = await context.newPage();
  try {
    await page.setViewportSize({width:390,height:694});
    await page.goto(base+'/messages?profileId='+profileId+'&source=all&task=pending');
    assert.equal(await page.locator('.message-list-item').count(),4,'the unified inbox keeps pending work and completed history in one page');
    assert.equal(await page.locator('.message-list-item:visible').count(),3,'unfinished resume confirmation remains visible while completed history stays collapsed');
    assert.equal(await page.locator('[data-action-group="needs_action"] .message-list-item',{hasText:'待确认简历岗位'}).count(),1,'the current inbox state must outrank the historical contact projection');
    const firstRow = page.locator('.message-list-item:visible').first();
    assert((await firstRow.boundingBox()).y+100<=694,'390px viewport exposes the first message and HR preview');
    const draftRow = page.locator('.message-list-item[data-platform="boss"]:visible').filter({has:page.locator('[data-message-view^="result-"]')});
    await draftRow.locator('[data-message-view]').focus();await page.keyboard.press('Space');
    // A prechecked radio does not emit change; keyboard activation must still open it.
    await page.locator('.message-detail').waitFor({state:'visible'});
    assert.equal(await page.locator('[data-message-detail-panel]:visible [data-draft-text]').count(),1,'merged contact preserves its open draft');
    assert.equal(await page.locator('[data-message-detail-panel]:visible form[action="/api/message-discovery-unresolved"]').count(),0,'merged contacts do not expose internal association work');
    await page.setViewportSize({width:420,height:694});
    assert.equal(await page.locator('.message-detail').isVisible(),true,'same-breakpoint resize preserves detail');
    await page.locator('[data-message-back]:visible').click();
    await page.waitForFunction(()=>document.querySelector('.message-workspace').dataset.mobileList==='true');
    assert.equal(await page.locator('[data-message-view]:checked').evaluate(node=>node===document.activeElement),true,'return restores keyboard focus to the selected row');
    await page.setViewportSize({width:1440,height:1000});
    assert.equal(await page.getByRole('heading',{name:/现在需要你处理/}).count(),1);
    assert.equal(await page.getByRole('heading',{name:/系统正在补充资料/}).count(),0);
    assert.equal(await page.locator('details.message-action-group>summary',{hasText:'已结束记录'}).count(),1,'completed history is collapsed instead of requiring a filter');
    await page.goto(base+'/messages?profileId='+profileId+'&source=boss&task=all&contact='+encodeURIComponent(history.key));
    assert.equal(await page.locator('.message-history:visible').count(),1);
    assert.match(await page.locator('.message-history:visible').innerText(),/已记录这次联系，完整内容会在下次同步后显示/);
    assert.equal(await page.locator('.message-history [data-draft-text], .message-history [data-send-single]').count(),0,'history never reconstructs a draft or send action');
    await page.locator('.message-list-item[data-platform="zhaopin"]').first().waitFor({state:'visible'});
    await page.goto(base+'/messages?profileId='+profileId+'&source=zhaopin&task=all&contact='+encodeURIComponent(history.key));
    assert.equal(await page.locator('.message-history:visible').count(),1,'platform query parameters no longer hide a known conversation from the unified inbox');
    await page.goto(base+'/messages?profileId=1&source=all&task=all&contact='+encodeURIComponent(history.key));
    assert.equal(await page.locator('[data-message-detail-panel]:visible').count(),0,'a foreign-profile contact cannot select an unrelated editor');
  } finally { await page.close(); }
}
async function activeBatchRemainsStoppableInUnifiedInbox(chromium) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roleflow-unified-active-send-'));
  const dbPath = path.join(root, 'fixture.sqlite');
  const db = storage.openDb(dbPath);
  const token = 'unified-active-send-fixture';
  let server, browser, base, profileId, batchId;
  let inspections = 0, writes = 0, browserCreations = 0;
  let disconnectedResolve;
  const disconnected = new Promise(resolve => { disconnectedResolve = resolve; });
  try {
    profileId = Number(db.prepare("INSERT INTO candidate_profiles(display_name,profile_json,created_at,updated_at) VALUES ('合成候选人','{}',?,?)").run(NOW,NOW).lastInsertRowid);
    const planId = Number(db.prepare("INSERT INTO search_plans(profile_id,name,plan_json,is_active,created_at,updated_at) VALUES (?,'合成计划','{}',1,?,?)").run(profileId,NOW,NOW).lastInsertRowid);
    for (const suffix of ['1', '2', '3']) seed(db, 'boss', profileId, planId, false, suffix);
    const zl = seed(db, 'zhaopin', profileId, planId);
    server = createDashboardServer({
      db, dbPath, root, dataRoot: root, forceMock: true, logger, messageReplyActionToken: token,
      browserAuthority: { browserMode: 'portable', cdpPort: 9222, profilePath: path.join(root, 'profile') },
      browserFactory: () => { browserCreations++; return { async disconnect() { disconnectedResolve(); } }; },
      messageReplySendDependencies: {
        createReader: () => ({}),
        createAccessController: () => ({ async reserve() {} }),
        createSender: () => ({
          async inspectReplyTarget(item, signal) {
            inspections++;
            assert.equal(db.prepare('SELECT source FROM jobs WHERE id=?').get(item.jobId).source, 'boss');
            await new Promise(resolve => signal.aborted ? resolve() : signal.addEventListener('abort', resolve, { once: true }));
            return {};
          },
          async fillReply() { writes++; return {}; },
          async dispatchReply() { writes++; },
          async verifyReplyResult() { return { state: 'succeeded' }; },
          async clearPreparedReply() { writes++; }
        })
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [], external = [], mutations = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== base) { external.push(request.url()); return route.abort(); }
      if (request.method() === 'POST') mutations.push(url.pathname);
      return route.continue();
    });
    await page.goto(base + '/messages?profileId=' + profileId);
    assert.equal(await page.locator('.message-send-choice:visible').count(),0,'BOSS send selection stays hidden until explicit batch entry');
    await page.locator('[data-send-batch-enter]').click();
    const bossRows=page.locator('.message-list-item[data-platform="boss"]');
    for(let index=0;index<await bossRows.count();index++){const viewKey=await bossRows.nth(index).locator('[data-message-view]').getAttribute('data-message-view');await bossRows.nth(index).click();const choice=page.locator('[data-message-detail-panel="'+viewKey+'"] [data-send-select]');await choice.waitFor({state:'visible'});await choice.check();}
    await page.locator('[data-send-batch]').click();
    await page.locator('[data-send-stop]').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('[data-send-batch-panel]').dataset.state === 'running');
    batchId = db.prepare('SELECT id FROM message_reply_send_batches').get().id;
    assert.deepEqual(db.prepare('SELECT status FROM message_reply_send_items ORDER BY id').all().map(item => item.status), ['selecting', 'pending', 'pending']);
    assert.equal(await page.locator('[data-send-stop]').isVisible(), true, 'the unified inbox must retain the active BOSS stop control');
    assert.equal(await page.locator('[data-send-stop]').isEnabled(), true);
    assert.equal(await page.locator('[data-send-batch]').isVisible(), false, 'an active batch cannot start another batch');
    assert.match(await page.locator('[data-send-batch-title]').innerText(), /0 \/ 3/);
    const field = page.locator('[data-message-detail-panel][data-platform="zhaopin"] [data-draft-text]');
    const zhaopinRow = page.locator('.message-list-item[data-platform="zhaopin"]').filter({has:page.locator('[data-message-view^="result-"]')});
    await zhaopinRow.click();
    await field.fill('统一收件箱仍保存智联草稿');
    await bossRows.first().click();
    await page.reload();
    assert.equal(await field.inputValue(), '统一收件箱仍保存智联草稿');
    assert.equal(await page.locator('[data-send-stop]').isVisible(), true, 'reload must retain the restored active stop control');
    assert.equal(await page.locator('[data-send-stop]').isEnabled(), true);
    const stopContrast = await page.locator('[data-send-stop]').evaluate(button => {
      const style = getComputedStyle(button);
      const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
      const foreground = luminance(style.color), background = luminance(style.backgroundColor);
      return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
    });
    assert(stopContrast >= 4.5, 'the restored stop label must be readable against its button background');
    assert.equal(await page.locator('[data-send-batch]').isVisible(), false);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM message_reply_send_batches').get().n, 1, 'inbox navigation and reload cannot authorize another batch');
    assert.equal(inspections, 1);
    assert.equal(writes, 0);
    assert.deepEqual(mutations.filter(route => route !== '/api/message-reply-draft'), ['/api/message-reply-send-batch']);
    await page.screenshot({ path: 'D:/DevData/RoleFlow-zhaopin-messages-20260908/unified-active-boss-zhaopin-filter.png', fullPage: true });
    await page.getByRole('button', { name: '停止后续发送', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-send-batch-panel]').dataset.state === 'stopped');
    await disconnected;
    assert.deepEqual(db.prepare('SELECT status, click_count FROM message_reply_send_items ORDER BY id').all().map(item => ({ ...item })), Array.from({ length: 3 }, () => ({ status: 'stopped', click_count: 0 })));
    assert.equal(inspections, 1, 'the two pending conversations must never be inspected');
    assert.equal(writes, 0, 'stop before first fill prevents all sender writes');
    assert.equal(browserCreations, 1);
    assert.deepEqual(mutations.filter(route => route !== '/api/message-reply-draft'), ['/api/message-reply-send-batch', '/api/message-reply-send-control']);
    for (const table of ['candidate_progress_events', 'candidate_answer_memories', 'candidate_funnel_entries']) assert.equal(db.prepare('SELECT COUNT(*) n FROM ' + table).get().n, 0);
    assert.equal(storage.getMessageReplyDraft(db, { profileId, draftId: zl.drafts[0].id }).currentText, '统一收件箱仍保存智联草稿');
    assert.equal(await page.locator('[data-send-batch-panel]').isVisible(), false, 'a terminal batch returns to the compact inbox state');
    await page.locator('[data-send-batch-enter]').waitFor({state:'visible'});
    assert.equal(await page.locator('[data-send-batch-panel]').isVisible(), false, 'after a terminal batch, BOSS returns to the compact explicit entry instead of an idle status panel');
    assert.equal(await page.locator('[data-send-stop]').isVisible(), false);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
  } finally {
    if (batchId && ['confirmed', 'running'].includes(db.prepare('SELECT status FROM message_reply_send_batches WHERE id=?').get(batchId).status)) await fetch(base + '/api/message-reply-send-control', { method: 'POST', headers: { 'content-type': 'application/json', 'x-roleflow-action': token }, body: JSON.stringify({ profileId, batchId, action: 'stop' }) });
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});

const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const storage = require('../src/core/storage');
const inbox = require('../src/storage/message_inbox_store');
const timeline = require('../src/storage/message_timeline_store');
const { ensureProgressCard, transitionProgressCard, recordManualProgressAction } = require('../src/core/candidate_progress');
const { renderMessageDiscoveryPage } = require('../src/dashboard/message_discovery_view');
const { buildMessageInboxPageState, createMessageDiscoveryController } = require('../src/dashboard/message_discovery_controller');
const { createMessageReplySendingService } = require('../src/application/message_reply_sending');
const { runMessageReplySendBatch } = require('../src/core/message_reply_send_executor');
const { answerMissingMessageFact } = require('../src/application/message_discovery/answer_fact');
const { runBossMessageDiscovery } = require('../src/application/message_discovery/run');
const { createDashboardServer } = require('../src/dashboard/server');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const NOW = '2026-10-08T08:00:00.000Z';
const DAY = 86400000;
const at = days => new Date(Date.parse(NOW) - days * DAY).toISOString();
const digest = text => 'sha256:' + createHash('sha256').update(text).digest('hex');
function seed(db, name, date, { group = 'needs_action', direction = 'friend', platform = 'boss' } = {}) {
  const profileId = Number(db.prepare("INSERT INTO candidate_profiles(display_name,profile_json,created_at,updated_at) VALUES ('测试候选人','{}',?,?)").run(at(30),NOW).lastInsertRowid);
  const planId = Number(db.prepare("INSERT INTO search_plans(profile_id,name,plan_json,is_active,created_at,updated_at) VALUES (?,'测试方案','{}',1,?,?)").run(profileId,at(30),NOW).lastInsertRowid);
  const sourceId = platform === 'boss' ? 'boss:expiry-' + name : 'zhaopin:ZL123456' + profileId;
  const jobId = Number(db.prepare('INSERT INTO jobs(source,source_id,title,first_seen_at,last_seen_at) VALUES (?,?,?,?,?)').run(platform,sourceId,name,at(30),NOW).lastInsertRowid);
  db.prepare('UPDATE jobs SET description=?,analysis_json=? WHERE id=?').run('负责核对订单接口输入、记录测试结果、跟进开发协作并复盘交付问题。'.repeat(6),JSON.stringify({semanticStatus:'complete',recommendation:'recommended',recommendationSchemaVersion:2}),jobId);
  const card = ensureProgressCard(db,{profileId,planId,jobId,source:platform,now:at(30)});
  const conversationKey=digest(name), messageGroupKey=digest('group-'+name);
  const draft=storage.recordMessageReplyDrafts(db,{profileId,cardId:card.id,jobId,messageGroupKey,questionSummary:'确认到岗时间',messageIntent:'information_request',messageCategory:'availability',messages:['需要确认后才能答复'],createdAt:date})[0];
  storage.saveMessageInboundContext(db,{profileId,platform,cardId:card.id,messageGroupKey,conversationKey,sourceJobId:sourceId,lastMessageId:'378917037748750',messageIntent:'information_request',messageCategory:'availability',inboundMessages:[{kind:'text',text:'什么时候可以到岗？'}],createdAt:date,updatedAt:NOW});
  inbox.upsertMessageInboxItem(db,{profileId,platform,conversationKey,sourceJobId:sourceId,jobId,cardId:card.id,lastMessageId:'378917037748750',lastActivityAt:date,lastDirection:direction,actionGroup:group,actionCode:'reply',observedAt:at(30)});
  timeline.upsertMessageEvents(db,{profileId,platform,conversationKey,observedAt:NOW,events:[{messageKey:digest('msg-'+name),platformMessageId:'378917037748750',direction,kind:'text',text:'什么时候可以到岗？',occurredAt:date}]});
  return {profileId,cardId:card.id,conversationKey,draft,messageGroupKey};
}
async function pageAndConfirm(db) {
  const old=seed(db,'old',at(8));
  const page=buildMessageInboxPageState(db,{profileId:old.profileId,now:NOW});
  assert.equal(page.counts.needsAction,0,'opening the page without syncing must end processing of an eight-day-old unanswered message');
  assert.equal(page.groups.done[0].reasonCode,'MESSAGE_REPLY_WINDOW_EXPIRED');
  assert.equal(inbox.getMessageInboxItem(db,{profileId:old.profileId,platform:'boss',conversationKey:old.conversationKey}).lastActivityAt,at(8),'expiry projection must preserve message history');
}
async function confirmWithoutSync(db) {
  const old=seed(db,'old-confirm',at(8));
  let executions=0;
  const service=createMessageReplySendingService({db,learningService:{completeDraft(){}},now:()=>NOW,executeBatch(){executions++;}});
  assert.throws(()=>service.confirmBatch({profileId:old.profileId,items:[{draftId:old.draft.id,revision:old.draft.revision}]}),e=>e.code==='MESSAGE_REPLY_WINDOW_EXPIRED');
  await Promise.resolve();
  assert.equal(executions,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM message_reply_send_batches').get().n,0);
}
async function legacyPage(db) {
  const old=seed(db,'legacy-page',at(8));
  inbox.deleteMessageInboxItem(db,{profileId:old.profileId,platform:'boss',conversationKey:old.conversationKey});
  const state=createMessageDiscoveryController({db,now:()=>new Date(NOW)}).pageState(old.profileId);
  assert.equal(state.results.length,1);
  assert.equal(state.results[0].legacyActionExpired,true,'legacy open drafts without an inbox row must not expose processing controls');
}
async function futureLegacyInterview(db) {
  const scheduled=seed(db,'future-legacy',at(20),{group:'waiting',direction:'myself'});
  inbox.deleteMessageInboxItem(db,{profileId:scheduled.profileId,platform:'boss',conversationKey:scheduled.conversationKey});
  transitionProgressCard(db,{cardId:scheduled.cardId,expectedStage:'contact_started',stage:'needs_user_action',now:at(20)});
  recordManualProgressAction(db,{cardId:scheduled.cardId,idempotencyKey:'progress:'+randomUUID(),stage:'interview_scheduled',eventType:'interview_scheduled',summary:'已确认10月11日面试',scheduledAt:new Date(Date.parse(NOW)+3*DAY).toISOString(),now:at(1)});
  const result=createMessageDiscoveryController({db,now:()=>new Date(NOW)}).pageState(scheduled.profileId).results[0];
  assert.equal(result.stage,'interview_scheduled');
  assert.notEqual(result.legacyActionExpired,true,'a confirmed future interview must not expire from an old message date');
  assert.equal(result.legacyWaitingForRecruiter,true,'a scheduled legacy appointment must show waiting rather than an old reply task');
  const controller=createMessageDiscoveryController({db,now:()=>new Date(NOW)});
  const markup=renderMessageDiscoveryPage({db,searchParams:new URLSearchParams({profileId:scheduled.profileId}),controller,
    helpers:{getCandidateProfile:()=>({}),renderFramedPage:({content})=>content,escapeHtml:String,escapeAttr:String,newProgressRequestKey:()=> 'future-test'}});
  assert.match(markup,/面试已确认，安排时间：10\/11 16:00/);
  assert.doesNotMatch(markup,/data-send-single|data-send-select|value="answer_fact"|超过 7 天/);
  assert.match(markup,/data-action-group="waiting"/);
}
async function scheduledInbox(db) {
  const scheduled=seed(db,'future-inbox',at(20));
  transitionProgressCard(db,{cardId:scheduled.cardId,expectedStage:'contact_started',stage:'needs_user_action',now:at(20)});
  recordManualProgressAction(db,{cardId:scheduled.cardId,idempotencyKey:'progress:'+randomUUID(),stage:'interview_scheduled',eventType:'interview_scheduled',summary:'已确认10月11日面试',scheduledAt:new Date(Date.parse(NOW)+3*DAY).toISOString(),now:at(1)});
  const page=buildMessageInboxPageState(db,{profileId:scheduled.profileId,now:NOW});
  assert.equal(page.counts.waiting,1,'an explicit future interview confirmation must take precedence over an old pending inbox row');
  assert.equal(page.counts.done,0);
  await runBossMessageDiscovery({db,profileId:scheduled.profileId,reader:{async scanConversationRows(){return {tabId:'fake',rows:[]};}},
    classifyMessageGroup:async()=>{throw new Error('no new messages');},now:()=>NOW,sleepFn:async()=>{}});
  assert.notEqual(inbox.getMessageInboxItem(db,{profileId:scheduled.profileId,platform:'boss',conversationKey:scheduled.conversationKey}).reasonCode,'MESSAGE_REPLY_WINDOW_EXPIRED','sync must preserve the future confirmed arrangement too');
  inbox.upsertMessageInboxItem(db,{profileId:scheduled.profileId,platform:'boss',conversationKey:scheduled.conversationKey,cardId:scheduled.cardId,
    lastActivityAt:NOW,lastDirection:'friend',actionGroup:'needs_action',actionCode:'reply',observedAt:NOW});
  assert.equal(buildMessageInboxPageState(db,{profileId:scheduled.profileId,now:NOW}).counts.needsAction,1,'a newer HR question after confirming an interview must remain actionable');
}
async function oldFactForm(db) {
  const old=seed(db,'fact-form',at(8));
  db.prepare("INSERT INTO candidate_progress_events(card_id,idempotency_key,type,actor,summary,metadata_json,occurred_at,created_at) VALUES (?,?,'message_group_classified','system','确认到岗时间',?,?,?)")
    .run(old.cardId,'expiry-fact-form',JSON.stringify({messageGroupKey:old.messageGroupKey,missingFactKey:'availability_date',missingFactQuestion:'何时到岗'}),at(8),at(8));
  let calls=0;
  await assert.rejects(()=>answerMissingMessageFact({db,profileId:old.profileId,cardId:old.cardId,messageGroupKey:old.messageGroupKey,factKey:'availability_date',factValue:'录用后一周内到岗',now:()=>NOW,
    classifyMessageGroup:async()=>{calls++;throw new Error('MODEL_SHOULD_NOT_RUN');}}),e=>e.code==='MESSAGE_REPLY_WINDOW_EXPIRED');
  assert.equal(calls,0);
  assert.equal(storage.listCandidateFacts(db,old.profileId).length,0,'a stale form must not save facts or regenerate an expired reply');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'offergo-expiry-api-'));
  let server;
  try {
    server=createDashboardServer({db,root,dataRoot:root,forceMock:true,
      browserAuthority:{browserMode:'portable',cdpPort:9222,profilePath:path.join(root,'profile')},
      messageDiscoveryDependencies:{now:()=>new Date(NOW),modelReady:()=>true,getModelConfig:()=>({provider:'mock',providers:{mock:{}}}),
        createAnalyzer:()=>async()=>{calls++;throw new Error('MODEL_SHOULD_NOT_RUN');}}});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/message-discovery`,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({action:'answer_fact',profileId:old.profileId,cardId:old.cardId,messageGroupKey:old.messageGroupKey,factKey:'availability_date',factValue:'录用后一周内到岗'})});
    const body=await response.json();
    assert.equal(response.status,409);
    assert.equal(body.errorCode,'MESSAGE_REPLY_WINDOW_EXPIRED');
    assert.match(body.error,/超过一周未回复，不再生成回复草稿/);
    assert.equal(calls,0);
    assert.equal(storage.listCandidateFacts(db,old.profileId).length,0);
  } finally {
    if(server) await new Promise(resolve=>server.close(resolve));
    assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));
    fs.rmSync(root,{recursive:true,force:true});
  }
}
async function controls(db) {
  for(const platform of ['boss','zhaopin']) {
    const boundary=seed(db,'boundary-'+platform,at(7),{platform});
    assert.equal(buildMessageInboxPageState(db,{profileId:boundary.profileId,now:NOW}).counts.needsAction,1);
    storage.createMessageReplySendBatch(db,{profileId:boundary.profileId,items:[{draftId:boundary.draft.id,revision:boundary.draft.revision}],createdAt:NOW});
    const recent=seed(db,'recent-'+platform,at(1),{platform});
    assert.equal(buildMessageInboxPageState(db,{profileId:recent.profileId,now:NOW}).counts.needsAction,1,'a new HR message must not expire by the old conversation first date');
    const scheduled=seed(db,'scheduled-'+platform,at(20),{platform,group:'waiting',direction:'myself'});
    db.prepare("UPDATE candidate_progress_cards SET stage='interview_scheduled',scheduled_at=? WHERE id=?").run(new Date(Date.parse(NOW)+3*DAY).toISOString(),scheduled.cardId);
    timeline.upsertMessageEvents(db,{profileId:scheduled.profileId,platform,conversationKey:scheduled.conversationKey,observedAt:at(20),events:[{
      messageKey:digest('confirmed-'+platform),platformMessageId:'378917037748751',direction:'myself',kind:'text',text:'已确认，10月11日上午10点参加面试。',occurredAt:at(20)}]});
    const page=buildMessageInboxPageState(db,{profileId:scheduled.profileId,now:NOW});
    assert.equal(page.counts.waiting,1,'a confirmed future interview must remain waiting');
    assert.equal(page.groups.waiting[0].reasonCode,'');
  }
}
async function delayedBatch(db) {
  const old=seed(db,'delayed',at(8));
  const batch=storage.createMessageReplySendBatch(db,{profileId:old.profileId,items:[{draftId:old.draft.id,revision:old.draft.revision}],createdAt:at(2)});
  db.prepare('UPDATE message_inbound_contexts SET last_message_id=?,updated_at=? WHERE profile_id=?').run('378917037748751',NOW,old.profileId);
  timeline.upsertMessageEvents(db,{profileId:old.profileId,platform:'boss',conversationKey:old.conversationKey,observedAt:NOW,events:[{
    messageKey:digest('delayed-new-hr'),platformMessageId:'378917037748751',direction:'friend',kind:'text',text:'新的到岗时间问题',occurredAt:at(1)}]});
  let touches=0;
  const result=await runMessageReplySendBatch({db,batchId:batch.batch.id,now:()=>NOW,
    sender:{async inspectReplyTarget(){touches++;},async fillReply(){touches++;},async dispatchReply(){touches++;},async verifyReplyResult(){touches++;},async clearPreparedReply(){}},
    accessController:{async reserve(){touches++;}},onVerifiedSuccess(){},sleepFn:async()=>{}});
  assert.equal(touches,0,'a confirmed batch delayed beyond seven days must stop before touching the platform');
  assert.equal(result.batch.status,'interrupted');
  assert.equal(result.items[0].clickCount,0);
  assert.equal(result.items[0].errorCode,'MESSAGE_REPLY_WINDOW_EXPIRED');
}
async function crossesDuringPreparation(db) {
  const old=seed(db,'crossing',at(8));
  const batch=storage.createMessageReplySendBatch(db,{profileId:old.profileId,items:[{draftId:old.draft.id,revision:old.draft.revision}],createdAt:at(2)});
  let clock=at(2),dispatches=0,clears=0;
  const options={db,batchId:batch.batch.id,now:()=>clock,sender:{async inspectReplyTarget(){return {};},async fillReply(){clock=NOW;return {};},
    async dispatchReply(){dispatches++;},async verifyReplyResult(){throw new Error('must not verify an unsent reply');},async clearPreparedReply(){clears++;}},
    accessController:{async reserve(){}},onVerifiedSuccess(){},sleepFn:async()=>{}};
  const result=await runMessageReplySendBatch(options);
  assert.equal(result.batch.status,'interrupted');
  assert.equal(result.items[0].errorCode,'MESSAGE_REPLY_WINDOW_EXPIRED');
  assert.equal(result.items[0].clickCount,0);
  assert.equal(dispatches,0);
  assert.equal(clears,1,'expiry during preparation must clear prepared text');
  await runMessageReplySendBatch(options);
  assert.equal(clears,1,'an expired terminal batch must not auto-resume');
}
(async()=>{let failed=false;for(const test of [pageAndConfirm,confirmWithoutSync,legacyPage,futureLegacyInterview,scheduledInbox,oldFactForm,controls,delayedBatch,crossesDuringPreparation]){const db=storage.openDb(':memory:');try{await test(db);console.log(test.name+': ok');}catch(e){failed=true;console.error(test.name+': '+e.stack);}finally{db.close();}}if(failed)process.exitCode=1;else console.log('message_reply_expiry_smoke ok');})();

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const storage = require('../src/core/storage');
const learningStore = require('../src/storage/message_learning_store');
const { createMessageReplyLearningService } = require('../src/application/message_learning');
const { factStatus, currentCandidateMaterial, currentFactValue, mergeCandidateFacts } = require('../src/core/candidate_fact_policy');
const { createMessageReplyAnalyzer } = require('../src/core/message_reply_analyzer');
const { renderCommunicationProfilePage } = require('../src/dashboard/communication_profile_view');

const db = storage.openDb(':memory:');
require('./learning_evidence_revision_regressions');
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => db.close());
async function main() {
  const confirmedAt = '2026-10-05T08:00:00.000Z';
  const now = '2026-10-07T08:00:00.000Z';
  const profileId = Number(db.prepare("INSERT INTO candidate_profiles(display_name,profile_json,created_at,updated_at) VALUES ('audit','{}',?,?)").run(confirmedAt, confirmedAt).lastInsertRowid);
  const planId = Number(db.prepare("INSERT INTO search_plans(profile_id,name,plan_json,is_active,created_at,updated_at) VALUES (?,'audit','{}',1,?,?)").run(profileId, confirmedAt, confirmedAt).lastInsertRowid);
  const jobId = Number(db.prepare("INSERT INTO jobs(source,source_id,title,first_seen_at,last_seen_at) VALUES ('boss','audit','audit',?,?)").run(confirmedAt, confirmedAt).lastInsertRowid);
  const cardId = Number(db.prepare("INSERT INTO candidate_progress_cards(profile_id,plan_id,job_id,source,stage,next_action,last_event_at,created_at,updated_at) VALUES (?,?,?,'boss','reply_ready','review',?,?,?)").run(profileId,planId,jobId,confirmedAt,confirmedAt,confirmedAt).lastInsertRowid);
  const service = createMessageReplyLearningService({ db, now: () => now });
  const draftFor = index => storage.recordMessageReplyDrafts(db, { profileId, cardId, jobId,
    messageGroupKey: `sha256:${createHash('sha256').update(String(index)).digest('hex')}`,
    questionSummary: `项目回答 ${index}`, messageIntent: 'information_request', messageCategory: 'project_fact',
    messages: ['原稿'], createdAt: confirmedAt })[0];
  const draft = draftFor('conflict');
  const first = service.saveDraft({profileId,draftId:draft.id,text:'页面 A 修改',expectedRevision:0});
  assert.throws(() => service.saveDraft({profileId,draftId:draft.id,text:'页面 B 修改',expectedRevision:0}), error => error.code === 'MESSAGE_REPLY_DRAFT_CONFLICT');
  assert.equal(storage.getMessageReplyDraft(db,{profileId,draftId:draft.id}).currentText,'页面 A 修改');
  assert.equal(service.saveDraft({profileId,draftId:draft.id,text:'页面 A 修改',expectedRevision:first.revision}).revision,first.revision);
  learningStore.recordCandidateFactValue(db,{profileId,factKey:'availability_date',factValue:'录用后一周内到岗',occurredAt:'2026-09-20T08:00:00.000Z'});
  service.saveFact({profileId,factKey:'availability_date',factValue:'录用后一周内到岗'});
  const reconfirmed = storage.listCandidateFacts(db,profileId).find(f => f.factKey === 'availability_date');
  assert.equal(reconfirmed.updatedAt,now);
  assert.equal(factStatus(now,{...reconfirmed,key:reconfirmed.factKey}).status,'valid');
  learningStore.recordCandidateFactValue(db,{profileId,factKey:'availability_date',factValue:'录用后一周内到岗',occurredAt:'2026-10-08T08:00:00.000Z'});
  assert.equal(storage.listCandidateFacts(db,profileId).find(f => f.factKey === 'availability_date').updatedAt,now,'automatic unchanged writes must not renew confirmation');
  let oldest;
  for (let index=0;index<505;index++) {
    const d = draftFor(index);
    const memory = storage.completeMessageReplyDraft(db,{profileId,draftId:d.id,finalText:index===0?'最早的项目经历唯一关键词':'项目经历 '+index,
      completionKind:'copied',changedText:'项目经历',completedAt:confirmedAt,scope:{kind:'global',key:''}});
    if(index===0) oldest=memory;
  }
  const firstPage=service.listCommunicationProfile({profileId});
  assert(firstPage.answerPage.hasNext);
  assert(firstPage.answers.length <= 100);
  assert(!firstPage.answers.some(m=>m.id===oldest.id));
  const searched=service.listCommunicationProfile({profileId,answerQuery:'唯一关键词'});
  assert.equal(searched.answers[0].id,oldest.id);
  const escapeHtml = value => String(value || '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
  const profilePage = query => renderCommunicationProfilePage({db,service,searchParams:new URLSearchParams({profileId:String(profileId),...query}),
    helpers:{getCandidateProfile:()=>({id:profileId}),renderErrorPage:()=>{throw new Error('unexpected profile error');},renderFramedPage:page=>page.content,escapeHtml,escapeAttr:escapeHtml}});
  const searchedPage = profilePage({answerQuery:'唯一关键词'});
  assert(searchedPage.includes('最早的项目经历唯一关键词'));
  assert(!searchedPage.includes('项目经历 504'));
  assert(profilePage({}).includes('answerPage=2'));
  assert(profilePage({}).includes('上次确认：'));
  let all=[];
  for(let page=1;;page++) { const data=service.listCommunicationProfile({profileId,answerPage:page}); all.push(...data.answers); if(!data.answerPage.hasNext)break; }
  assert.equal(all.length,505); assert(all.some(m=>m.id===oldest.id));
  const revised=await service.reviseMemory({profileId,memoryId:oldest.id,finalText:'最早项目经历已修正'});
  service.withdrawMemory({profileId,memoryId:revised.memoryId});
  assert(!storage.listCandidateAnswerMemories(db,{profileId,activeOnly:true,source:'user_edited_reply',search:'最早项目经历'}).length);
  assert.equal(factStatus(now,{key:'interview_availability',value:'明天下午可以面试',updatedAt:confirmedAt}).status,'requires_confirmation');
  assert.equal(currentFactValue({key:'interview_availability',value:'明天下午可以面试',updatedAt:confirmedAt},confirmedAt),'2026-10-06下午可以面试');
  assert.equal(currentFactValue({key:'interview_availability',value:'下周一下午方便面试',updatedAt:confirmedAt},now),'2026-10-12下午方便面试');
  assert.equal(factStatus('2026-10-13T08:00:00Z',{key:'interview_availability',value:'下周一下午方便面试',updatedAt:confirmedAt}).status,'requires_confirmation');
  assert(!currentFactValue({key:'availability_date',value:'不能明天到岗',updatedAt:confirmedAt},now).includes('现在可以到岗'));
  assert.equal(currentFactValue({key:'availability_date',value:'收到录用通知两周后可以到岗',updatedAt:confirmedAt},now),'收到录用通知两周后可以到岗','event-relative commitment is not anchored to confirmation');
  assert.equal(currentFactValue({key:'availability_date',value:'确认录用后一周内可到岗',updatedAt:confirmedAt},now),'确认录用后一周内可到岗');
  for (const value of ['如果今天收到offer，明天可以到岗','预计明天可以到岗','收到录用通知后，明天可以到岗','离职手续办完后，明天可以到岗']) {
    const resolved=currentFactValue({key:'availability_date',value,updatedAt:confirmedAt},now);
    assert(!resolved.includes('现在可以到岗'), 'conditional or uncertain schedule cannot become an unconditional available-now fact');
    assert(resolved.includes(value.split('明天')[0].replace('今天','2026-10-05')), 'condition or uncertainty remains intact');
    assert(resolved.includes('2026-10-06'), 'qualified dates remain anchored to confirmation');
  }
  for (const value of ['收到录用通知 两周后可以到岗','签完合同两周后可以到岗','收到录用通知的两周后可以到岗']) {
    assert.equal(currentFactValue({key:'availability_date',value,updatedAt:confirmedAt},now),value,'event-relative intervals retain their event anchor');
    const projectedEvent=mergeCandidateFacts([],[{text:value,updatedAt:confirmedAt}])[0];
    assert.equal(projectedEvent.factValue,value,'event-relative fact projection retains its dependency');
    assert.equal(currentFactValue(projectedEvent,now),value);
  }
  assert(!currentFactValue({key:'availability_date',value:'仅10月6日当天可以到岗',updatedAt:confirmedAt},now).includes('现在可以到岗'),'one-time window does not imply available now');
  assert.equal(factStatus(now,{key:'availability_date',value:'仅10月6日当天可以到岗',updatedAt:confirmedAt}).status,'requires_confirmation');
  for(const value of ['从明天开始每天下午都可以面试','明天起都可以面试']) {
    assert.equal(factStatus(now,{key:'interview_availability',value,updatedAt:confirmedAt}).status,'valid','ongoing interview window has a starting date rather than deadline');
  }
  assert.equal(factStatus(now,{key:'interview_availability',value:'从明天开始每天下午都可以面试，但只到10月6日',updatedAt:confirmedAt}).status,'requires_confirmation');
  const material=currentCandidateMaterial([{id:1,source:'user_edited_reply',createdAt:confirmedAt,text:'我负责接口开发，明天下午可以面试。'}],{now});
  assert(material[0].text.includes('负责接口开发')); assert(!material[0].text.includes('面试'));
  let captured;
  await createMessageReplyAnalyzer({adapter:{async draftMessageGroup(input){captured=JSON.parse(JSON.stringify(input)); return {messageIntent:'interest_check',messageCategory:'other',messageSummary:'对方询问是否愿意了解。',requiredFactKeys:[],usedFactKeys:[],responseItems:[],coverage:[],missingFact:null,messages:['愿意了解。']};}}})({profile:{},job:{},messages:[{text:'是否愿意了解？'}],now,
    facts:[{factKey:'interview_availability',factValue:'明天下午可以面试',updatedAt:confirmedAt},{factKey:'availability_date',factValue:'明天可以到岗',updatedAt:confirmedAt}]});
  assert.equal(captured.now,now);
  assert(!captured.facts.some(f=>f.key==='interview_availability'));
  assert.match(captured.facts.find(f=>f.key==='availability_date').value,/现在可以到岗/);
  assert.match(captured.facts.find(f=>f.key==='availability_date').value,/2026-10-06/);
  const qualifiedEvidence={id:98,text:'预计2026-10-06可以到岗',sourceQuote:'预计2026-10-06可以到岗',updatedAt:confirmedAt,scope:{kind:'global',key:''}};
  const projected=mergeCandidateFacts([],[qualifiedEvidence])[0];
  assert.equal(projected.factValue,qualifiedEvidence.text,'projected time facts preserve qualifications');
  assert(!currentFactValue(projected,now).includes('现在可以到岗'));
  await createMessageReplyAnalyzer({adapter:{async draftMessageGroup(input){captured=JSON.parse(JSON.stringify(input));return {messageIntent:'interest_check',messageCategory:'other',messageSummary:'询问是否愿意了解',requiredFactKeys:[],usedFactKeys:[],responseItems:[],coverage:[],missingFact:null,messages:['愿意了解。']};}}})({profile:{},job:{},now,messages:[{text:'是否愿意了解？'}],candidateEvidence:[qualifiedEvidence]});
  assert.equal(captured.facts.find(f=>f.key==='availability_date').value,qualifiedEvidence.text,'reply input retains original uncertainty after evidence projection');
  const ongoing='从明天开始每天下午都可以面试';
  await createMessageReplyAnalyzer({adapter:{async draftMessageGroup(input){captured=JSON.parse(JSON.stringify(input));return {messageIntent:'information_request',messageCategory:'availability',messageSummary:'确认可用面试时段',requiredFactKeys:['interview_availability'],usedFactKeys:['interview_availability'],responseItems:[{id:'interview_availability',kind:'question',required:true}],coverage:[{responseItemId:'interview_availability',covered:true}],missingFact:null,messages:['每天下午都可以面试。']};}}})({profile:{},job:{},now,messages:[{text:'方便什么时候面试？'}],
    facts:[{factKey:'interview_availability',factValue:ongoing,updatedAt:confirmedAt}],
    candidateEvidence:[{id:97,text:ongoing,sourceQuote:ongoing,updatedAt:confirmedAt,scope:{kind:'global',key:''}}]});
  assert.equal(captured.facts.find(f=>f.key==='interview_availability').value,'从2026-10-06开始每天下午都可以面试');
  assert.equal(captured.candidateEvidence[0].text,'从2026-10-06开始每天下午都可以面试');
  for(const value of ['从明天开始到10月6日每天下午可以面试','从明天开始至2026-10-06每天下午可以面试','从明天开始至2026年10月6日每天下午可以面试','从明天开始每天下午可以面试，10月6日为止','从明天起到后天都可以面试']) {
    const endNow=value.includes('后天')?'2026-10-08T08:00:00Z':now;
    assert.equal(factStatus(endNow,{key:'interview_availability',value,updatedAt:confirmedAt}).status,'requires_confirmation','explicit ending bounds ongoing interview window');
    await createMessageReplyAnalyzer({adapter:{async draftMessageGroup(input){captured=JSON.parse(JSON.stringify(input));return {messageIntent:'interest_check',messageCategory:'other',messageSummary:'询问是否愿意了解',requiredFactKeys:[],usedFactKeys:[],responseItems:[],coverage:[],missingFact:null,messages:['愿意了解。']};}}})({profile:{},job:{},now:endNow,messages:[{text:'是否愿意了解？'}],facts:[{factKey:'interview_availability',factValue:value,updatedAt:confirmedAt}]});
    assert.equal(captured.facts.length,0,'past bounded interview schedule is excluded from actual reply input');
  }
  for(const value of ['从明天开始到下周一每天下午可以面试','从明天开始到2027年10月6日每天下午可以面试']) {
    assert.equal(factStatus(now,{key:'interview_availability',value,updatedAt:confirmedAt}).status,'valid','future bounded end remains usable within confirmation period');
  }
  const historyDraft=draftFor('long-revision-history');
  let latest=await service.completeDraft({profileId,draftId:historyDraft.id,finalText:'同稿历史 0',completionKind:'copied'});
  for(let index=1;index<=500;index++) {
    latest=await service.reviseMemory({profileId,memoryId:latest.memoryId,finalText:`同稿历史 ${index}`});
  }
  assert.equal(service.listCommunicationProfile({profileId,answerQuery:'同稿历史'}).answers.length,1);
  service.withdrawMemory({profileId,memoryId:latest.memoryId});
  assert.equal(service.listCommunicationProfile({profileId,answerQuery:'同稿历史'}).answers.length,0,'withdrawal cannot revive an answer outside the first 500 historical revisions');
  assert.equal(storage.listCandidateAnswerMemories(db,{profileId,draftId:historyDraft.id,activeOnly:true}).length,0);
  console.log('message_learning_audit_regression ok');
}

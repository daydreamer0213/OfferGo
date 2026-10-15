const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const storage = require('../src/core/storage');
const { upsertMessageEvents } = require('../src/storage/message_timeline_store');
const { listFunnelFeedbackEvidence } = require('../src/storage/funnel_feedback_store');

const START = '2026-10-12T02:00:00.000Z';
const AFTER = '2026-10-13T02:00:00.000Z';
const NOW = '2026-10-16T02:00:00.000Z';
const BEFORE = '2026-10-11T02:00:00.000Z';
const FUTURE = '2026-10-17T02:00:00.000Z';
const digest = value => 'sha256:' + crypto.createHash('sha256').update(value).digest('hex');
const db = storage.openDb(':memory:');

function owner(name) {
  const profileId = Number(db.prepare("INSERT INTO candidate_profiles(display_name,profile_json,created_at,updated_at) VALUES (?, '{}', ?, ?)").run(name, START, START).lastInsertRowid);
  const planId = plan(profileId, name);
  return { profileId, planId };
}
function plan(profileId, name) {
  return Number(db.prepare("INSERT INTO search_plans(profile_id,name,plan_json,is_active,created_at,updated_at) VALUES (?, ?, '{}', 1, ?, ?)").run(profileId, name, START, START).lastInsertRowid);
}
function resume(profileId, text) {
  const doc = Number(db.prepare("INSERT INTO resume_documents(profile_id,original_file_name,format,content_hash,resume_text,text_truncated,diagnostics_json,created_at) VALUES (?, 'test.txt','txt',?,?,0,'{}',?)").run(profileId, digest(text), text, START).lastInsertRowid);
  return Number(db.prepare('INSERT INTO candidate_resume_versions(profile_id,resume_document_id,version_key,name,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(profileId, doc, digest(text), text, START, START).lastInsertRowid);
}
function sample(owned, suffix, site = 'boss', resumeVersionId = null) {
  const round = storage.ensureActiveFunnelStrategyRound(db, { ...owned, startedAt: START });
  const jobId = Number(db.prepare("INSERT INTO jobs(source,source_id,title,company,description,first_seen_at,last_seen_at) VALUES (?,?,?,'公司','现存本地 JD',?,?)").run(site, suffix, suffix, START, START).lastInsertRowid);
  const threadKey = digest(suffix);
  const cardId = Number(db.prepare("INSERT INTO candidate_progress_cards(profile_id,plan_id,job_id,source,recruiter_name,thread_key,stage,next_action,last_event_at,created_at,updated_at) VALUES (?,?,?,?,'',?,'waiting_reply','',?,?,?)").run(owned.profileId, owned.planId, jobId, site, threadKey, START, START, START).lastInsertRowid);
  const id = Number(db.prepare("INSERT INTO candidate_funnel_entries(profile_id,job_id,card_id,plan_id,strategy_round_id,source_kind,started_at,mature_at,direction_key,resume_version_id,created_at,updated_at) VALUES (?,?,?,?,?,'communication',?,?,'后端',?,?,?)").run(owned.profileId, jobId, cardId, owned.planId, round.id, START, AFTER, resumeVersionId, START, START).lastInsertRowid);
  return { ...owned, id, jobId, cardId, site, strategyRoundId: round.id, startedAt: START, resumeVersionId, threadKey };
}
function messages(item, overrides = {}) {
  return upsertMessageEvents(db, { profileId: item.profileId, platform: item.site, conversationKey: item.threadKey, observedAt: AFTER, events: [
    { messageKey: digest('hr'), direction: 'friend', kind: 'text', text: '需要分布式系统经验，当前不合适。', occurredAt: AFTER },
    { messageKey: digest('self'), direction: 'myself', kind: 'text', text: '我只负责过单体服务。', occurredAt: AFTER },
    { messageKey: digest('before'), direction: 'friend', kind: 'text', text: '旧轮消息', occurredAt: BEFORE },
    { messageKey: digest('future'), direction: 'friend', kind: 'text', text: '未来消息', occurredAt: FUTURE },
    { messageKey: digest('fallback-time'), direction: 'friend', kind: 'text', text: '无平台时间，以首次读到时间为准。', occurredAt: null }
  ], ...overrides });
}
function classification(item, label, changes = {}, when = AFTER) {
  db.prepare("INSERT INTO candidate_progress_events(card_id,idempotency_key,type,actor,summary,metadata_json,occurred_at,created_at) VALUES (?,?,'incoming_message_classified','system','不可当作 HR 原文',?,?,?)")
    .run(item.cardId, digest(label), JSON.stringify({ platform: item.site, threadKey: item.threadKey, messageKey: digest('hr'), messageIntent: 'rejection', messageCategory: 'general', ...changes }), when, when);
}
function action(item, suffix, status, changes = {}) {
  db.prepare("INSERT INTO message_platform_actions(profile_id,platform,conversation_key,message_key,action_kind,idempotency_key,status,click_count,evidence_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?, '{}',?,?)")
    .run(changes.profileId || item.profileId, changes.site || item.site, changes.threadKey || item.threadKey, digest(suffix), changes.actionKind || 'resume_request_accept', crypto.randomUUID(), status, status === 'confirmed' ? 0 : 1, changes.time || AFTER, changes.time || AFTER);
}

try {
  const one = owner('一'), two = owner('二');
  const historical = resume(one.profileId, '历史简历正文');
  resume(one.profileId, '当前简历正文，不能替补');
  const current = sample(one, '当前岗位', 'boss', historical);
  const foreign = sample(two, '其他候选人');
  const otherPlan = sample({ profileId: one.profileId, planId: plan(one.profileId, '其他方案') }, '其他方案岗位');
  const zhaopin = sample(one, '智联岗位', 'zhaopin');
  messages(current); messages(foreign); messages(otherPlan); messages(zhaopin);
  messages(current, { profileId: two.profileId });
  messages(current, { platform: 'zhaopin' });
  classification(current, 'valid');
  classification(current, 'wrong-platform', { platform: 'zhaopin' });
  classification(current, 'wrong-thread', { threadKey: foreign.threadKey });
  classification(current, 'missing-message-key', { messageKey: '' });
  classification(current, 'before-window', {}, BEFORE);
  classification(current, 'future-classification', {}, FUTURE);
  db.prepare("INSERT INTO candidate_progress_events(card_id,idempotency_key,type,actor,summary,metadata_json,occurred_at,created_at) VALUES (?,?,'recruiter_rejected','system','拒绝分类摘要',?,?,?)")
    .run(current.cardId, digest('recruiter-rejection'), JSON.stringify({ platform: current.site, threadKey: current.threadKey, messageKey: digest('hr'), messageIntent: 'rejection' }), AFTER, AFTER);
  const copied = '只复制未发送的回复，不是实际对话';
  const draftId = Number(db.prepare("INSERT INTO message_reply_drafts(profile_id,card_id,job_id,message_group_key,draft_index,original_text,current_text,created_at,updated_at) VALUES (?,?,?,?,0,?,?,?,?)").run(one.profileId, current.cardId, current.jobId, digest('copied-group'), copied, copied, AFTER, AFTER).lastInsertRowid);
  db.prepare("INSERT INTO candidate_answer_memories(profile_id,draft_id,final_digest,original_text,final_text,source,completion_kind,created_at,updated_at) VALUES (?,?,?,?,?,'draft_adopted','copied',?,?)").run(one.profileId, draftId, digest(copied), copied, copied, AFTER, AFTER);
  action(current, 'ambiguous', 'ambiguous');
  action(current, 'confirmed-is-not-sent', 'confirmed');
  action(current, 'old-success', 'succeeded', { time: BEFORE });
  action(current, 'future-success', 'succeeded', { time: FUTURE });
  action(current, 'foreign-success', 'succeeded', { profileId: two.profileId });
  action(current, 'other-platform-success', 'succeeded', { site: 'zhaopin' });
  action(current, 'declined', 'succeeded', { actionKind: 'resume_request_decline' });
  const read = entries => listFunnelFeedbackEvidence(db, { ...one, entries, now: NOW });
  const changesBefore = db.prepare('SELECT total_changes() AS n').get().n;
  let actual = read([current, foreign, otherPlan]);
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changesBefore, 'evidence extraction is read-only');
  assert.equal(actual.length, 1, 'foreign profiles and plans cannot enter the selected evidence');
  assert.equal(actual[0].resumeText, '历史简历正文');
  assert.equal(actual[0].resumeSentAt, null, 'only a succeeded accept within the sample time counts');
  assert.equal(actual[0].conversationKey, current.threadKey);
  assert.deepEqual(actual[0].messages.map(value => value.direction), ['friend', 'myself', 'friend']);
  assert.deepEqual(actual[0].messages.map(value => value.text), ['需要分布式系统经验，当前不合适。', '我只负责过单体服务。', '无平台时间，以首次读到时间为准。']);
  assert.equal(actual[0].classifications.length, 2);
  assert.equal(actual[0].classifications[0].messageIntent, 'rejection');
  assert(!JSON.stringify(actual[0].messages).includes('不可当作 HR 原文'));
  assert(!JSON.stringify(actual[0].messages).includes(copied));
  action(current, 'success', 'succeeded');
  assert.equal(read([current])[0].resumeSentAt, AFTER);
  assert.equal(read([zhaopin])[0].resumeText, '', 'missing historical resume does not use current resume');
  const foreignResume = resume(two.profileId, '其他候选人简历，不可借用');
  db.prepare('UPDATE candidate_funnel_entries SET resume_version_id = ? WHERE id = ?').run(foreignResume, zhaopin.id);
  assert.equal(read([{ ...zhaopin, resumeVersionId: foreignResume }])[0].resumeText, '', 'a version owned by another candidate supplies no text');
  assert.equal(read([{ ...current, strategyRoundId: foreign.strategyRoundId }]).length, 0, 'forged round selection is rejected');
  assert.equal(read([{ ...current, resumeVersionId: foreign.resumeVersionId }]).length, 0, 'caller cannot substitute the recorded version');
  assert.deepEqual(read([null, {}, { ...current, id: -1 }]), []);
  db.prepare('UPDATE candidate_progress_cards SET thread_key = ? WHERE id = ?').run('not-a-digest', current.cardId);
  db.prepare("UPDATE candidate_progress_cards SET stage = 'interview_completed' WHERE id = ?").run(current.cardId);
  const manualInterview = read([current]);
  assert.equal(manualInterview.length, 1, 'an owned manual interview outcome remains visible without a trusted conversation');
  assert.equal(manualInterview[0].cardStage, 'interview_completed');
  assert.equal(manualInterview[0].conversationKey, '');
  assert.equal(manualInterview[0].resumeText, '历史简历正文');
  assert.deepEqual(manualInterview[0].messages, []);
  assert.deepEqual(manualInterview[0].classifications, []);
  assert.equal(manualInterview[0].resumeSentAt, null);
  db.prepare("UPDATE candidate_progress_cards SET thread_key = '', stage = 'offer_received' WHERE id = ?").run(current.cardId);
  assert.equal(read([current])[0].cardStage, 'offer_received');
  db.prepare('UPDATE candidate_progress_cards SET thread_key = ?, source = ? WHERE id = ?').run(current.threadKey, 'zhaopin', current.cardId);
  assert.deepEqual(read([current]), []);
  db.prepare('UPDATE candidate_progress_cards SET source = ?, plan_id = ? WHERE id = ?').run('boss', otherPlan.planId, current.cardId);
  assert.deepEqual(read([current]), []);
  db.prepare('UPDATE candidate_progress_cards SET plan_id = ?, profile_id = ? WHERE id = ?').run(one.planId, two.profileId, current.cardId);
  assert.deepEqual(read([current]), []);
  db.prepare('UPDATE candidate_progress_cards SET profile_id = ?, job_id = ? WHERE id = ?').run(one.profileId, foreign.jobId, current.cardId);
  assert.deepEqual(read([current]), []);
  assert.throws(() => listFunnelFeedbackEvidence(db, { ...one, entries: [], now: 'bad' }));
  console.log('funnel_feedback_store_smoke: ok');
} finally { db.close(); }

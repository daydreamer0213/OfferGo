const assert = require('node:assert/strict');
const { buildFeedbackReview } = require('../src/application/funnel_analysis/feedback_review');
const now = '2026-10-16T08:00:00.000Z';
const key = value => 'sha256:' + String(value).padStart(64, '0');
function sample(id = 1, category = 'project_fact', text = '检索项目里，你本人负责哪些部分？', intent = 'information_request') {
  return { entryId: id, jobId: id, cardId: id, site: 'boss', conversationKey: key(id), title: 'AI应用开发', company: '示例企业',
    description: '负责知识库检索和接口开发。', resumeVersionId: 3, resumeText: '项目经历\n参与知识库检索开发。', cardStage: 'needs_user_action',
    messages: [{ id, messageKey: key(id + 10), direction: 'friend', kind: 'text', text, occurredAt: '2026-10-16T06:00:00.000Z' }],
    classifications: [{ type: 'incoming_message_classified', messageKey: key(id + 10), messageCategory: category, messageIntent: intent }] };
}
const build = samples => buildFeedbackReview({ profileId: 1, samples, now });
const project = sample();
const small = build([project]);
assert.equal(small.primary.jobCount, 1, 'one actual HR question is actionable without waiting for 30 applications');
assert.equal(small.primary.target, 'messages');
assert.match(small.primary.action, /本人|负责|职责/);
assert.equal(small.primary.evidence[0].quote, project.messages[0].text);
assert.equal(small.primary.evidence[0].resumeVersionId, 3);
assert.equal(small.primary.evidence[0].description, project.description);
assert.equal(small.primary.evidence[0].replyText, '', 'missing observed reply is not fabricated from a draft');
assert(!/能力不足|简历有问题|没有负责|反复/.test(small.primary.title));
const duplicate = structuredClone(project);
duplicate.classifications.push({ ...duplicate.classifications[0] });
duplicate.messages.push({ ...duplicate.messages[0] });
assert.equal(build([project, duplicate]).primary.evidence.length, 1, 'repeated scans or classifications do not create repeated feedback');
const answered = sample();
answered.messages.push({ id: 9, messageKey: key(99), direction: 'myself', kind: 'text', text: '我负责查询改写和融合排序。', occurredAt: '2026-10-16T06:01:00.000Z' });
assert.equal(build([answered]).primary.evidence[0].replyText, '我负责查询改写和融合排序。');
const salary = build([sample(2, 'salary', '你的期望薪资是多少？')]).primary;
assert.match(salary.action, /期望薪资/);
assert(!/薪资冲突|薪资过高|降低.*薪资/.test(salary.title + salary.detail + salary.action));
const rejection = build([sample(3, 'other', '抱歉，暂不考虑了，祝求职顺利。', 'rejection')]).primary;
assert.equal(rejection.key, 'boss:rejection');
assert(!/技术不足|技能不匹配|简历不好/.test(rejection.detail + rejection.action));
const budget = build([sample(4, 'salary', '预算15K，与你22K的期望不符，本次不继续了。', 'rejection')]).primary;
assert.match(budget.action, /薪资/);
assert(!/回答实际期望薪资|机会是否继续/.test(budget.action), 'ended opportunities need a retrospective rather than instructions to keep replying');
assert.equal(budget.evidence[0].quote, '预算15K，与你22K的期望不符，本次不继续了。');
const noText = sample(); noText.messages = [];
assert.equal(build([noText]).primary, null, 'progress classification alone must not supply invented HR quotes');
const selfOnly = sample(); selfOnly.messages[0].direction = 'myself';
assert.equal(build([selfOnly]).primary, null);
const platformNotice = sample(); platformNotice.messages[0].kind = 'platform_notice';
assert.equal(build([platformNotice]).primary, null);
const mixed = build([sample(1), { ...sample(2), site: 'zhaopin' }]);
assert.equal(mixed.topics.length, 2, 'platform-specific feedback must not be pooled into one trend');
assert(mixed.topics.every(topic => topic.jobCount === 1));
const completed = sample(); completed.cardStage = 'interview_completed'; completed.messages = []; completed.classifications = [];
const post = build([completed]).primary;
assert.equal(post.target, 'interview');
assert(!/面试失败|面试能力不足|未通过/.test(post.title + post.action));
const completedWithOldQuestion = build([{ ...sample(), cardStage: 'interview_completed' }]);
assert.equal(completedWithOldQuestion.primary.key, 'boss:interview', 'old project questions must not outrank the current post-interview follow-up');
assert(completedWithOldQuestion.topics.some(topic => topic.evidence.some(item => item.quote)), 'old questions remain available for review');
const activeQuestion = sample(2);
const mixedProgress = [{ ...sample(), cardStage: 'interview_completed' }, activeQuestion];
assert.equal(build(mixedProgress).primary.key, build([...mixedProgress].reverse()).primary.key,
  'merging current questions and older interview questions must not depend on sample order');
const manual = build([{ ...completed, conversationKey: '' }]).primary;
assert.equal(manual.evidence[0].contactKey, '', 'a manual interview result without a trusted thread must not invent a conversation link');
assert.equal(build([{ ...completed, conversationKey: '' }, { ...completed, entryId: 2, cardId: 2, jobId: 2, conversationKey: '' }]).primary.jobCount, 2,
  'separate manual interviews must not deduplicate against an empty conversation key');
const offered = { ...sample(), cardStage: 'offer_received' };
assert.equal(build([offered]).topics.length, 1, 'already received offers must not keep producing old pre-interview question advice');
assert.equal(build([offered]).primary.key, 'boss:offer');
const requested = { ...sample(), cardStage: 'waiting_reply', messages: [], classifications: [] };
assert.equal(build([requested]).primary, null, 'requesting a resume alone does not establish that an attachment was sent');
const sent = { ...requested, resumeSentAt: '2026-10-16T07:00:00.000Z' };
const sentReview = build([sent]).primary;
assert.equal(sentReview.target, 'messages');
assert.match(sentReview.action, /反馈|进展/);
assert(!/简历质量差|已经阅读|已发送.*版本/.test(sentReview.title + sentReview.action));
console.log('funnel_actionable_review_smoke ok');

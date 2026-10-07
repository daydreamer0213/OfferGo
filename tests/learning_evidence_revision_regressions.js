const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash } = require('node:crypto');
const storage = require('../src/core/storage');
const learningStore = require('../src/storage/message_learning_store');
const evidenceStore = require('../src/storage/candidate_evidence_store');
const { createMessageReplyLearningService } = require('../src/application/message_learning');
const { candidateReplyMaterial } = require('../src/application/message_discovery/materials');
const { buildMessageDraftQualityContext } = require('../src/application/message_draft_quality');
const { assessMessageDraftQuality } = require('../src/core/message_draft_quality');
const { createMessageReplyAnalyzer } = require('../src/core/message_reply_analyzer');
const { currentCandidateMaterial } = require('../src/core/candidate_fact_policy');
const { validateReplyEditFactExtraction } = require('../src/core/message_reply_learning');

const oldQuote = '我累计完成3个知识库接口联调项目。';
const newQuote = '我累计完成2个知识库接口联调项目。';
const unrelated = '我使用日志定位超时，整理接口文档并完成回归验证。';
async function fixture(action) {
  const db = storage.openDb(':memory:');
  const at = new Date().toISOString();
  const owner = storage.saveProfileAnalysis(db, { profile: { candidate: { name: '学习测试' } },
    document: { contentHash: 'learning-revision', text: '学习测试\n参与接口联调', format: 'text', originalFileName: 'source.txt' },
    searchPlan: { name: '学习测试', directions: ['工程师'] } });
  const batch = storage.createBatch(db, 'boss', '工程师', 'learning-regression', { profileId: owner.profileId, searchPlanId: owner.planId });
  const jobId = storage.upsertJob(db, { source: 'boss', sourceId: 'learning-regression', title: '应用工程师', company: '示例公司',
    description: '负责知识库接口开发和联调' }, batch);
  const cardId = Number(db.prepare(`INSERT INTO candidate_progress_cards(profile_id,plan_id,job_id,source,stage,next_action,last_event_at,created_at,updated_at)
    VALUES (?,?,?,'boss','reply_ready','review',?,?,?)`).run(owner.profileId, owner.planId, jobId, at, at, at).lastInsertRowid);
  const [draft] = storage.recordMessageReplyDrafts(db, { profileId: owner.profileId, cardId, jobId,
    messageGroupKey: 'sha256:' + createHash('sha256').update(action).digest('hex'), questionSummary: '知识库接口联调项目数量与排障方法',
    messageIntent: 'information_request', messageCategory: 'project_fact', messages: ['您好，我参与接口联调。'] });
  const service = createMessageReplyLearningService({ db, adapter: { async extractReplyEditFacts() {
    return { facts: [], experiences: [{ subject: '知识库联调数量', sourceQuote: oldQuote }] };
  } } });
  const completed = await service.completeDraft({ profileId: owner.profileId, draftId: draft.id,
    finalText: oldQuote + unrelated, completionKind: 'sent' });
  const entry = evidenceStore.listCandidateEvidence(db, { profileId: owner.profileId })[0];
  if (action === 'correct') service.reviseEvidence({ profileId: owner.profileId, id: entry.id, subject: entry.subject, text: newQuote });
  else service.withdrawEvidence({ profileId: owner.profileId, id: entry.id });
  return { db, owner, jobId, draft, completed, entry };
}

for (const action of ['correct', 'withdraw']) {
  test(`linked experience ${action} removes only its obsolete clause from actual model input`, async () => {
    const f = await fixture(action);
    try {
      const analyze = createMessageReplyAnalyzer({ adapter: { async draftMessageGroup(input) {
        const stories = JSON.stringify({ candidateEvidence: input.candidateEvidence, answerMemories: input.answerMemories });
        assert(!stories.includes('3个'), stories);
        assert(stories.includes(unrelated), 'unrelated adopted experience remains available');
        if (action === 'correct') assert(stories.includes('2个'), 'the separately confirmed correction remains available');
        return { messageIntent: 'information_request', messageCategory: 'project_fact', messageSummary: '联调经历',
          requiredFactKeys: [], usedFactKeys: [], usedMemoryIds: [], usedEvidenceIds: [], responseItems: [], coverage: [],
          missingFact: null, messages: [unrelated] };
      } } });
      await analyze({ ...candidateReplyMaterial(f.db, f.owner.profileId), job: { id: f.jobId, company: '示例公司' },
        messages: [{ text: '你做过几个知识库联调项目，怎样排障？' }] });
      const history = learningStore.listCandidateAnswerMemories(f.db, { profileId: f.owner.profileId, activeOnly: false });
      assert.equal(history.find(item => item.id === f.completed.memoryId).finalText, oldQuote + unrelated);
      assert.equal(learningStore.getMessageReplyDraft(f.db, { profileId: f.owner.profileId, draftId: f.draft.id }).currentText, oldQuote + unrelated);
    } finally { f.db.close(); }
  });

  test(`linked experience ${action} cannot support an obsolete number in actual quality checks`, async () => {
    const f = await fixture(action);
    try {
      const quality = buildMessageDraftQualityContext(f.db, { profileId: f.owner.profileId,
        job: { id: f.jobId, company: '示例公司' }, messageTexts: ['你做过几个知识库联调项目？'] });
      assert.equal(assessMessageDraftQuality({ text: oldQuote, ...quality }).valid, false);
      assert(quality.evidenceTexts.some(text => text.includes(unrelated)));
      if (action === 'correct') assert.equal(assessMessageDraftQuality({ text: newQuote, ...quality }).valid, true);
      assert(quality.recentTexts.includes(oldQuote + unrelated), 'sent history remains an accurate record, not fact evidence');
    } finally { f.db.close(); }
  });
}

test('formatting-equivalent source spans are removed without erasing unrelated content', () => {
  const memory = { id: 1, source: 'user_edited_reply', finalText: '我累计完成 3 个知识库接口联调项目。' + unrelated,
    sourceEvidenceUpdates: [{ sourceQuote: oldQuote, text: newQuote, withdrawnAt: '' }] };
  const [effective] = currentCandidateMaterial([memory]);
  assert(!effective.finalText.includes('3'));
  assert(effective.finalText.includes('2个'));
  assert(effective.finalText.includes(unrelated));
  assert(memory.finalText.includes('3'), 'projection must leave raw history unchanged');
});

test('retrying learning uses the current confirmed fragment and does not reconfirm the obsolete answer', async () => {
  const f = await fixture('correct');
  try {
    learningStore.recordMessageReplyLearningStatus(f.db, { profileId: f.owner.profileId, memoryId: f.completed.memoryId,
      status: 'failed', factCount: 0 });
    const recovery = createMessageReplyLearningService({ db: f.db, adapter: { async extractReplyEditFacts(input) {
      assert(!JSON.stringify(input).includes('3个'), JSON.stringify(input));
      assert(input.finalText.includes(unrelated));
      return { facts: [], experiences: [{ subject: '知识库联调数量', sourceQuote: newQuote }] };
    } } });
    const recovered = await recovery.retryLearning({ profileId: f.owner.profileId, memoryId: f.completed.memoryId });
    assert.equal(recovered.extractionStatus, 'succeeded');
    const entries = evidenceStore.listCandidateEvidence(f.db, { profileId: f.owner.profileId });
    assert.equal(entries.length, 1, 'retry must not create a duplicate confirmation from its own corrected input');
    assert.equal(entries[0].text, newQuote);
    assert.equal(learningStore.getCandidateAnswerMemory(f.db, { profileId: f.owner.profileId,
      memoryId: f.completed.memoryId }).finalText, oldQuote + unrelated);
  } finally { f.db.close(); }
});

test('extracted travel facts preserve negation and long versus short qualification', () => {
  const quote = '我不能接受长期出差，但可以接受短期出差。';
  for (const [factValue, evidenceText, count] of [
    ['可以接受长期出差', '我不能接受长期出差', 0],
    ['接受出差', '可以接受短期出差', 0],
    ['不能接受长期出差', '我不能接受长期出差', 1],
    ['可以接受短期出差', '可以接受短期出差', 1],
    ['我不能接受长期出差，但可以接受短期出差', '我不能接受长期出差，但可以接受短期出差', 1]
  ]) {
    const result = validateReplyEditFactExtraction({ facts: [{ factKey: 'accepts_travel', factValue, evidenceText }] },
      { changedText: quote, finalText: quote });
    assert.equal(result.facts.length, count, factValue);
  }
});

test('employment and arrival facts cannot turn an explicit negative into a positive', () => {
  for (const [quote, factKey, factValue, evidenceText, count] of [
    ['我目前没有离职。', 'employment_status', '已离职', '没有离职', 0],
    ['我目前没有离职。', 'employment_status', '在职', '没有离职', 1],
    ['我不能下周到岗。', 'availability_date', '下周', '下周', 0],
    ['我不能下周到岗。', 'availability_date', '我不能下周到岗', '我不能下周到岗', 1],
    ['我下周可以到岗。', 'availability_date', '下周', '下周', 1]
  ]) {
    const result = validateReplyEditFactExtraction({ facts: [{ factKey, factValue, evidenceText }] },
      { changedText: quote, finalText: quote });
    assert.equal(result.facts.length, count, `${quote} -> ${factValue}`);
  }
});

test('a one-word negation edit is interpreted in its adopted clause rather than as an isolated token', () => {
  const result = validateReplyEditFactExtraction({ facts: [
    { factKey: 'accepts_travel', factValue: '接受长期出差', evidenceText: '不' },
    { factKey: 'employment_status', factValue: '已离职', evidenceText: '没有' }
  ] }, { changedText: '不', finalText: '我不接受长期出差。' });
  assert.deepEqual(result.facts, []);
  const employment = validateReplyEditFactExtraction({ facts: [
    { factKey: 'employment_status', factValue: '已离职', evidenceText: '没有' }
  ] }, { changedText: '没有', finalText: '我目前没有离职。' });
  assert.deepEqual(employment.facts, []);
  const correct = validateReplyEditFactExtraction({ facts: [
    { factKey: 'accepts_travel', factValue: '不接受长期出差', evidenceText: '不' }
  ] }, { changedText: '不', finalText: '我不接受长期出差。' });
  assert.equal(correct.facts.length, 1);
});

const assert = require("node:assert");
const {
  normalizeReplyDraftText,
  replyDraftDigest,
  replyDraftWasEdited,
  deriveUserChangedText,
  validateReplyEditFactExtraction
} = require("../src/core/message_reply_learning");
const { createMessageReplyLearningService } = require("../src/application/message_learning");
const {
  openDb,
  recordMessageReplyDrafts,
  listCandidateFacts,
  listCandidateAnswerMemories,
  listCandidateFactRevisions
} = require("../src/core/storage");

assert.strictEqual(normalizeReplyDraftText("  您好，\r\n  我可以到岗。  "), "您好，\n我可以到岗。");
assert.strictEqual(replyDraftWasEdited("您好， 我可以到岗。", "您好，\n我可以到岗。"), false, "whitespace-only changes are not authoritative edits");
assert.strictEqual(replyDraftWasEdited("目前在职，一个月内到岗", "目前已离职，下周到岗"), true);
assert(/^sha256:[a-f0-9]{64}$/.test(replyDraftDigest("最终回答")));
assert.strictEqual(
  replyDraftDigest("我目前 在职"),
  replyDraftDigest("我目前\n在职"),
  "digest idempotency must use the same whitespace equivalence as edit detection"
);

const changed = deriveUserChangedText(
  "您好，我目前在职，一个月内可以到岗。",
  "您好，我目前已经离职，下周可以到岗。"
);
assert(changed.includes("已经离职"));
assert(changed.includes("下周"));
assert(!changed.includes("一个月内"), "changed evidence must not contain removed model wording");
assert("您好，我目前已经离职，下周可以到岗。".includes(changed), "changed evidence must be a literal final-answer span");

const separated = deriveUserChangedText("我在广州，期望20K，可以出差。", "我在深圳，期望25K，可以出差。 ");
assert("我在深圳，期望25K，可以出差。".includes(separated.trim()), "separated edits may use one conservative final-answer span");

const validated = validateReplyEditFactExtraction({
  scope: { kind: "global", key: "" },
  facts: [
    { factKey: "employment_status", factValue: "已离职", evidenceText: "已经离职" },
    { factKey: "unknown_model_guess", factValue: "不能保存", evidenceText: "已经离职" },
    { factKey: "availability_date", factValue: "一个月内", evidenceText: "一个月内" },
    { factKey: "availability_date", factValue: "下周", evidenceText: "下周" }
  ]
}, { changedText: changed });
assert.deepStrictEqual(validated, {
  scope: { kind: "global", key: "" },
  facts: [
    { factKey: "employment_status", factValue: "已离职", evidenceText: "已经离职" },
    { factKey: "availability_date", factValue: "下周", evidenceText: "下周" }
  ]
});
assert.deepStrictEqual(validateReplyEditFactExtraction(null, { changedText: changed }), {
  scope: { kind: "global", key: "" },
  facts: []
});
assert.deepStrictEqual(validateReplyEditFactExtraction({
  scope: { kind: "global", key: "" },
  facts: []
}, {
  changedText: changed,
  scope: { kind: "job", key: "42" }
}).scope, { kind: "job", key: "42" }, "the extractor must not broaden a job-scoped answer into global memory");

const db = openDb(":memory:");

for (const [quote, expectedCount] of [
  ['我负责薪资结算系统的测试，发现计算精度问题并修复。', 1],
  ['针对这家公司我每周到北京办公三天。', 0]
]) {
  const result = validateReplyEditFactExtraction({ facts: [], experiences: [{ subject: '用户补充', sourceQuote: quote }] }, { changedText: quote, finalText: quote });
  assert.equal(result.experiences.length, expectedCount, 'personal work and company commitments must be distinguished');
}
const repeatedEditQuote = '我负责接口联调，先复现故障，再对比请求参数找出原因。';
assert.equal(validateReplyEditFactExtraction({ experiences: [{ subject: '联调', sourceQuote: repeatedEditQuote }] }, {
  changedText: '负责', finalText: '我负责日常运维。' + repeatedEditQuote,
  confirmedExperiences: [{ sourceQuote: repeatedEditQuote.replace('负责', '参与') }]
}).experiences.length, 1, 'confirmed correction must not use the first occurrence of the edited word as its position');

(async () => {
  try {
    const fixture = createFixture(db);
    const calls = [];
    let extractionMode = "success";
    const service = createMessageReplyLearningService({
      db,
      adapter: {
        async extractReplyEditFacts(input) {
          calls.push(structuredClone(input));
          if (extractionMode === "failure") throw Object.assign(new Error("model unavailable"), { code: "MODEL_UNAVAILABLE" });
          return {
            scope: { kind: "global", key: "" },
            facts: [
              { factKey: "employment_status", factValue: "已离职", evidenceText: "已经离职" },
              { factKey: "availability_date", factValue: "下周", evidenceText: "下周" },
              { factKey: "unknown_model_guess", factValue: "丢弃", evidenceText: "已经离职" },
              { factKey: "current_city", factValue: "广州", evidenceText: "广州" }
            ]
          };
        }
      },
      logger: { warn() {} },
      now: sequenceNow([
        "2026-08-28T02:01:00.000Z",
        "2026-08-28T02:02:00.000Z",
        "2026-08-28T02:03:00.000Z",
        "2026-08-28T02:04:00.000Z",
        "2026-08-28T02:05:00.000Z"
      ])
    });

    const firstDraft = seedDraft(db, fixture, "service-1", "您好，我目前在职，一个月内可以到岗。");
    const saved = service.saveDraft({
      profileId: fixture.profileId,
      draftId: firstDraft.id,
      text: "您好，我目前已经离职，下周可以到岗。"
    });
    assert.strictEqual(saved.currentText, "您好，我目前已经离职，下周可以到岗。");
    assert.strictEqual(calls.length, 0, "autosave must never invoke fact extraction");
    assert.strictEqual(listCandidateFacts(db, fixture.profileId).length, 0);

    const completed = await service.completeDraft({
      profileId: fixture.profileId,
      draftId: firstDraft.id,
      finalText: saved.currentText,
      completionKind: "copied"
    });
    assert.deepStrictEqual(completed, {
      memoryId: completed.memoryId,
      draftId: firstDraft.id,
      revision: 1,
      changed: true,
      learnedFactCount: 2,
      extractionStatus: "succeeded"
    });
    assert(completed.memoryId > 0);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].originalText, firstDraft.originalText);
    assert.strictEqual(calls[0].finalText, saved.currentText);
    assert.strictEqual(calls[0].changedText, changed);
    assert(!Object.hasOwn(calls[0], "profile"), "extractor receives only reply-edit context, not the whole candidate profile");
    assert.deepStrictEqual(currentFacts(db, fixture.profileId), {
      availability_date: "下周",
      employment_status: "已离职"
    });

    const repeated = await service.completeDraft({
      profileId: fixture.profileId,
      draftId: firstDraft.id,
      finalText: saved.currentText,
      completionKind: "copied"
    });
    assert.strictEqual(repeated.memoryId, completed.memoryId);
    assert.strictEqual(calls.length, 1, "idempotent completion should not pay for extraction twice");
    assert.strictEqual(listCandidateFactRevisions(db, { profileId: fixture.profileId }).length, 2);

    const unchangedDraft = seedDraft(db, fixture, "service-2", "您好，感谢沟通。这个岗位我愿意继续了解。");
    const unchanged = await service.completeDraft({
      profileId: fixture.profileId,
      draftId: unchangedDraft.id,
      finalText: "您好，感谢沟通。这个岗位我愿意继续了解。",
      completionKind: "copied"
    });
    assert.strictEqual(unchanged.changed, false);
    assert.strictEqual(unchanged.extractionStatus, "not_needed");
    assert.strictEqual(unchanged.learnedFactCount, 0);
    assert.strictEqual(calls.length, 1, "unchanged model draft must not invoke extraction");

    extractionMode = "failure";
    const failureDraft = seedDraft(db, fixture, "service-3", "您好，我目前在广州。", "other");
    const failed = await service.completeDraft({
      profileId: fixture.profileId,
      draftId: failureDraft.id,
      finalText: "您好，我目前在深圳。",
      completionKind: "copied"
    });
    assert.strictEqual(failed.changed, true);
    assert.strictEqual(failed.extractionStatus, "failed");
    assert.strictEqual(failed.learnedFactCount, 0);
    assert(listCandidateAnswerMemories(db, { profileId: fixture.profileId, activeOnly: true, source: "user_edited_reply" })
      .some((memory) => memory.finalText === "您好，我目前在深圳。"), "extractor failure must not lose the user's final answer");

    const noAdapterDraft = seedDraft(db, fixture, "service-4", "您好，我暂不接受出差。", "qualification");
    const noAdapterService = createMessageReplyLearningService({ db, adapter: {}, now: () => "2026-08-28T02:06:00.000Z" });
    const unavailable = await noAdapterService.completeDraft({
      profileId: fixture.profileId,
      draftId: noAdapterDraft.id,
      finalText: "您好，我可以接受短期出差。",
      completionKind: "sent"
    });
    assert.strictEqual(unavailable.extractionStatus, "unavailable");
    assert.strictEqual(unavailable.learnedFactCount, 0);

    const dynamicUnavailableDraft = seedDraft(db, fixture, "service-5", "您好，我目前在广州。", "other");
    const dynamicUnavailableService = createMessageReplyLearningService({
      db,
      adapter: {
        async extractReplyEditFacts() {
          throw Object.assign(new Error("model is not configured"), {
            code: "MESSAGE_REPLY_FACT_EXTRACTION_UNAVAILABLE"
          });
        }
      },
      logger: { warn() {} },
      now: () => "2026-08-28T02:07:00.000Z"
    });
    const dynamicUnavailable = await dynamicUnavailableService.completeDraft({
      profileId: fixture.profileId,
      draftId: dynamicUnavailableDraft.id,
      finalText: "您好，我目前在佛山。",
      completionKind: "copied"
    });
    assert.strictEqual(dynamicUnavailable.extractionStatus, "unavailable");
    assert(listCandidateAnswerMemories(db, { profileId: fixture.profileId, activeOnly: true, source: "user_edited_reply" })
      .some((memory) => memory.finalText === "您好，我目前在佛山。"), "unavailable extraction must still keep the edited answer");

    const communicationProfile = service.listCommunicationProfile({ profileId: fixture.profileId });
    assert(communicationProfile.facts.some((fact) => fact.factKey === "employment_status"));
    assert(communicationProfile.answers.every((answer) => answer.source === "user_edited_reply"));
    assert(communicationProfile.revisions.length >= 2);

    service.withdrawMemory({ profileId: fixture.profileId, memoryId: completed.memoryId });
    assert.strictEqual(currentFacts(db, fixture.profileId).employment_status, undefined);

    await reusableExperienceSmoke(db, fixture);
    await factsLifecycleSmoke();
    console.log("message_reply_learning_smoke ok");
  } finally {
    db.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function reusableExperienceSmoke(database, fixture) {
  const { listCandidateEvidence } = require('../src/storage/candidate_evidence_store');
  const { createMessageReplyAnalyzer } = require('../src/core/message_reply_analyzer');
  let quote = '我参与接口联调，先复现故障，再对比请求参数找出原因。';
  const condition = '这份岗位我可以下周到岗，期望薪资20K。';
  const draft = seedDraft(database, fixture, 'reusable-experience', '我做过接口联调。', 'project_fact');
  const service = createMessageReplyLearningService({ db: database, adapter: { async extractReplyEditFacts() {
    return { facts: [], experiences: [
      { subject: '排障经历', sourceQuote: quote, text: '模型额外改写不作为新事实' },
      { subject: '原岗位条件', sourceQuote: condition },
      { subject: '不存在的经历', sourceQuote: '我独立主导了架构' }
    ] };
  } } });
  let completionCallbacks = 0;
  const result = await service.completeDraft({ profileId: fixture.profileId, draftId: draft.id, finalText: quote + condition, completionKind: 'copied', afterComplete: () => { completionCallbacks++; } });
  assert.equal(completionCallbacks, 1, 'shared learning must preserve the completion callback');
  let entries = listCandidateEvidence(database, { profileId: fixture.profileId });
  assert.equal(entries.length, 1, 'only the literal personal story should be reusable');
  assert.equal(entries[0].text, quote);
  assert.equal(entries[0].scope.kind, 'global');
  assert.equal(entries[0].sourceId, `reply-edit:${result.memoryId}`);
  const wholeAnswer = listCandidateAnswerMemories(database, { profileId: fixture.profileId }).find(item => item.id === result.memoryId);
  assert.equal(wholeAnswer.scope.kind, 'job', 'the mixed whole answer must stay scoped to its original job');
  await service.completeDraft({ profileId: fixture.profileId, draftId: draft.id, finalText: quote + condition, completionKind: 'copied' });
  assert.equal(listCandidateEvidence(database, { profileId: fixture.profileId }).length, 1, 'repeated completion must not duplicate stories');
  const analyze = createMessageReplyAnalyzer({ adapter: { async draftMessageGroup(input) {
    assert.equal(input.candidateEvidence[0].text, quote);
    assert.equal(input.answerMemories.length, 0);
    return { messageIntent: 'information_request', messageCategory: 'project_fact', messageSummary: '询问排障经历', requiredFactKeys: [], usedFactKeys: [], usedMemoryIds: [], usedEvidenceIds: [entries[0].id], responseItems: [], coverage: [], missingFact: null, messages: [quote] };
  } } });
  await analyze({ job: { id: fixture.jobId + 100 }, messages: [{ text: '碰到难题一般怎么处理？' }], candidateEvidence: entries, answerMemories: [wholeAnswer] });
  quote = '我参与接口联调，通过日志定位超时，再逐项验证修正结果。';
  const revised = await service.reviseMemory({ profileId: fixture.profileId, memoryId: result.memoryId, finalText: quote + condition });
  entries = listCandidateEvidence(database, { profileId: fixture.profileId });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, quote, 'old story must not remain active after a correction');
  quote = quote.replace('参与', '负责');
  const shortCorrection = await service.reviseMemory({ profileId: fixture.profileId, memoryId: revised.memoryId, finalText: quote + condition });
  assert.equal(listCandidateEvidence(database, { profileId: fixture.profileId })[0]?.text, quote, 'a short correction of a confirmed user story must remain reusable');
  const salaryOnly = createMessageReplyLearningService({ db: database, adapter: { async extractReplyEditFacts() { return { facts: [], experiences: [] }; } } });
  const latest = await salaryOnly.reviseMemory({ profileId: fixture.profileId, memoryId: shortCorrection.memoryId, finalText: quote + condition.replace('20K', '25K') });
  assert.equal(listCandidateEvidence(database, { profileId: fixture.profileId })[0]?.text, quote, 'editing salary alone must keep the unchanged personal story');
  salaryOnly.withdrawMemory({ profileId: fixture.profileId, memoryId: latest.memoryId });
  assert.deepEqual(listCandidateEvidence(database, { profileId: fixture.profileId }), []);
  const rollbackDraft = seedDraft(database, fixture, 'reusable-rollback', '感谢介绍。', 'project_fact');
  await assert.rejects(service.completeDraft({ profileId: fixture.profileId, draftId: rollbackDraft.id,
    finalText: quote, completionKind: 'copied', afterComplete: () => { throw new Error('completion failed'); }
  }), /completion failed/);
  assert.deepEqual(listCandidateEvidence(database, { profileId: fixture.profileId }), [], 'failed completion must roll back its reusable story');
  assert(!listCandidateAnswerMemories(database, { profileId: fixture.profileId }).some(item => item.draftId === rollbackDraft.id), 'failed completion must roll back its answer memory');
}

async function factsLifecycleSmoke() {
  const database = openDb(':memory:');
  try {
    const fixture = createFixture(database);
    const { recordCandidateFactValue } = require('../src/storage/message_learning_store');
    const { saveCandidateEvidence } = require('../src/storage/candidate_evidence_store');
    recordCandidateFactValue(database, { profileId: fixture.profileId, factKey: 'employment_status', factValue: '在职', occurredAt: '2026-10-01T00:00:00.000Z' });
    const entry = saveCandidateEvidence(database, { profileId: fixture.profileId, subject: '求职状态', text: '我目前已离职，下周可以到岗。',
      sourceQuote: '我目前已离职，下周可以到岗。', sourceKind: 'manual', sourceId: 'timeline', sourceItemKey: '0' });
    database.prepare('UPDATE candidate_evidence_entries SET updated_at = ? WHERE id = ?').run('2026-10-02T00:00:00.000Z', entry.id);
    let clock = '2026-10-02T12:00:00.000Z';
    const service = createMessageReplyLearningService({ db: database, now: () => clock, adapter: { async extractReplyEditFacts() {
      return { facts: [{ factKey: 'employment_status', factValue: '已离职', evidenceText: '已离职' }] };
    } } });
    const draft = seedDraft(database, fixture, 'timeline', '感谢介绍。', 'availability');
    const result = await service.completeDraft({ profileId: fixture.profileId, draftId: draft.id, finalText: '我目前已离职。', completionKind: 'copied' });
    clock = '2026-10-03T00:00:00.000Z';
    service.withdrawMemory({ profileId: fixture.profileId, memoryId: result.memoryId });
    assert.equal(service.listCommunicationProfile({ profileId: fixture.profileId }).facts.find(fact => fact.factKey === 'employment_status').factValue, '已离职', 'withdrawal must not make an older fact look newly confirmed');
    database.prepare('UPDATE candidate_facts SET updated_at = ? WHERE profile_id = ? AND fact_key = ?').run(clock, fixture.profileId, 'employment_status');
    assert.equal(service.listCommunicationProfile({ profileId: fixture.profileId }).facts.find(fact => fact.factKey === 'employment_status').factValue, '已离职', 'old databases with projection timestamps must use the source confirmation time when read');
    assert.equal(service.deleteFact({ profileId: fixture.profileId, factKey: 'availability_date' }), true, 'projected facts shown in the profile must be deletable');
    assert(!service.listCommunicationProfile({ profileId: fixture.profileId }).facts.some(fact => fact.factKey === 'availability_date'));
    assert.equal(service.deleteFact({ profileId: fixture.profileId, factKey: 'availability_date' }), false, 'repeated deletion must not add another revision');
    recordCandidateFactValue(database, { profileId: fixture.profileId, factKey: 'expected_salary', factValue: '15-18K', occurredAt: '2026-10-01T00:00:00.000Z' });
    const scoped = createMessageReplyLearningService({ db: database, adapter: { async extractReplyEditFacts() {
      return { facts: [{ factKey: 'expected_salary', factValue: '20K', evidenceText: '期望薪资20K' }] };
    } } });
    const salaryDraft = seedDraft(database, fixture, 'scoped-salary', '感谢介绍。', 'salary');
    await scoped.completeDraft({ profileId: fixture.profileId, draftId: salaryDraft.id, finalText: '针对这份岗位，我期望薪资20K。', completionKind: 'copied' });
    assert.equal(listCandidateFacts(database, fixture.profileId, { job: { id: fixture.jobId } }).find(fact => fact.factKey === 'expected_salary').factValue, '20K');
    assert.equal(listCandidateFacts(database, fixture.profileId, { job: { id: fixture.jobId + 1 } }).find(fact => fact.factKey === 'expected_salary').factValue, '15-18K', 'other jobs must retain the older global fact instead of borrowing a company-specific condition');
    assert.equal(listCandidateFacts(database, fixture.profileId, { job: {} }).find(fact => fact.factKey === 'expected_salary').factValue, '15-18K', 'general optimization uses global facts only');
  } finally { database.close(); }
}

function createFixture(database) {
  const now = "2026-08-28T02:00:00.000Z";
  const profileId = Number(database.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, source_hash, created_at, updated_at
  ) VALUES ('Learning candidate', '{}', NULL, ?, ?)`).run(now, now).lastInsertRowid);
  const planId = Number(database.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
  ) VALUES (?, 'Learning plan', '{}', NULL, 1, ?, ?)`).run(profileId, now, now).lastInsertRowid);
  const jobId = Number(database.prepare(`INSERT INTO jobs(
    source, source_id, title, first_seen_at, last_seen_at
  ) VALUES ('boss', 'learning-job', 'Learning job', ?, ?)`).run(now, now).lastInsertRowid);
  const cardId = Number(database.prepare(`INSERT INTO candidate_progress_cards(
    profile_id, plan_id, job_id, source, stage, next_action, last_event_at, created_at, updated_at
  ) VALUES (?, ?, ?, 'boss', 'reply_ready', 'Review draft before manual send', ?, ?, ?)`)
    .run(profileId, planId, jobId, now, now, now).lastInsertRowid);
  return { profileId, planId, jobId, cardId };
}

function seedDraft(database, fixture, suffix, message, category = "availability") {
  return recordMessageReplyDrafts(database, {
    ...fixture,
    messageGroupKey: digest(suffix),
    questionSummary: "对方正在确认候选人的情况。",
    messageIntent: "information_request",
    messageCategory: category,
    messages: [message],
    createdAt: "2026-08-28T02:00:00.000Z"
  })[0];
}

function digest(value) {
  return `sha256:${require("node:crypto").createHash("sha256").update(value).digest("hex")}`;
}

function currentFacts(database, profileId) {
  return Object.fromEntries(listCandidateFacts(database, profileId).map((fact) => [fact.factKey, fact.factValue]));
}

function sequenceNow(values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

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
  ['我愿意每周去你们办公室两天。', 0],
  ['我能进行日常英文交流，我愿意每周去你们办公室两天。', 0],
  ['我使用办公软件整理数据并完成报表。', 1],
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
    let successfulSendCallbacks = 0;
    await service.completeDraft({ profileId: fixture.profileId, draftId: firstDraft.id,
      finalText: saved.currentText, completionKind: 'sent', afterComplete: () => { successfulSendCallbacks++; } });
    assert.equal(successfulSendCallbacks, 1, 'copied successful answer upgrades to sent once');
    assert.equal(listCandidateAnswerMemories(db, { profileId: fixture.profileId }).find(item => item.id === completed.memoryId).completionKind, 'sent');
    await service.completeDraft({ profileId: fixture.profileId, draftId: firstDraft.id,
      finalText: saved.currentText, completionKind: 'sent', afterComplete: () => { successfulSendCallbacks++; } });
    assert.equal(successfulSendCallbacks, 1, 'sent replay does not repeat callback');

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
    extractionMode = "success";
    const recovery = await service.completeDraft({ profileId: fixture.profileId, draftId: failureDraft.id,
      finalText: "您好，我目前在深圳。", completionKind: "copied" });
    assert.strictEqual(recovery.memoryId, failed.memoryId);
    assert.strictEqual(recovery.extractionStatus, "succeeded", "same completion retries only learning");
    assert.strictEqual(calls.length, 3, "failed extraction is retried once");
    await service.completeDraft({ profileId: fixture.profileId, draftId: failureDraft.id,
      finalText: "您好，我目前在深圳。", completionKind: "copied" });
    assert.strictEqual(calls.length, 3, "successful learning remains idempotent");

    extractionMode = 'failure';
    const sendAfterFailureDraft = seedDraft(db, fixture, 'service-send-after-failure', '我目前在广州。', 'other');
    const pendingSend = await service.completeDraft({ profileId: fixture.profileId,
      draftId: sendAfterFailureDraft.id, finalText: '我目前在深圳。', completionKind: 'copied' });
    assert.equal(pendingSend.extractionStatus, 'failed');
    let failedSendCallbacks = 0;
    const sentAfterFailure = await service.completeDraft({ profileId: fixture.profileId,
      draftId: sendAfterFailureDraft.id, finalText: '我目前在深圳。', completionKind: 'sent',
      afterComplete: () => { failedSendCallbacks++; } });
    assert.equal(failedSendCallbacks, 1, 'sent callback still runs when learning remains failed');
    assert.equal(sentAfterFailure.extractionStatus, 'failed');
    assert.equal(listCandidateAnswerMemories(db, { profileId: fixture.profileId }).find(item => item.id === pendingSend.memoryId).completionKind, 'sent');
    await service.completeDraft({ profileId: fixture.profileId, draftId: sendAfterFailureDraft.id,
      finalText: '我目前在深圳。', completionKind: 'sent', afterComplete: () => { failedSendCallbacks++; } });
    assert.equal(failedSendCallbacks, 1, 'replayed sent completion must not replay callback');
    extractionMode = 'success';

    const concurrentDraft = seedDraft(db, fixture, 'service-concurrent-send', '我目前在广州。', 'other');
    let releaseConcurrent;
    const concurrentService = createMessageReplyLearningService({ db, adapter: {
      extractReplyEditFacts: () => new Promise(resolve => { releaseConcurrent = () => resolve({ facts: [] }); })
    } });
    let concurrentSentCallbacks = 0;
    const copying = concurrentService.completeDraft({ profileId: fixture.profileId,
      draftId: concurrentDraft.id, finalText: '我目前在南京。', completionKind: 'copied' });
    const sending = concurrentService.completeDraft({ profileId: fixture.profileId,
      draftId: concurrentDraft.id, finalText: '我目前在南京。', completionKind: 'sent',
      afterComplete: () => { concurrentSentCallbacks++; } });
    releaseConcurrent();
    const [copiedConcurrent, sentConcurrent] = await Promise.all([copying, sending]);
    assert.equal(copiedConcurrent.memoryId, sentConcurrent.memoryId);
    assert.equal(concurrentSentCallbacks, 1, 'concurrent copy and send retain the sent callback');
    assert.equal(listCandidateAnswerMemories(db, { profileId: fixture.profileId })
      .find(item => item.id === sentConcurrent.memoryId).completionKind, 'sent');

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
    await reusablePersonalInformationSmoke();
    await delayedRevisionSmoke();
    await factsLifecycleSmoke();
    await recoveryLifecycleSmoke();
    await explicitRevertSmoke();
    console.log("message_reply_learning_smoke ok");
  } finally {
    db.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function reusablePersonalInformationSmoke() {
  const database = openDb(':memory:');
  try {
    const fixture = createFixture(database);
    const { candidateReplyMaterial } = require('../src/application/message_discovery/materials');
    const { createMessageReplyAnalyzer } = require('../src/core/message_reply_analyzer');
    let quote = '我能进行日常英文交流。';
    const commitment = '我愿意每周去你们办公室两天。';
    const draft = seedDraft(database, fixture, 'personal-information', '请介绍自己的能力。', 'qualification');
    const service = createMessageReplyLearningService({ db: database, adapter: { async extractReplyEditFacts() {
      return { facts: [], experiences: [
        { subject: '英语沟通能力', sourceQuote: quote },
        { subject: '办公安排', sourceQuote: commitment },
        { subject: '混合回答', sourceQuote: quote + commitment }
      ] };
    } } });
    service.saveDraft({ profileId: fixture.profileId, draftId: draft.id, text: quote + commitment });
    assert.equal(candidateReplyMaterial(database, fixture.profileId).candidateEvidence.length, 0, 'unadopted personal edits must not be learned');
    const completed = await service.completeDraft({ profileId: fixture.profileId, draftId: draft.id,
      finalText: quote + commitment, completionKind: 'copied' });
    async function nextJobReply(expectedQuote) {
      const material = candidateReplyMaterial(database, fixture.profileId);
      const analyze = createMessageReplyAnalyzer({ adapter: { async draftMessageGroup(input) {
        assert.equal(input.answerMemories.length, 0, 'the whole adopted answer stays in the original job');
        assert.deepEqual(input.candidateEvidence.map(entry => entry.text), expectedQuote ? [expectedQuote] : []);
        return { messageIntent: 'information_request', messageCategory: 'qualification', messageSummary: '询问英文能力',
          requiredFactKeys: [], usedFactKeys: [], usedMemoryIds: [], usedEvidenceIds: input.candidateEvidence.map(entry => entry.id),
          responseItems: [], coverage: [], missingFact: null, messages: [expectedQuote || '感谢沟通。'] };
      } } });
      const result = await analyze({ ...material, job: { id: fixture.jobId + 100, company: '另一家公司' },
        messages: [{ text: '英文交流能力如何？' }] });
      assert.deepEqual(result.usedEvidenceIds, material.candidateEvidence.map(entry => entry.id));
      assert.deepEqual(result.messages, [expectedQuote || '感谢沟通。'], 'cross-job reply must actually use the adopted personal information');
    }
    await nextJobReply(quote);
    quote = '我只能阅读英文文档。';
    const revised = await service.reviseMemory({ profileId: fixture.profileId, memoryId: completed.memoryId,
      finalText: quote + commitment });
    await nextJobReply(quote);
    const entry = candidateReplyMaterial(database, fixture.profileId).candidateEvidence[0];
    service.withdrawEvidence({ profileId: fixture.profileId, id: entry.id });
    await service.retryLearning({ profileId: fixture.profileId, memoryId: revised.memoryId });
    await nextJobReply(null);
    service.withdrawMemory({ profileId: fixture.profileId, memoryId: revised.memoryId });
    await nextJobReply(null);
    quote = '我熟练使用Excel制作报表，已取得大学英语六级资格。';
    const additionalDraft = seedDraft(database, fixture, 'personal-tools-qualification', '请补充个人技能。', 'qualification');
    const additional = await service.completeDraft({ profileId: fixture.profileId, draftId: additionalDraft.id,
      finalText: quote + commitment, completionKind: 'copied' });
    await nextJobReply(quote);
    service.withdrawMemory({ profileId: fixture.profileId, memoryId: additional.memoryId });
    await nextJobReply(null);
  } finally { database.close(); }
}

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
  const failingEdit = createMessageReplyLearningService({ db: database, adapter: { async extractReplyEditFacts() {
    throw new Error('temporary extraction failure');
  } } });
  const failedRevision = await failingEdit.reviseMemory({ profileId: fixture.profileId,
    memoryId: latest.memoryId, finalText: quote + condition.replace('20K', '28K') });
  assert.equal(failedRevision.extractionStatus, 'failed');
  assert.equal(listCandidateEvidence(database, { profileId: fixture.profileId })[0]?.text, quote);
  const confirmedEntry = listCandidateEvidence(database, { profileId: fixture.profileId })[0];
  salaryOnly.reviseEvidence({ profileId: fixture.profileId, id: confirmedEntry.id,
    subject: confirmedEntry.subject, text: `${quote} 补充：我也做了回归验证。` });
  database.prepare('UPDATE candidate_evidence_entries SET updated_at = ? WHERE id = ?')
    .run('2026-10-20T00:00:00.000Z', confirmedEntry.id);
  const factsOnlyRecovery = createMessageReplyLearningService({ db: database, adapter: { async extractReplyEditFacts() {
    return { facts: [], experiences: [] };
  } } });
  await factsOnlyRecovery.retryLearning({ profileId: fixture.profileId, memoryId: failedRevision.memoryId });
  assert.equal(listCandidateEvidence(database, { profileId: fixture.profileId })[0]?.text,
    `${quote} 补充：我也做了回归验证。`,
    'facts-only recovery retains a confirmed experience from the failed revision');
  assert.equal(listCandidateEvidence(database, { profileId: fixture.profileId })[0]?.updatedAt,
    '2026-10-20T00:00:00.000Z', 'retry keeps the later manual experience correction time');
  const anotherFailedRevision = await failingEdit.reviseMemory({ profileId: fixture.profileId,
    memoryId: failedRevision.memoryId, finalText: quote + condition.replace('20K', '29K') });
  let releaseLearning;
  const delayedRecovery = createMessageReplyLearningService({ db: database, adapter: {
    extractReplyEditFacts: () => new Promise(resolve => { releaseLearning = () => resolve({
      facts: [], experiences: [{ subject: '联调', sourceQuote: quote }]
    }); })
  } });
  const late = delayedRecovery.retryLearning({ profileId: fixture.profileId,
    memoryId: anotherFailedRevision.memoryId });
  const entryToWithdraw = listCandidateEvidence(database, { profileId: fixture.profileId })[0];
  const { withdrawCandidateEvidence } = require('../src/storage/candidate_evidence_store');
  withdrawCandidateEvidence(database, { profileId: fixture.profileId, id: entryToWithdraw.id });
  releaseLearning();
  await late;
  assert.equal(listCandidateEvidence(database, { profileId: fixture.profileId }).length, 0,
    'experience withdrawn during recovery must stay withdrawn');
  salaryOnly.withdrawMemory({ profileId: fixture.profileId, memoryId: anotherFailedRevision.memoryId });
  assert.deepEqual(listCandidateEvidence(database, { profileId: fixture.profileId }), []);
  const rollbackDraft = seedDraft(database, fixture, 'reusable-rollback', '感谢介绍。', 'project_fact');
  await assert.rejects(service.completeDraft({ profileId: fixture.profileId, draftId: rollbackDraft.id,
    finalText: quote, completionKind: 'copied', afterComplete: () => { throw new Error('completion failed'); }
  }), /completion failed/);
  assert.deepEqual(listCandidateEvidence(database, { profileId: fixture.profileId }), [], 'failed completion must roll back its reusable story');
  assert(!listCandidateAnswerMemories(database, { profileId: fixture.profileId }).some(item => item.draftId === rollbackDraft.id), 'failed completion must roll back its answer memory');
}

async function delayedRevisionSmoke() {
  const database = openDb(':memory:');
  try {
    const fixture = createFixture(database);
    const quote = '我参与接口联调，先复现故障，再对比请求参数找出原因。';
    const salary = '这份岗位我期望薪资20K。';
    const draft = seedDraft(database, fixture, 'delayed-revision', '我做过接口联调。', 'project_fact');
    const service = createMessageReplyLearningService({ db: database, adapter: { async extractReplyEditFacts() {
      return { facts: [], experiences: [{ subject: '排障经历', sourceQuote: quote }] };
    } } });
    const original = await service.completeDraft({ profileId: fixture.profileId, draftId: draft.id,
      finalText: quote + salary, completionKind: 'copied' });
    let release;
    const delayed = createMessageReplyLearningService({ db: database, adapter: {
      extractReplyEditFacts: () => new Promise(resolve => { release = () => resolve({
        facts: [], experiences: [{ subject: '排障经历', sourceQuote: quote }]
      }); })
    } });
    const pending = delayed.reviseMemory({ profileId: fixture.profileId, memoryId: original.memoryId,
      finalText: quote + salary.replace('20K', '25K') });
    const { listCandidateEvidence } = require('../src/storage/candidate_evidence_store');
    const evidence = listCandidateEvidence(database, { profileId: fixture.profileId })[0];
    delayed.withdrawEvidence({ profileId: fixture.profileId, id: evidence.id });
    release();
    await pending;
    assert.equal(listCandidateEvidence(database, { profileId: fixture.profileId }).length, 0,
      'a story withdrawn while revision waits must not be restored by the late extractor');

    const correctionDraft = seedDraft(database, fixture, 'delayed-correction', '我做过接口联调。', 'project_fact');
    const corrected = await service.completeDraft({ profileId: fixture.profileId, draftId: correctionDraft.id,
      finalText: quote + salary, completionKind: 'copied' });
    const correctionPending = delayed.reviseMemory({ profileId: fixture.profileId, memoryId: corrected.memoryId,
      finalText: quote + salary.replace('20K', '25K') });
    const correction = listCandidateEvidence(database, { profileId: fixture.profileId })[0];
    const revisedText = `${quote} 补充：我也做了回归验证。`;
    delayed.reviseEvidence({ profileId: fixture.profileId, id: correction.id,
      subject: correction.subject, text: revisedText });
    release();
    await correctionPending;
    assert.equal(listCandidateEvidence(database, { profileId: fixture.profileId })[0]?.text, revisedText,
      'a manual correction made while revision waits must win over the old extractor result');

    const withdrawnDraft = seedDraft(database, fixture, 'delayed-source-withdrawn', '我做过接口联调。', 'project_fact');
    const withdrawn = await service.completeDraft({ profileId: fixture.profileId, draftId: withdrawnDraft.id,
      finalText: quote + salary, completionKind: 'copied' });
    const withdrawnPending = delayed.reviseMemory({ profileId: fixture.profileId, memoryId: withdrawn.memoryId,
      finalText: quote + salary.replace('20K', '25K') });
    delayed.withdrawMemory({ profileId: fixture.profileId, memoryId: withdrawn.memoryId });
    release();
    await assert.rejects(withdrawnPending, error => error.code === 'CANDIDATE_ANSWER_MEMORY_NOT_CURRENT',
      'a source answer withdrawn during extraction cannot receive a late revision');

    const supersededDraft = seedDraft(database, fixture, 'delayed-source-superseded', '我做过接口联调。', 'project_fact');
    const superseded = await service.completeDraft({ profileId: fixture.profileId, draftId: supersededDraft.id,
      finalText: quote + salary, completionKind: 'copied' });
    const supersededPending = delayed.reviseMemory({ profileId: fixture.profileId, memoryId: superseded.memoryId,
      finalText: quote + salary.replace('20K', '25K') });
    const newer = await service.reviseMemory({ profileId: fixture.profileId, memoryId: superseded.memoryId,
      finalText: quote + salary.replace('20K', '26K') });
    release();
    await assert.rejects(supersededPending, error => error.code === 'CANDIDATE_ANSWER_MEMORY_NOT_CURRENT',
      'a superseded source answer cannot receive a late revision');
    assert.equal(listCandidateAnswerMemories(database, { profileId: fixture.profileId })
      .find(item => item.draftId === supersededDraft.id)?.id, newer.memoryId);
  } finally { database.close(); }
}

async function recoveryLifecycleSmoke() {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = 'D:\\DevData\\OfferGo-validation\\2026-10-03\\learning-recovery';
  fs.mkdirSync(root, { recursive: true });
  const dbPath = path.join(root, `reply-recovery-${process.pid}.sqlite`);
  let database = openDb(dbPath);
  try {
    const fixture = createFixture(database);
    const draft = seedDraft(database, fixture, 'restart-recovery', '我目前在广州。', 'other');
    const failedService = createMessageReplyLearningService({ db: database, now: () => '2026-10-01T00:00:00.000Z',
      adapter: { async extractReplyEditFacts() { throw new Error('temporary failure'); } } });
    const failed = await failedService.completeDraft({ profileId: fixture.profileId, draftId: draft.id,
      finalText: '我目前在深圳。', completionKind: 'copied' });
    assert.equal(failed.extractionStatus, 'failed');
    assert.equal(failedService.listCommunicationProfile({ profileId: fixture.profileId }).answers[0].learning.status, 'failed');
    database.close();
    database = openDb(dbPath);
    const resumedFailure = createMessageReplyLearningService({ db: database, now: () => '2026-10-01T00:00:00.000Z',
      adapter: { async extractReplyEditFacts() { throw new Error('temporary failure'); } } });
    let calls = 0;
    const successful = createMessageReplyLearningService({ db: database, now: () => '2026-10-06T00:00:00.000Z',
      adapter: { async extractReplyEditFacts() { calls++; return { facts: [
        { factKey: 'current_city', factValue: '深圳', evidenceText: '深圳' }
      ] }; } } });
    const { recordCandidateFactValue } = require('../src/storage/message_learning_store');
    recordCandidateFactValue(database, { profileId: fixture.profileId, factKey: 'current_city', factValue: '成都',
      occurredAt: '2026-10-05T00:00:00.000Z' });
    successful.setMemoryScope({ profileId: fixture.profileId, memoryId: failed.memoryId, scopeKind: 'global' });
    const [a, b] = await Promise.all([
      successful.retryLearning({ profileId: fixture.profileId, memoryId: failed.memoryId }),
      successful.retryLearning({ profileId: fixture.profileId, memoryId: failed.memoryId })
    ]);
    assert.equal(a.extractionStatus, 'succeeded');
    assert.equal(b.memoryId, a.memoryId);
    assert.equal(calls, 1, 'concurrent retry shares one extraction');
    assert.equal(currentFacts(database, fixture.profileId).current_city, '成都', 'later manual fact wins over recovered old fact');
    assert.equal(listCandidateAnswerMemories(database, { profileId: fixture.profileId })
      .find(item => item.id === failed.memoryId).scope.kind, 'global', 'retry preserves manually selected answer scope');
    assert.equal(listCandidateFactRevisions(database, { profileId: fixture.profileId, factKey: 'current_city' })
      .filter(item => item.answerMemoryId === failed.memoryId).length, 1, 'recovered fact is written once');
    await successful.retryLearning({ profileId: fixture.profileId, memoryId: failed.memoryId });
    assert.equal(calls, 1, 'success is durable after retry');

    const withdrawnDraft = seedDraft(database, fixture, 'withdrawn-recovery', '我目前在广州。', 'other');
    const withdrawn = await resumedFailure.completeDraft({ profileId: fixture.profileId, draftId: withdrawnDraft.id,
      finalText: '我目前在佛山。', completionKind: 'copied' });
    resumedFailure.withdrawMemory({ profileId: fixture.profileId, memoryId: withdrawn.memoryId });
    await assert.rejects(successful.retryLearning({ profileId: fixture.profileId, memoryId: withdrawn.memoryId }),
      error => error.code === 'CANDIDATE_ANSWER_MEMORY_NOT_CURRENT');
    await assert.rejects(successful.completeDraft({ profileId: fixture.profileId, draftId: withdrawnDraft.id,
      finalText: '我目前在佛山。', completionKind: 'copied' }),
      error => error.code === 'CANDIDATE_ANSWER_MEMORY_WITHDRAWN');

    const deletedDraft = seedDraft(database, fixture, 'delete-recovery', '我目前在广州。', 'other');
    const pending = await resumedFailure.completeDraft({ profileId: fixture.profileId, draftId: deletedDraft.id,
      finalText: '我目前在东莞。', completionKind: 'copied' });
    successful.deleteFact({ profileId: fixture.profileId, factKey: 'current_city' });
    await successful.retryLearning({ profileId: fixture.profileId, memoryId: pending.memoryId });
    assert.equal(currentFacts(database, fixture.profileId).current_city, undefined, 'later deletion tombstone wins over recovered old fact');

    const racingDraft = seedDraft(database, fixture, 'racing-recovery', '我目前在广州。', 'other');
    const racingMemory = await resumedFailure.completeDraft({ profileId: fixture.profileId,
      draftId: racingDraft.id, finalText: '我目前在珠海。', completionKind: 'copied' });
    let release;
    const racing = createMessageReplyLearningService({ db: database, adapter: {
      extractReplyEditFacts: () => new Promise(resolve => { release = () => resolve({ facts: [
        { factKey: 'current_city', factValue: '珠海', evidenceText: '珠海' }
      ] }); })
    } });
    const attempt = racing.retryLearning({ profileId: fixture.profileId, memoryId: racingMemory.memoryId });
    racing.withdrawMemory({ profileId: fixture.profileId, memoryId: racingMemory.memoryId });
    release();
    await assert.rejects(attempt, error => error.code === 'CANDIDATE_ANSWER_MEMORY_NOT_CURRENT');
    assert.equal(listCandidateFactRevisions(database, { profileId: fixture.profileId, factKey: 'current_city' })
      .filter(item => item.answerMemoryId === racingMemory.memoryId).length, 0,
      'withdrawal during extraction prevents late fact writes');

    const supersededDraft = seedDraft(database, fixture, 'superseded-recovery', '我目前在广州。', 'other');
    const superseded = await resumedFailure.completeDraft({ profileId: fixture.profileId,
      draftId: supersededDraft.id, finalText: '我目前在珠海。', completionKind: 'copied' });
    const staleAttempt = racing.retryLearning({ profileId: fixture.profileId, memoryId: superseded.memoryId });
    await successful.reviseMemory({ profileId: fixture.profileId, memoryId: superseded.memoryId,
      finalText: '我目前在中山。' });
    release();
    await assert.rejects(staleAttempt, error => error.code === 'CANDIDATE_ANSWER_MEMORY_NOT_CURRENT');
    assert.equal(listCandidateFactRevisions(database, { profileId: fixture.profileId, factKey: 'current_city' })
      .filter(item => item.answerMemoryId === superseded.memoryId).length, 0,
      'superseded answer cannot receive late learning');

    const olderPendingDraft = seedDraft(database, fixture, 'older-pending-recovery', '我目前在广州。', 'other');
    const olderPending = await resumedFailure.completeDraft({ profileId: fixture.profileId,
      draftId: olderPendingDraft.id, finalText: '我目前在珠海。', completionKind: 'copied' });
    const newerSuccessDraft = seedDraft(database, fixture, 'newer-success-recovery', '我目前在广州。', 'other');
    await successful.completeDraft({ profileId: fixture.profileId, draftId: newerSuccessDraft.id,
      finalText: '我目前在深圳。', completionKind: 'copied' });
    const selected = await successful.retryPendingLearning({ profileId: fixture.profileId, limit: 1 });
    assert.equal(selected?.memoryId, olderPending.memoryId,
      'bounded pending retry scans past newer successful answers');

    const laterClockFailure = createMessageReplyLearningService({ db: database,
      now: () => '2026-10-02T00:00:00.000Z',
      adapter: { async extractReplyEditFacts() { throw new Error('temporary failure'); } } });
    const validPendingDraft = seedDraft(database, fixture, 'rotating-valid-pending', '我目前在广州。', 'other');
    const validPending = await laterClockFailure.completeDraft({ profileId: fixture.profileId,
      draftId: validPendingDraft.id, finalText: '我目前在佛山。', completionKind: 'copied' });
    const invalidPendingDraft = seedDraft(database, fixture, 'rotating-invalid-pending', '我目前在广州。', 'other');
    const invalidPending = await resumedFailure.completeDraft({ profileId: fixture.profileId,
      draftId: invalidPendingDraft.id, finalText: '我目前在珠海。', completionKind: 'copied' });
    const rotating = createMessageReplyLearningService({ db: database,
      now: () => '2026-10-06T00:00:00.000Z', adapter: { async extractReplyEditFacts(input) {
        if (input.finalText.includes('珠海')) throw new Error('still invalid');
        return { facts: [] };
      } } });
    const firstVisit = await rotating.retryPendingLearning({ profileId: fixture.profileId, limit: 1 });
    assert.equal(firstVisit.memoryId, invalidPending.memoryId);
    assert.equal(firstVisit.extractionStatus, 'failed');
    const secondVisit = await rotating.retryPendingLearning({ profileId: fixture.profileId, limit: 1 });
    assert.equal(secondVisit.memoryId, validPending.memoryId,
      'failed latest answer rotates behind another pending answer on the next visit');
    assert.equal(secondVisit.extractionStatus, 'succeeded');

    const deepPendingDraft = seedDraft(database, fixture, 'deep-pending-recovery', '我目前在广州。', 'other');
    const deepPending = await resumedFailure.completeDraft({ profileId: fixture.profileId,
      draftId: deepPendingDraft.id, finalText: '我目前在佛山。', completionKind: 'copied' });
    const { completeMessageReplyDraft } = require('../src/core/storage');
    const { recordMessageReplyLearningStatus } = require('../src/storage/message_learning_store');
    for (let index = 0; index < 501; index++) {
      const newer = seedDraft(database, fixture, `newer-success-${index}`, '我目前在广州。', 'other');
      const memory = completeMessageReplyDraft(database, { profileId: fixture.profileId,
        draftId: newer.id, finalText: '我目前在深圳。', changedText: '深圳',
        completionKind: 'copied', completedAt: '2026-10-07T00:00:00.000Z' });
      recordMessageReplyLearningStatus(database, { profileId: fixture.profileId,
        memoryId: memory.id, status: 'succeeded', at: '2026-10-07T00:00:00.000Z' });
    }
    const deepSelected = await successful.retryPendingLearning({ profileId: fixture.profileId, limit: 1 });
    assert.equal(deepSelected?.memoryId, deepPending.memoryId,
      'pending selection filters before limiting even behind 501 newer successful answers');
  } finally {
    database.close();
    fs.rmSync(dbPath, { force: true });
  }
}

async function explicitRevertSmoke() {
  const database = openDb(':memory:');
  try {
    const fixture = createFixture(database);
    const draft = seedDraft(database, fixture, 'explicit-revert', '我目前在广州。', 'other');
    let clock = '2026-10-01T00:00:00.000Z';
    let callbacks = 0;
    const service = createMessageReplyLearningService({ db: database, now: () => clock,
      adapter: { async extractReplyEditFacts(input) {
        const city = input.finalText.includes('珠海') ? '珠海' : '深圳';
        return { facts: [{ factKey: 'current_city', factValue: city, evidenceText: city }] };
      } } });
    const a = await service.completeDraft({ profileId: fixture.profileId, draftId: draft.id,
      finalText: '我目前在深圳。', completionKind: 'copied', afterComplete: () => { callbacks++; } });
    clock = '2026-10-02T00:00:00.000Z';
    const b = await service.reviseMemory({ profileId: fixture.profileId, memoryId: a.memoryId,
      finalText: '我目前在珠海。' });
    clock = '2026-10-03T00:00:00.000Z';
    const reverted = await service.reviseMemory({ profileId: fixture.profileId, memoryId: b.memoryId,
      finalText: '我目前在深圳。' });
    assert.notEqual(reverted.memoryId, a.memoryId, 'explicit A-B-A edit is a fresh confirmation');
    assert.equal(currentFacts(database, fixture.profileId).current_city, '深圳');
    assert.equal(listCandidateFactRevisions(database, { profileId: fixture.profileId, factKey: 'current_city' })
      .find(item => item.answerMemoryId === reverted.memoryId).createdAt, clock);
    assert.equal(callbacks, 1, 'explicit profile edits do not replay the original completion callback');
    assert.equal(listCandidateAnswerMemories(database, { profileId: fixture.profileId, activeOnly: false })
      .filter(item => item.draftId === draft.id).length, 3);
    await assert.rejects(service.completeDraft({ profileId: fixture.profileId, draftId: draft.id,
      finalText: '我目前在珠海。', completionKind: 'copied' }),
      error => error.code === 'CANDIDATE_ANSWER_MEMORY_SUPERSEDED');
  } finally { database.close(); }
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

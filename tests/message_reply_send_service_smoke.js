const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const storage = require("../src/core/storage");
const { listPendingMessageReplyLearning, getMessageReplyLearningStatus } = require("../src/storage/message_learning_store");
const { createMessageReplyLearningService } = require("../src/application/message_learning");
const { createMessageReplySendingService } = require("../src/application/message_reply_sending");
const {
  transitionReplySendBatch,
  transitionReplySendItem
} = require("../src/core/message_reply_send_batches");

const db = storage.openDb(":memory:");
let assertionsFinished = false;
process.once('beforeExit', () => {
  if (!assertionsFinished) {
    console.error('message reply service checks exited with unfinished asynchronous assertions');
    process.exitCode = 1;
  }
});

(async () => {
  try {
    const now = "2026-08-29T03:00:00.000Z";
    const owner = createOwner(db, now);
    const other = createOwner(db, now, "other");
    const extractionCalls = [];
    const learningService = createMessageReplyLearningService({
      db,
      adapter: {
        async extractReplyEditFacts(input) {
          extractionCalls.push(structuredClone(input));
          return { scope: input.scope, facts: [] };
        }
      },
      now: () => now
    });
    const executed = [];
    const executionErrors = [];
    const service = createMessageReplySendingService({
      db,
      learningService,
      now: () => now,
      executeBatch(batchId) { executed.push(batchId); },
      onExecutionError(error) { executionErrors.push(error); }
    });

    const unsuitable = seedDraft(db, owner, "unsuitable", "不应发送", now);
    saveContext(db, owner, unsuitable, "378917037748769", now);
    const unsuitableBatchId = storage.createBatch(db, "boss", "unsuitable", "message reply test", {
      profileId: owner.profileId, searchPlanId: owner.planId
    });
    db.prepare("UPDATE jobs SET batch_id = ?, analysis_json = ? WHERE id = ?")
      .run(unsuitableBatchId, JSON.stringify({ semanticStatus: "complete", revision: { pipelineVersions: require('../src/core/analysis_revision').PIPELINE_VERSIONS }, recommendation: "not_recommended", recommendationSchemaVersion: 2 }), unsuitable.jobId);
    assert.throws(
      () => service.confirmBatch({ profileId: owner.profileId,
        items: [{ draftId: unsuitable.draft.id, revision: unsuitable.draft.revision }] }),
      (error) => error.code === "MESSAGE_REPLY_SEND_JOB_NOT_RECOMMENDED"
    );
    assert.equal(executed.length, 0, "an unsuitable historical draft must never start a send batch");

    const first = seedDraft(db, owner, "first", "模型初稿", now);
    saveContext(db, owner, first, "378917037748770", now);
    const edited = storage.saveMessageReplyDraftEdit(db, {
      profileId: owner.profileId,
      draftId: first.draft.id,
      text: "这是用户点击确认时的最终文字。",
      updatedAt: now
    });
    assert.throws(
      () => service.confirmBatch({
        profileId: owner.profileId,
        items: [{
          draftId: edited.id,
          revision: edited.revision,
          replyText: "不得信任前端文字"
        }]
      }),
      (error) => error.code === "MESSAGE_REPLY_SEND_INPUT_INVALID"
    );
    const confirmed = service.confirmBatch({
      profileId: owner.profileId,
      items: [{ draftId: edited.id, revision: edited.revision }]
    });
    assert.equal(confirmed.batch.status, "confirmed");
    assert.equal(confirmed.items[0].replyText, "这是用户点击确认时的最终文字。");
    assert.deepEqual(executed, [], "executor must not run inside the confirmation transaction");
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(executed, [confirmed.batch.id]);
    assert.deepEqual(executionErrors, []);
    const publicStatus = service.status({ profileId: owner.profileId, batchId: confirmed.batch.id });
    assert(!JSON.stringify(publicStatus).includes("这是用户点击确认时的最终文字。"));
    assert(!Object.hasOwn(publicStatus.items[0], "replyText"));
    assert(!Object.hasOwn(publicStatus.items[0], "conversationKey"));
    assert.throws(
      () => service.status({ profileId: other.profileId, batchId: confirmed.batch.id }),
      (error) => error.code === "MESSAGE_REPLY_SEND_BATCH_NOT_FOUND"
    );

    storage.saveMessageReplyDraftEdit(db, {
      profileId: owner.profileId,
      draftId: edited.id,
      text: "确认之后继续输入的新文字",
      updatedAt: now
    });
    assert.equal(storage.listMessageReplySendItems(db, {
      profileId: owner.profileId,
      batchId: confirmed.batch.id
    })[0].replyText, "这是用户点击确认时的最终文字。");

    assert.throws(
      () => transitionReplySendItem(db, {
        profileId: owner.profileId,
        batchId: confirmed.batch.id,
        itemId: confirmed.items[0].id,
        expectedStatus: "pending",
        status: "succeeded",
        updatedAt: now
      }),
      (error) => error.code === "MESSAGE_REPLY_SEND_TRANSITION_INVALID"
    );
    transitionReplySendBatch(db, {
      profileId: owner.profileId,
      batchId: confirmed.batch.id,
      expectedStatus: "confirmed",
      status: "running",
      updatedAt: now
    });
    let firstItem = confirmed.items[0];
    for (const status of ["selecting", "verified", "filled"]) {
      firstItem = transitionReplySendItem(db, {
        profileId: owner.profileId,
        batchId: confirmed.batch.id,
        itemId: firstItem.id,
        expectedStatus: firstItem.status,
        status,
        updatedAt: now
      });
    }
    firstItem = transitionReplySendItem(db, {
      profileId: owner.profileId,
      batchId: confirmed.batch.id,
      itemId: firstItem.id,
      expectedStatus: "filled",
      status: "click_dispatched",
      clickCount: 1,
      updatedAt: now
    });
    const completed = await service.completeVerifiedItem({
      batchId: confirmed.batch.id,
      itemId: firstItem.id
    });
    assert.equal(completed.item.status, "succeeded");
    assert.equal(completed.learning.draftId, edited.id);
    assert(storage.getMessageReplyDraft(db, { profileId: owner.profileId, draftId: edited.id }).closedAt);
    assert.equal(storage.getMessageInboundContext(db, {
      profileId: owner.profileId,
      cardId: first.cardId,
      messageGroupKey: first.groupKey
    }), null);
    assert.equal(countMemories(db, edited.id), 1);
    assert.equal(countSentEvents(db, first.cardId), 1);
    const repeated = await service.completeVerifiedItem({
      batchId: confirmed.batch.id,
      itemId: firstItem.id
    });
    assert.equal(repeated.item.status, "succeeded");
    assert.equal(countMemories(db, edited.id), 1);
    assert.equal(countSentEvents(db, first.cardId), 1);

    const missingContext = seedDraft(db, owner, "missing-context", "缺少上下文", now);
    assert.throws(
      () => service.confirmBatch({
        profileId: owner.profileId,
        items: [{ draftId: missingContext.draft.id, revision: missingContext.draft.revision }]
      }),
      (error) => error.code === "MESSAGE_REPLY_SEND_CONTEXT_REQUIRED"
    );
    assert.throws(
      () => service.confirmBatch({
        profileId: other.profileId,
        items: [{ draftId: missingContext.draft.id, revision: missingContext.draft.revision }]
      }),
      (error) => error.code === "MESSAGE_REPLY_SEND_DRAFT_NOT_FOUND"
    );

    const stale = seedDraft(db, owner, "stale", "旧版本", now);
    saveContext(db, owner, stale, "378917037748771", now);
    assert.throws(
      () => service.confirmBatch({
        profileId: owner.profileId,
        items: [{ draftId: stale.draft.id, revision: stale.draft.revision + 1 }]
      }),
      (error) => error.code === "MESSAGE_REPLY_SEND_REVISION_CONFLICT"
    );

    const empty = seedDraft(db, owner, "empty", "会被清空", now);
    saveContext(db, owner, empty, "378917037748772", now);
    const emptyEdited = storage.saveMessageReplyDraftEdit(db, {
      profileId: owner.profileId,
      draftId: empty.draft.id,
      text: "",
      updatedAt: now
    });
    assert.throws(
      () => service.confirmBatch({
        profileId: owner.profileId,
        items: [{ draftId: emptyEdited.id, revision: emptyEdited.revision }]
      }),
      (error) => error.code === "MESSAGE_REPLY_SEND_TEXT_INVALID"
    );

    const invalidIdentity = seedDraft(db, owner, "identity", "身份无效", now);
    saveContext(db, owner, invalidIdentity, "378917037748773", now);
    db.prepare("UPDATE message_inbound_contexts SET source_job_id = '' WHERE card_id = ? AND message_group_key = ?")
      .run(invalidIdentity.cardId, invalidIdentity.groupKey);
    assert.throws(
      () => service.confirmBatch({
        profileId: owner.profileId,
        items: [{ draftId: invalidIdentity.draft.id, revision: invalidIdentity.draft.revision }]
      }),
      (error) => error.code === "MESSAGE_INBOUND_CONTEXT_INVALID"
    );

    const closed = seedDraft(db, owner, "closed", "已关闭", now);
    saveContext(db, owner, closed, "378917037748774", now);
    storage.completeMessageReplyDraft(db, {
      profileId: owner.profileId,
      draftId: closed.draft.id,
      finalText: closed.draft.currentText,
      completionKind: "sent",
      completedAt: now
    });
    assert.throws(
      () => service.confirmBatch({
        profileId: owner.profileId,
        items: [{ draftId: closed.draft.id, revision: closed.draft.revision }]
      }),
      (error) => error.code === "MESSAGE_REPLY_SEND_DRAFT_CLOSED"
    );
    assert.throws(
      () => service.confirmBatch({
        profileId: owner.profileId,
        items: [
          { draftId: stale.draft.id, revision: stale.draft.revision },
          { draftId: stale.draft.id, revision: stale.draft.revision }
        ]
      }),
      (error) => error.code === "MESSAGE_REPLY_SEND_DRAFT_DUPLICATE"
    );
    assert.throws(
      () => service.confirmBatch({
        profileId: owner.profileId,
        items: Array.from({ length: 51 }, () => ({ draftId: stale.draft.id, revision: stale.draft.revision }))
      }),
      (error) => error.code === "MESSAGE_REPLY_SEND_ITEMS_INVALID"
    );

    const atomic = seedDraft(db, owner, "atomic", "原子失败前的草稿", now);
    saveContext(db, owner, atomic, "378917037748775", now);
    const atomicBatch = service.confirmBatch({
      profileId: owner.profileId,
      items: [{ draftId: atomic.draft.id, revision: atomic.draft.revision }]
    });
    await Promise.resolve();
    transitionReplySendBatch(db, {
      profileId: owner.profileId,
      batchId: atomicBatch.batch.id,
      expectedStatus: "confirmed",
      status: "running",
      updatedAt: now
    });
    let atomicItem = atomicBatch.items[0];
    for (const status of ["selecting", "verified", "filled"]) {
      atomicItem = transitionReplySendItem(db, {
        profileId: owner.profileId,
        batchId: atomicBatch.batch.id,
        itemId: atomicItem.id,
        expectedStatus: atomicItem.status,
        status,
        updatedAt: now
      });
    }
    atomicItem = transitionReplySendItem(db, {
      profileId: owner.profileId,
      batchId: atomicBatch.batch.id,
      itemId: atomicItem.id,
      expectedStatus: "filled",
      status: "click_dispatched",
      clickCount: 1,
      updatedAt: now
    });
    db.exec(`CREATE TEMP TRIGGER fail_reply_send_progress
      BEFORE INSERT ON candidate_progress_events
      WHEN NEW.type = 'reply_confirmed_sent'
      BEGIN SELECT RAISE(ABORT, 'forced reply send progress failure'); END`);
    await assert.rejects(
      () => service.completeVerifiedItem({ batchId: atomicBatch.batch.id, itemId: atomicItem.id }),
      /forced reply send progress failure/
    );
    assert.equal(storage.listMessageReplySendItems(db, {
      profileId: owner.profileId,
      batchId: atomicBatch.batch.id
    })[0].status, "click_dispatched", "local rollback must retain the non-retryable post-click state");
    assert.equal(storage.getMessageReplyDraft(db, {
      profileId: owner.profileId,
      draftId: atomic.draft.id
    }).closedAt, "");
    assert.equal(countMemories(db, atomic.draft.id), 0);
    assert(storage.getMessageInboundContext(db, {
      profileId: owner.profileId,
      cardId: atomic.cardId,
      messageGroupKey: atomic.groupKey
    }), "rolled-back local completion must retain the open HR context");
    db.exec("DROP TRIGGER fail_reply_send_progress");
    db.exec(`CREATE TEMP TRIGGER fail_reply_send_cleanup
      BEFORE DELETE ON message_inbound_contexts
      WHEN OLD.card_id = ${atomic.cardId}
      BEGIN SELECT RAISE(ABORT, 'forced reply context cleanup failure'); END`);
    await assert.rejects(() => service.completeVerifiedItem({ batchId: atomicBatch.batch.id,
      itemId: atomicItem.id }), /forced reply context cleanup failure/);
    assert.equal(storage.listMessageReplySendItems(db, { profileId: owner.profileId,
      batchId: atomicBatch.batch.id })[0].status, 'click_dispatched');
    assert.equal(storage.getMessageReplyDraft(db, { profileId: owner.profileId,
      draftId: atomic.draft.id }).closedAt, '');
    assert.equal(countMemories(db, atomic.draft.id), 0);
    assert.equal(countSentEvents(db, atomic.cardId), 0);
    db.exec('DROP TRIGGER fail_reply_send_cleanup');

    const stopFirst = seedDraft(db, owner, "stop-first", "第一条待停止", now);
    const stopSecond = seedDraft(db, owner, "stop-second", "第二条待停止", now);
    saveContext(db, owner, stopFirst, "378917037748776", now);
    saveContext(db, owner, stopSecond, "378917037748777", now);
    const stopBatch = service.confirmBatch({
      profileId: owner.profileId,
      items: [
        { draftId: stopFirst.draft.id, revision: stopFirst.draft.revision },
        { draftId: stopSecond.draft.id, revision: stopSecond.draft.revision }
      ]
    });
    await Promise.resolve();
    transitionReplySendBatch(db, {
      profileId: owner.profileId,
      batchId: stopBatch.batch.id,
      expectedStatus: "confirmed",
      status: "running",
      updatedAt: now
    });
    let dispatched = stopBatch.items[0];
    for (const status of ["selecting", "verified", "filled"]) {
      dispatched = transitionReplySendItem(db, {
        profileId: owner.profileId,
        batchId: stopBatch.batch.id,
        itemId: dispatched.id,
        expectedStatus: dispatched.status,
        status,
        updatedAt: now
      });
    }
    transitionReplySendItem(db, {
      profileId: owner.profileId,
      batchId: stopBatch.batch.id,
      itemId: dispatched.id,
      expectedStatus: "filled",
      status: "click_dispatched",
      clickCount: 1,
      updatedAt: now
    });
    const stopped = service.stop({ profileId: owner.profileId, batchId: stopBatch.batch.id });
    assert.deepEqual(stopped.items.map((item) => item.status), ["click_dispatched", "stopped"]);
    assert.equal(stopped.batch.status, "interrupted");

    const qualityOwner = createOwner(db, now, "quality");
    const evidenceDraft = seedDraft(db, qualityOwner, "evidence", "模型未填写联系方式", now);
    const evidence = storage.completeMessageReplyDraft(db, {
      profileId: qualityOwner.profileId,
      draftId: evidenceDraft.draft.id,
      finalText: "用户确认手机号是 13800138000。",
      changedText: "用户确认手机号是 13800138000。",
      scope: { kind: "global", key: "" },
      completionKind: "copied",
      extractedFacts: [],
      completedAt: now
    });
    const unsupported = seedDraft(db, qualityOwner, "unsupported", "我的手机号是 13800138000。", now);
    saveContext(db, qualityOwner, unsupported, "378917037748778", now);
    storage.withdrawCandidateAnswerMemory(db, {
      profileId: qualityOwner.profileId,
      memoryId: evidence.id,
      withdrawnAt: "2026-08-29T03:01:00.000Z"
    });
    const batchCountBeforeQualityFailure = db.prepare("SELECT COUNT(*) AS n FROM message_reply_send_batches").get().n;
    assert.throws(
      () => service.confirmBatch({
        profileId: qualityOwner.profileId,
        items: [{ draftId: unsupported.draft.id, revision: unsupported.draft.revision }]
      }),
      (error) => error.code === "MESSAGE_DRAFT_FACT_UNSUPPORTED"
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM message_reply_send_batches").get().n, batchCountBeforeQualityFailure,
      "an unsupported untouched model draft must fail before a batch is created");
    const userConfirmed = storage.saveMessageReplyDraftEdit(db, {
      profileId: qualityOwner.profileId,
      draftId: unsupported.draft.id,
      text: "用户亲自补充：我的手机号是 13800138000。",
      updatedAt: "2026-08-29T03:02:00.000Z"
    });
    const userConfirmedBatch = service.confirmBatch({
      profileId: qualityOwner.profileId,
      items: [{ draftId: userConfirmed.id, revision: userConfirmed.revision }]
    });
    assert.equal(userConfirmedBatch.batch.status, "confirmed", "a user edit is the authoritative confirmation input");

    const factOwner = createOwner(db, now, "fact-evidence");
    storage.saveCandidateFact(db, {
      profileId: factOwner.profileId,
      factKey: "availability_date",
      factValue: "本周三",
      source: "user_provided"
    });
    const supportedByFact = seedDraft(db, factOwner, "supported", "我本周三可以到岗。", now);
    saveContext(db, factOwner, supportedByFact, "378917037748779", now);
    const supportedBatch = service.confirmBatch({
      profileId: factOwner.profileId,
      items: [{ draftId: supportedByFact.draft.id, revision: supportedByFact.draft.revision }]
    });
    assert.equal(supportedBatch.batch.status, "confirmed", "a current candidate fact should support the untouched model draft");

    await sentAfterLearningOptOutSmoke({ db, owner, learningService, service, now });
    await verifiedSendPersistsBeforeLearningSmoke({ db, owner, now });
    await verifiedSendLearningFailureSmoke({ db, owner, now });
    await verifiedSendBypassesCopiedLearningSmoke({ db, owner, now });
    await sentDuringLearningRaceSmoke({ db, owner, now });
    await manualSentAfterCloseSmoke({ db, owner, learningService, now });

    console.log("message_reply_send_service_smoke ok");
  } finally {
    db.close();
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(() => { assertionsFinished = true; });

function createOwner(database, now, suffix = "main") {
  const profileId = Number(database.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, source_hash, created_at, updated_at
  ) VALUES (?, '{}', NULL, ?, ?)`).run(`Reply sender ${suffix}`, now, now).lastInsertRowid);
  const planId = Number(database.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
  ) VALUES (?, ?, '{}', NULL, 1, ?, ?)`).run(profileId, `Reply plan ${suffix}`, now, now).lastInsertRowid);
  return { profileId, planId, suffix };
}

function seedDraft(database, owner, suffix, text, now) {
  const jobId = Number(database.prepare(`INSERT INTO jobs(
    source, source_id, title, first_seen_at, last_seen_at
  ) VALUES ('boss', ?, ?, ?, ?)`).run(`boss:send-${owner.suffix}-${suffix}`, `Send ${suffix}`, now, now).lastInsertRowid);
  const cardId = Number(database.prepare(`INSERT INTO candidate_progress_cards(
    profile_id, plan_id, job_id, source, stage, next_action, last_event_at, created_at, updated_at
  ) VALUES (?, ?, ?, 'boss', 'reply_ready', 'Review reply', ?, ?, ?)`)
    .run(owner.profileId, owner.planId, jobId, now, now, now).lastInsertRowid);
  const groupKey = digest(`group:${owner.suffix}:${suffix}`);
  const draft = storage.recordMessageReplyDrafts(database, {
    profileId: owner.profileId,
    cardId,
    jobId,
    messageGroupKey: groupKey,
    questionSummary: "对方正在确认候选人的任职资格。",
    messageIntent: "information_request",
    messageCategory: "qualification",
    messages: [text],
    createdAt: now
  })[0];
  return { cardId, jobId, groupKey, draft, suffix };
}

function saveContext(database, owner, entry, lastMessageId, now) {
  return storage.saveMessageInboundContext(database, {
    profileId: owner.profileId,
    cardId: entry.cardId,
    messageGroupKey: entry.groupKey,
    conversationKey: digest(`conversation:${owner.suffix}:${entry.suffix}`),
    sourceJobId: `boss:send-${owner.suffix}-${entry.suffix}`,
    lastMessageId,
    messageIntent: "information_request",
    messageCategory: "qualification",
    inboundMessages: [{ kind: "text", text: `HR context ${entry.suffix}` }],
    manualActions: [],
    createdAt: now,
    updatedAt: now
  });
}

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(String(value)).digest("hex")}`;
}

function countMemories(database, draftId) {
  return Number(database.prepare("SELECT COUNT(*) AS n FROM candidate_answer_memories WHERE draft_id = ?")
    .get(draftId).n);
}

function countSentEvents(database, cardId) {
  return Number(database.prepare(`SELECT COUNT(*) AS n FROM candidate_progress_events
    WHERE card_id = ? AND type = 'reply_confirmed_sent'`).get(cardId).n);
}

async function sentAfterLearningOptOutSmoke({ db: database, owner, learningService, service, now }) {
  for (const mode of ['withdrawn', 'withdrawn-closed', 'superseded']) {
    const withdrawn = mode.startsWith('withdrawn');
    const entry = seedDraft(database, owner, `learning-${mode}`, '我目前在广州。', now);
    saveContext(database, owner, entry, mode === 'withdrawn' ? '378917037748790'
      : mode === 'withdrawn-closed' ? '378917037748794' : '378917037748791', now);
    const edited = storage.saveMessageReplyDraftEdit(database, { profileId: owner.profileId,
      draftId: entry.draft.id, text: '我目前在深圳。', updatedAt: now });
    const copied = await learningService.completeDraft({ profileId: owner.profileId,
      draftId: edited.id, finalText: edited.currentText, completionKind: 'copied' });
    if (withdrawn) learningService.withdrawMemory({ profileId: owner.profileId, memoryId: copied.memoryId });
    const batch = service.confirmBatch({ profileId: owner.profileId,
      items: [{ draftId: edited.id, revision: edited.revision }] });
    if (mode === 'withdrawn-closed') storage.closeMessageReplyDrafts(database, {
      profileId: owner.profileId, cardId: entry.cardId, closedAt: now });
    if (mode === 'superseded') await learningService.reviseMemory({ profileId: owner.profileId,
      memoryId: copied.memoryId, finalText: '我目前在珠海。' });
    transitionReplySendBatch(database, { profileId: owner.profileId, batchId: batch.batch.id,
      expectedStatus: 'confirmed', status: 'running', updatedAt: now });
    let item = batch.items[0];
    for (const status of ['selecting', 'verified', 'filled']) {
      item = transitionReplySendItem(database, { profileId: owner.profileId, batchId: batch.batch.id,
        itemId: item.id, expectedStatus: item.status, status, updatedAt: now });
    }
    item = transitionReplySendItem(database, { profileId: owner.profileId, batchId: batch.batch.id,
      itemId: item.id, expectedStatus: 'filled', status: 'click_dispatched', clickCount: 1, updatedAt: now });
    const factsBefore = storage.listCandidateFactRevisions(database, { profileId: owner.profileId }).length;
    const evidenceBefore = database.prepare('SELECT COUNT(*) AS n FROM candidate_evidence_entries WHERE profile_id = ?').get(owner.profileId).n;
    const completed = await service.completeVerifiedItem({ batchId: batch.batch.id, itemId: item.id });
    assert.equal(completed.item.status, 'succeeded', `${mode} learning opt-out must not block verified send bookkeeping`);
    assert.equal(completed.learning.learningSkipped, withdrawn ? 'withdrawn' : 'superseded');
    assert.equal(storage.getMessageReplyDraft(database, { profileId: owner.profileId, draftId: edited.id }).currentText,
      '我目前在深圳。', 'sent snapshot stays the actual confirmed text');
    assert.equal(countSentEvents(database, entry.cardId), 1);
    assert.equal(storage.listCandidateFactRevisions(database, { profileId: owner.profileId }).length, factsBefore);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM candidate_evidence_entries WHERE profile_id = ?').get(owner.profileId).n,
      evidenceBefore);
    const history = storage.listCandidateAnswerMemories(database, { profileId: owner.profileId,
      activeOnly: false }).filter(memory => memory.draftId === edited.id);
    const old = history.find(memory => memory.id === copied.memoryId);
    assert.equal(Boolean(old.withdrawnAt), withdrawn);
    assert.equal(old.completionKind, 'copied', 'historical learning memory is not changed into a sent fact');
    const repeated = await service.completeVerifiedItem({ batchId: batch.batch.id, itemId: item.id });
    assert.equal(repeated.item.status, 'succeeded');
    assert.equal(countSentEvents(database, entry.cardId), 1);
    let repeatedCallback = 0;
    const restartedLearning = createMessageReplyLearningService({ db: database, now: () => now });
    await restartedLearning.completeDraft({ profileId: owner.profileId, draftId: edited.id,
      finalText: '我目前在深圳。', completionKind: 'sent',
      completionKey: `message-reply-send:${batch.batch.id}:${item.id}`,
      afterComplete() { repeatedCallback++; } });
    assert.equal(repeatedCallback, 0, 'persistent sent evidence prevents callback replay after restart');
  }
  const rollback = seedDraft(database, owner, 'learning-opt-out-rollback', '我目前在广州。', now);
  const saved = await learningService.completeDraft({ profileId: owner.profileId,
    draftId: rollback.draft.id, finalText: '我目前在深圳。', completionKind: 'copied' });
  learningService.withdrawMemory({ profileId: owner.profileId, memoryId: saved.memoryId });
  await assert.rejects(learningService.completeDraft({ profileId: owner.profileId,
    draftId: rollback.draft.id, finalText: '我目前在深圳。', completionKind: 'sent',
    afterComplete() { throw new Error('sent bookkeeping failed'); }
  }), /sent bookkeeping failed/);
  assert.equal(storage.getMessageReplyDraft(database, { profileId: owner.profileId,
    draftId: rollback.draft.id }).closedAt, '', 'callback failure rolls back sent-only draft closure');
  assert(storage.listCandidateAnswerMemories(database, { profileId: owner.profileId,
    activeOnly: false }).find(memory => memory.id === saved.memoryId).withdrawnAt);
}

async function sentDuringLearningRaceSmoke({ db: database, owner, now }) {
  for (const mode of ['withdrawn', 'superseded']) {
    const entry = seedDraft(database, owner, `learning-race-${mode}`, '我目前在广州。', now);
    saveContext(database, owner, entry, mode === 'withdrawn' ? '378917037748792' : '378917037748793', now);
    const edited = storage.saveMessageReplyDraftEdit(database, { profileId: owner.profileId,
      draftId: entry.draft.id, text: '我目前在深圳。', updatedAt: now });
    let release;
    let started;
    const learningStarted = new Promise(resolve => { started = resolve; });
    const slowLearning = createMessageReplyLearningService({ db: database, now: () => now,
      adapter: { extractReplyEditFacts: () => new Promise(resolve => {
        release = () => resolve({ facts: [] }); started();
      }) } });
    const fastLearning = createMessageReplyLearningService({ db: database, now: () => now,
      adapter: { async extractReplyEditFacts() { return { facts: [] }; } } });
    const sender = createMessageReplySendingService({ db: database, learningService: slowLearning,
      now: () => now, executeBatch() {} });
    const batch = sender.confirmBatch({ profileId: owner.profileId,
      items: [{ draftId: edited.id, revision: edited.revision }] });
    transitionReplySendBatch(database, { profileId: owner.profileId, batchId: batch.batch.id,
      expectedStatus: 'confirmed', status: 'running', updatedAt: now });
    let item = batch.items[0];
    for (const status of ['selecting', 'verified', 'filled']) {
      item = transitionReplySendItem(database, { profileId: owner.profileId, batchId: batch.batch.id,
        itemId: item.id, expectedStatus: item.status, status, updatedAt: now });
    }
    item = transitionReplySendItem(database, { profileId: owner.profileId, batchId: batch.batch.id,
      itemId: item.id, expectedStatus: 'filled', status: 'click_dispatched', clickCount: 1, updatedAt: now });
    const finishing = sender.completeVerifiedItem({ batchId: batch.batch.id, itemId: item.id });
    await learningStarted;
    const completed = await finishing;
    assert.equal(storage.listMessageReplySendItems(database, { profileId: owner.profileId,
      batchId: batch.batch.id })[0].status, 'succeeded');
    if (mode === 'withdrawn') fastLearning.withdrawMemory({ profileId: owner.profileId,
      memoryId: completed.learning.memoryId });
    else await fastLearning.reviseMemory({ profileId: owner.profileId,
      memoryId: completed.learning.memoryId, finalText: '我目前在珠海。' });
    release();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(completed.item.status, 'succeeded', `${mode} during extraction must not block verified send`);
    assert.equal(storage.getMessageReplyDraft(database, { profileId: owner.profileId, draftId: edited.id }).currentText,
      mode === 'withdrawn' ? '我目前在深圳。' : '我目前在珠海。');
    assert.equal(storage.listMessageReplySendItems(database, { profileId: owner.profileId,
      batchId: batch.batch.id })[0].replyText, '我目前在深圳。', 'later profile edits do not change the sent snapshot');
    assert.equal(countSentEvents(database, entry.cardId), 1);
    assert.equal(countMemories(database, edited.id), mode === 'withdrawn' ? 1 : 2,
      'late model result cannot create a ghost memory');
  }
}

async function verifiedSendPersistsBeforeLearningSmoke({ db: database, owner, now }) {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const { runMessageReplySendBatch } = require('../src/core/message_reply_send_executor');
  const { createMessageReplySendController } = require('../src/dashboard/message_reply_send_controller');
  const entry = seedDraft(database, owner, 'verified-learning-delay', '我目前在广州。', now);
  saveContext(database, owner, entry, '378917037748799', now);
  const edited = storage.saveMessageReplyDraftEdit(database, { profileId: owner.profileId,
    draftId: entry.draft.id, text: '我目前在深圳。', updatedAt: now });
  let release;
  let started;
  const learningStarted = new Promise(resolve => { started = resolve; });
  const learning = createMessageReplyLearningService({ db: database, now: () => now,
    adapter: { async extractReplyEditFacts(input) {
      started();
      await new Promise(resolve => { release = resolve; });
      return { scope: input.scope, facts: [] };
    } } });
  const service = createMessageReplySendingService({ db: database, learningService: learning,
    now: () => now, executeBatch() {} });
  const batch = service.confirmBatch({ profileId: owner.profileId,
    items: [{ draftId: edited.id, revision: edited.revision }] });
  let clicks = 0;
  const execution = runMessageReplySendBatch({ db: database, batchId: batch.batch.id,
    now: () => now,
    sender: { async inspectReplyTarget() { return {}; }, async fillReply() { return {}; },
      async dispatchReply() { clicks++; }, async clearPreparedReply() {},
      async verifyReplyResult() { return { state: 'succeeded', evidence: { verified: true } }; } },
    accessController: { async reserve() {} },
    onVerifiedSuccess: input => service.completeVerifiedItem(input) });
  await learningStarted;
  let restarted;
  let controller;
  const snapshotPath = path.join(os.tmpdir(), `offergo-verified-learning-${crypto.randomUUID()}.sqlite`);
  try {
    const item = storage.listMessageReplySendItems(database, { profileId: owner.profileId,
      batchId: batch.batch.id })[0];
    assert.equal(item.status, 'succeeded', 'platform success must persist before learning finishes');
    assert.equal(countSentEvents(database, entry.cardId), 1);
    assert(storage.getMessageReplyDraft(database, { profileId: owner.profileId, draftId: edited.id }).closedAt);
    assert.equal(storage.getMessageInboundContext(database, { profileId: owner.profileId,
      cardId: entry.cardId, messageGroupKey: entry.groupKey }), null);
    const pending = listPendingMessageReplyLearning(database, { profileId: owner.profileId, limit: 5 });
    assert.equal(pending.length, 1, 'the existing pending-learning path must retain the committed edit');
    const completed = await execution;
    assert.equal(completed.batch.status, 'completed', 'learning must not hold the send batch open');
    database.prepare('VACUUM INTO ?').run(snapshotPath);
    restarted = storage.openDb(snapshotPath);
    const resumedLearning = createMessageReplyLearningService({ db: restarted, now: () => now,
      adapter: { async extractReplyEditFacts(input) { return { scope: input.scope,
        facts: [{ factKey: 'current_city', factValue: '深圳', evidenceText: '我目前在深圳。' }] }; } } });
    controller = createMessageReplySendController({ db: restarted, learningService: resumedLearning,
      browserFactory: async () => { throw new Error('verified send must never reopen the platform'); } });
    const restored = controller.status({ profileId: owner.profileId, batchId: batch.batch.id });
    assert.equal(restored.batch.status, 'completed');
    assert.equal(restored.items[0].status, 'succeeded');
    await resumedLearning.retryPendingLearning({ profileId: owner.profileId, limit: 5 });
    assert.equal(listPendingMessageReplyLearning(restarted, { profileId: owner.profileId }).length, 0);
    assert.equal(countSentEvents(restarted, entry.cardId), 1);
    const replay = await runMessageReplySendBatch({ db: restarted, batchId: batch.batch.id,
      now: () => now,
      sender: { async inspectReplyTarget() {}, async fillReply() {}, async dispatchReply() { clicks++; },
        async verifyReplyResult() {}, async clearPreparedReply() {} },
      accessController: { async reserve() {} }, onVerifiedSuccess() {} });
    assert.equal(replay.batch.status, 'completed');
    assert.equal(clicks, 1, 'restarting and retrying learning must not send again');
  } finally {
    release();
    await execution;
    await new Promise(resolve => setImmediate(resolve));
    await controller?.close();
    restarted?.close();
    fs.rmSync(snapshotPath, { force: true });
  }
}

async function verifiedSendLearningFailureSmoke({ db: database, owner, now }) {
  for (const unexpected of [false, true]) {
    const entry = seedDraft(database, owner, `verified-learning-failure-${unexpected}`, '我目前在广州。', now);
    saveContext(database, owner, entry, unexpected ? '378917037748797' : '378917037748798', now);
    const edited = storage.saveMessageReplyDraftEdit(database, { profileId: owner.profileId,
      draftId: entry.draft.id, text: '我目前在深圳。', updatedAt: now });
    const learning = createMessageReplyLearningService({ db: database, now: () => now,
      adapter: { async extractReplyEditFacts() { throw new Error('synthetic learning failure'); } } });
    if (unexpected) learning.retryLearning = async () => { throw new Error('synthetic retry failure'); };
    const service = createMessageReplySendingService({ db: database, learningService: learning,
      now: () => now, executeBatch() {} });
    const batch = service.confirmBatch({ profileId: owner.profileId,
      items: [{ draftId: edited.id, revision: edited.revision }] });
    transitionReplySendBatch(database, { profileId: owner.profileId, batchId: batch.batch.id,
      expectedStatus: 'confirmed', status: 'running', updatedAt: now });
    let item = batch.items[0];
    for (const status of ['selecting', 'verified', 'filled', 'click_dispatched']) {
      item = transitionReplySendItem(database, { profileId: owner.profileId, batchId: batch.batch.id,
        itemId: item.id, expectedStatus: item.status, status,
        clickCount: status === 'click_dispatched' ? 1 : 0, updatedAt: now });
    }
    const completed = await service.completeVerifiedItem({ batchId: batch.batch.id, itemId: item.id });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(completed.item.status, 'succeeded');
    assert.equal(storage.listMessageReplySendItems(database, { profileId: owner.profileId,
      batchId: batch.batch.id })[0].status, 'succeeded', 'learning errors cannot undo verified sends');
    assert.equal(countSentEvents(database, entry.cardId), 1);
    assert(storage.getMessageReplyDraft(database, { profileId: owner.profileId, draftId: edited.id }).closedAt);
    assert.equal(getMessageReplyLearningStatus(database, { profileId: owner.profileId,
      memoryId: completed.learning.memoryId }).status, unexpected ? 'unavailable' : 'failed');
    assert(listPendingMessageReplyLearning(database, { profileId: owner.profileId, limit: 5 })
      .includes(completed.learning.memoryId));
    await service.completeVerifiedItem({ batchId: batch.batch.id, itemId: item.id });
    assert.equal(countMemories(database, edited.id), 1);
    assert.equal(countSentEvents(database, entry.cardId), 1);
  }
}

async function verifiedSendBypassesCopiedLearningSmoke({ db: database, owner, now }) {
  const entry = seedDraft(database, owner, 'verified-while-copy-learning', '我目前在广州。', now);
  saveContext(database, owner, entry, '378917037748796', now);
  const edited = storage.saveMessageReplyDraftEdit(database, { profileId: owner.profileId,
    draftId: entry.draft.id, text: '我目前在深圳。', updatedAt: now });
  let started;
  let release;
  let attempts = 0;
  const learningStarted = new Promise(resolve => { started = resolve; });
  const learning = createMessageReplyLearningService({ db: database, now: () => now,
    adapter: { async extractReplyEditFacts(input) {
      if (++attempts === 1) {
        started();
        await new Promise(resolve => { release = resolve; });
      }
      return { scope: input.scope, facts: [] };
    } } });
  const copying = learning.completeDraft({ profileId: owner.profileId, draftId: edited.id,
    finalText: edited.currentText, completionKind: 'copied' });
  await learningStarted;
  const service = createMessageReplySendingService({ db: database, learningService: learning,
    now: () => now, executeBatch() {} });
  const batch = service.confirmBatch({ profileId: owner.profileId,
    items: [{ draftId: edited.id, revision: edited.revision }] });
  transitionReplySendBatch(database, { profileId: owner.profileId, batchId: batch.batch.id,
    expectedStatus: 'confirmed', status: 'running', updatedAt: now });
  let item = batch.items[0];
  for (const status of ['selecting', 'verified', 'filled', 'click_dispatched']) {
    item = transitionReplySendItem(database, { profileId: owner.profileId, batchId: batch.batch.id,
      itemId: item.id, expectedStatus: item.status, status,
      clickCount: status === 'click_dispatched' ? 1 : 0, updatedAt: now });
  }
  const completion = service.completeVerifiedItem({ batchId: batch.batch.id, itemId: item.id });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(storage.listMessageReplySendItems(database, { profileId: owner.profileId,
      batchId: batch.batch.id })[0].status, 'succeeded', 'pending copy learning cannot block verified send commit');
    assert.equal(countSentEvents(database, entry.cardId), 1);
    assert(storage.getMessageReplyDraft(database, { profileId: owner.profileId, draftId: edited.id }).closedAt);
  } finally {
    release();
    await Promise.all([copying, completion]);
  }
  assert.equal(countSentEvents(database, entry.cardId), 1);
  assert.equal(countMemories(database, edited.id), 1, 'copy learning must reuse the already committed sent answer');
}

async function manualSentAfterCloseSmoke({ db: database, owner, learningService, now }) {
  const { recordReplyConfirmedSent } = require('../src/core/candidate_progress');
  const entry = seedDraft(database, owner, 'manual-after-close', '我目前在广州。', now);
  const copied = await learningService.completeDraft({ profileId: owner.profileId,
    draftId: entry.draft.id, finalText: '我目前在深圳。', completionKind: 'copied' });
  learningService.withdrawMemory({ profileId: owner.profileId, memoryId: copied.memoryId });
  storage.closeMessageReplyDrafts(database, { profileId: owner.profileId, cardId: entry.cardId, closedAt: now });
  const key = 'progress:13245678-1234-4234-8234-123456789abc';
  let calls = 0;
  const afterComplete = () => {
    calls++;
    recordReplyConfirmedSent(database, { cardId: entry.cardId, idempotencyKey: key,
      summary: '用户确认已手动发送', occurredAt: now });
  };
  await learningService.completeDraft({ profileId: owner.profileId, draftId: entry.draft.id,
    finalText: '我目前在深圳。', completionKind: 'sent', completionKey: key, afterComplete });
  assert.equal(calls, 1, 'non-send closure does not skip first manual sent callback');
  const restarted = createMessageReplyLearningService({ db: database, now: () => now });
  await restarted.completeDraft({ profileId: owner.profileId, draftId: entry.draft.id,
    finalText: '我目前在深圳。', completionKind: 'sent', completionKey: key, afterComplete });
  assert.equal(calls, 1, 'persisted manual sent event prevents replay after restart');
  assert.equal(countSentEvents(database, entry.cardId), 1);
}

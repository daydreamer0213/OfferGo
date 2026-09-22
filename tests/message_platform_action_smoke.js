const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDb } = require("../src/core/storage");
const { upsertMessageEvents } = require("../src/storage/message_timeline_store");
const { upsertMessageInboxItem, getMessageInboxItem } = require("../src/storage/message_inbox_store");
const { createMessageActionController } = require("../src/dashboard/message_action_controller");
const { createMessageActionService } = require("../src/application/message_actions");
const {
  confirmMessageAction,
  getMessageAction,
  transitionMessageAction,
  listActiveMessageActions
} = require("../src/storage/message_action_store");
const { createZhaopinMessageActionSender } = require("../src/adapters/sites/zhaopin_message_action_sender");

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "offergo-message-action-"));
  const db = openDb(path.join(root, "action.sqlite"));
  const now = "2026-09-18T08:00:00.000Z";
  const conversationKey = `sha256:${"a".repeat(64)}`;
  const messageKey = `sha256:${"b".repeat(64)}`;
  try {
    const profileId = Number(db.prepare(`INSERT INTO candidate_profiles(
      display_name, profile_json, created_at, updated_at
    ) VALUES ('Action candidate', '{}', ?, ?)`).run(now, now).lastInsertRowid);
    upsertMessageEvents(db, {
      profileId,
      platform: "zhaopin",
      conversationKey,
      observedAt: now,
      events: [{
        messageKey,
        platformMessageId: "9001",
        direction: "friend",
        kind: "resume_request",
        text: "HR 邀请你发送简历",
        occurredAt: now,
        metadata: { cardType: "11" }
      }]
    });

    const input = {
      profileId,
      platform: "zhaopin",
      conversationKey,
      messageKey,
      actionKind: "resume_request_accept",
      idempotencyKey: "95871075-29c4-41e9-8a21-a28ad5e5735f",
      confirmedAt: now
    };
    const confirmed = confirmMessageAction(db, input);
    assert.equal(confirmed.status, "confirmed");
    assert.equal(confirmed.clickCount, 0);
    assert.deepEqual(confirmed.evidence, { sourceMessageId: "9001", cardType: "11" });
    assert.equal(confirmMessageAction(db, input).id, confirmed.id);
    assert.throws(() => confirmMessageAction(db, {
      ...input,
      actionKind: "resume_request_decline"
    }), (error) => error.code === "MESSAGE_ACTION_IDEMPOTENCY_CONFLICT");
    assert.equal(listActiveMessageActions(db).length, 1);
    transitionMessageAction(db, { profileId, actionId: confirmed.id, expectedStatus: "confirmed", status: "selecting", updatedAt: now });
    transitionMessageAction(db, { profileId, actionId: confirmed.id, expectedStatus: "selecting", status: "verified", updatedAt: now });
    transitionMessageAction(db, { profileId, actionId: confirmed.id, expectedStatus: "verified", status: "click_dispatched", clickCount: 1, updatedAt: now });
    assert.throws(() => transitionMessageAction(db, { profileId, actionId: confirmed.id, expectedStatus: "click_dispatched", status: "verified", clickCount: 1, updatedAt: now }), (error) => error.code === "MESSAGE_ACTION_TRANSITION_INVALID");
    transitionMessageAction(db, { profileId, actionId: confirmed.id, expectedStatus: "click_dispatched", status: "succeeded", clickCount: 1, updatedAt: now });
    assert.equal(getMessageAction(db, { profileId, actionId: confirmed.id }).status, "succeeded");

    let clicked = 0;
    let dispatched = false;
    const selected = {
      conversationKey,
      sourceJobId: "zhaopin:job42",
      messages: [{ messageId: "9001", messageKey, direction: "friend", contentKind: "resume_request", metadata: { cardType: "11" } }]
    };
    const reader = {
      async scanConversationRows() { return { tabId: 7, rows: [{ identityVerified: true, conversationKey, sourceJobId: "zhaopin:job42" }] }; },
      async openQueuedConversation() { return selected; },
      async readSelectedConversation() { return selected; },
      async assertActiveBindings() {}
    };
    const browser = {
      async evalValue(_tabId, expression) {
        if (expression.includes("zhaopin_action_prepare")) return { state: "ready", point: { x: 12, y: 24 }, sourceMessageId: "9001" };
        if (expression.includes("zhaopin_action_verify")) return dispatched
          ? { state: "succeeded", sourceMessageId: "9001" }
          : { state: "still_actionable", sourceMessageId: "9001" };
        throw new Error("unexpected expression");
      },
      async clickAt() { clicked += 1; dispatched = true; }
    };
    const sender = createZhaopinMessageActionSender({ browser, reader, sleepFn: async () => {} });
    const inspection = await sender.inspectTarget({
      platform: "zhaopin", conversationKey, messageKey, actionKind: "resume_request_accept",
      evidence: { sourceMessageId: "9001", cardType: "11" }
    });
    const prepared = await sender.prepareAction(inspection);
    await sender.dispatchAction(prepared);
    assert.equal(clicked, 1);
    assert.deepEqual(await sender.verifyActionResult(prepared), {
      state: "succeeded",
      evidence: { verification: "action_card_resolved", sourceMessageId: "9001" }
    });
    await assert.rejects(() => sender.dispatchAction(prepared), (error) => error.code === "ZHAOPIN_MESSAGE_ACTION_ALREADY_DISPATCHED");

    const messageKey2 = `sha256:${"c".repeat(64)}`;
    upsertMessageEvents(db, {
      profileId, platform: "zhaopin", conversationKey, observedAt: now,
      events: [{ messageKey: messageKey2, platformMessageId: "9002", direction: "friend",
        kind: "resume_request", text: "HR 邀请你发送简历", occurredAt: now, metadata: { cardType: "11" } }]
    });
    upsertMessageInboxItem(db, {
      profileId, platform: "zhaopin", conversationKey, observedAt: now, lastActivityAt: now,
      lastMessageId: "9002", lastDirection: "friend", actionGroup: "needs_action",
      actionCode: "resume_request", latestExcerpt: "HR 邀请你发送简历"
    });
    let controllerClicks = 0;
    const controller = createMessageActionController({
      db,
      now: () => new Date(now),
      browserFactory: async () => ({}),
      cleanupBrowser: async () => {},
      createReader: () => ({}),
      createSender: () => ({
        async inspectTarget() { return {}; },
        async prepareAction() { return {}; },
        async dispatchAction() { controllerClicks += 1; },
        async verifyActionResult() { return { state: "succeeded", evidence: { verification: "fixture" } }; }
      }),
      acquireLease() {}, renewLease() {}, releaseLease() {}, getLease: () => null,
      setIntervalFn: () => 1, clearIntervalFn: () => {}
    });
    const controllerInput = {
      profileId, platform: "zhaopin", conversationKey, messageKey: messageKey2,
      actionKind: "resume_request_decline", idempotencyKey: "17388b84-d274-4eaf-bf07-58d72e87e82f"
    };
    const first = controller.confirm(controllerInput);
    assert.equal(controller.confirm(controllerInput).id, first.id, "duplicate confirmation must reuse the same action");
    let completed;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      completed = controller.status({ profileId, actionId: first.id });
      if (completed.status === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(completed.status, "succeeded");
    assert.equal(controllerClicks, 1, "duplicate confirmation must dispatch exactly one click");
    assert.equal(getMessageInboxItem(db, { profileId, platform: "zhaopin", conversationKey }).actionGroup, "done");
    await controller.close();

    const bossConversationKey = `sha256:${"d".repeat(64)}`;
    const bossMessageKey = `sha256:${"e".repeat(64)}`;
    upsertMessageEvents(db, {
      profileId,
      platform: "boss",
      conversationKey: bossConversationKey,
      observedAt: now,
      events: [{
        messageKey: bossMessageKey,
        platformMessageId: "123456789015924",
        direction: "friend",
        kind: "resume_request",
        text: "方便请您分享最新简历吗？",
        occurredAt: now,
        metadata: {}
      }]
    });
    upsertMessageInboxItem(db, {
      profileId, platform: "boss", conversationKey: bossConversationKey, observedAt: now, lastActivityAt: now,
      lastMessageId: "123456789015924", lastDirection: "friend", actionGroup: "needs_action",
      actionCode: "resume_request", latestExcerpt: "方便请您分享最新简历吗？"
    });
    const bossService = createMessageActionService({ db, now: () => new Date(now) });
    const bossInput = {
      profileId,
      platform: "boss",
      conversationKey: bossConversationKey,
      messageKey: bossMessageKey,
      actionKind: "resume_request_accept",
      idempotencyKey: "77388b84-d274-4eaf-bf07-58d72e87e82f"
    };
    const bossConfirmed = bossService.confirm(bossInput);
    assert.equal(bossConfirmed.platform, "boss");
    assert.deepEqual(bossConfirmed.evidence, { sourceMessageId: "123456789015924", cardType: "" });
    bossService.transition({ profileId, actionId: bossConfirmed.id, expectedStatus: "confirmed", status: "stopped", clickCount: 0 });
    assert.throws(() => bossService.confirm({
      ...bossInput,
      actionKind: "resume_request_decline",
      idempotencyKey: "87388b84-d274-4eaf-bf07-58d72e87e82f"
    }), (error) => error.code === "MESSAGE_ACTION_KIND_UNSUPPORTED");

    const bossRunConversationKey = `sha256:${"f".repeat(64)}`;
    const bossRunMessageKey = `sha256:${"1".repeat(64)}`;
    upsertMessageEvents(db, {
      profileId, platform: "boss", conversationKey: bossRunConversationKey, observedAt: now,
      events: [{ messageKey: bossRunMessageKey, platformMessageId: "123456789015925", direction: "friend",
        kind: "resume_request", text: "可以发下您的简历吗？", occurredAt: now, metadata: {} }]
    });
    upsertMessageInboxItem(db, {
      profileId, platform: "boss", conversationKey: bossRunConversationKey, observedAt: now, lastActivityAt: now,
      lastMessageId: "123456789015925", lastDirection: "friend", actionGroup: "needs_action",
      actionCode: "resume_request", latestExcerpt: "可以发下您的简历吗？"
    });

    let bossClicks = 0;
    const leaseSites = [];
    const bossController = createMessageActionController({
      db,
      now: () => new Date(now),
      browserFactory: async () => ({}),
      cleanupBrowser: async () => {},
      createReader: ({ platform }) => { assert.equal(platform, "boss"); return {}; },
      createSender: ({ platform }) => {
        assert.equal(platform, "boss");
        return {
          async inspectTarget() { return {}; },
          async prepareAction() { return {}; },
          async dispatchAction() { bossClicks += 1; },
          async verifyActionResult() { return { state: "succeeded", evidence: { verification: "fixture" } }; }
        };
      },
      acquireLease(_db, input) { leaseSites.push(input.site); },
      renewLease() {}, releaseLease() {}, getLease: () => null,
      setIntervalFn: () => 1, clearIntervalFn: () => {}
    });
    const bossRun = bossController.confirm({
      ...bossInput,
      conversationKey: bossRunConversationKey,
      messageKey: bossRunMessageKey,
      idempotencyKey: "97388b84-d274-4eaf-bf07-58d72e87e82f"
    });
    let bossCompleted;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      bossCompleted = bossController.status({ profileId, actionId: bossRun.id });
      if (bossCompleted.status === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(bossCompleted.status, "succeeded", JSON.stringify(bossCompleted));
    assert.equal(bossClicks, 1);
    assert.deepEqual(leaseSites, ["boss"]);
    assert.equal(getMessageInboxItem(db, { profileId, platform: "boss", conversationKey: bossRunConversationKey }).actionGroup, "done");
    await bossController.close();

    console.log("message_platform_action_smoke ok");
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });

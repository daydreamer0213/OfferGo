const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDb, SCHEMA_VERSION } = require("../src/core/storage");
const {
  upsertMessageInboxItem,
  listMessageInboxItems,
  getMessageInboxSyncState,
  saveMessageInboxSyncState,
  markMessageInboxItemDone
} = require("../src/storage/message_inbox_store");
const { buildMessageInboxPageState } = require("../src/dashboard/message_discovery_controller");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "offergo-message-inbox-store-"));
const db = openDb(path.join(root, "jobs.sqlite"));

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(String(value)).digest("hex")}`;
}

try {
  assert.equal(SCHEMA_VERSION, 32);
  const createdAt = "2026-09-17T01:50:00.000Z";
  const profileId = Number(db.prepare(`INSERT INTO candidate_profiles(
      display_name, profile_json, source_hash, created_at, updated_at
    ) VALUES (?, '{}', NULL, ?, ?)`).run("Inbox candidate", createdAt, createdAt).lastInsertRowid);
  const conversationKey = digest("conversation-1");
  const input = {
    profileId,
    platform: "boss",
    conversationKey,
    sourceJobId: "boss-job-1",
    lastMessageId: "message-1",
    lastActivityAt: "2026-09-17T02:00:00.000Z",
    lastDirection: "friend",
    unread: true,
    positionTitle: "产品经理",
    company: "示例公司",
    latestExcerpt: "方便聊聊吗？",
    actionGroup: "needs_action",
    actionCode: "reply",
    observedAt: "2026-09-17T02:01:00.000Z"
  };
  let item = upsertMessageInboxItem(db, input);
  assert.equal(item.actionGroup, "needs_action");
  assert.equal(item.firstObservedAt, input.observedAt);
  assert.equal(listMessageInboxItems(db, { profileId }).length, 1);

  item = upsertMessageInboxItem(db, {
    ...input,
    lastMessageId: "message-2",
    unread: false,
    lastDirection: "myself",
    actionGroup: "waiting",
    actionCode: "wait",
    observedAt: "2026-09-17T02:05:00.000Z"
  });
  assert.equal(item.actionGroup, "waiting");
  assert.equal(item.firstObservedAt, input.observedAt, "upsert must preserve the first observation");
  assert.equal(item.lastObservedAt, "2026-09-17T02:05:00.000Z");

  assert.throws(
    () => upsertMessageInboxItem(db, { ...input, platform: "zhaopin", jobSource: "boss" }),
    (error) => error?.code === "MESSAGE_INBOX_SOURCE_MISMATCH"
  );

  assert.equal(getMessageInboxSyncState(db, { profileId, platform: "boss" }), null);
  const sync = saveMessageInboxSyncState(db, {
    profileId,
    platform: "boss",
    lastAttemptedAt: "2026-09-17T02:10:00.000Z",
    lastSuccessfulAt: "2026-09-17T02:10:00.000Z",
    coverageStartAt: "2026-09-14T02:10:00.000Z",
    coverageComplete: true,
    watermarkAt: "2026-09-17T02:00:00.000Z",
    stopCode: ""
  });
  assert.equal(sync.coverageComplete, true);
  assert.equal(sync.watermarkAt, "2026-09-17T02:00:00.000Z");

  assert.equal(markMessageInboxItemDone(db, {
    profileId,
    platform: "boss",
    conversationKey,
    resolvedAt: "2026-09-17T02:12:00.000Z"
  }), true);
  item = listMessageInboxItems(db, { profileId })[0];
  assert.equal(item.actionGroup, "done");
  assert.equal(item.resolvedAt, "2026-09-17T02:12:00.000Z");

  upsertMessageInboxItem(db, {
    ...input,
    conversationKey: digest("conversation-needs-action"),
    observedAt: "2026-09-17T02:13:00.000Z"
  });
  upsertMessageInboxItem(db, {
    ...input,
    conversationKey: digest("conversation-waiting"),
    lastDirection: "myself",
    unread: false,
    actionGroup: "waiting",
    actionCode: "wait",
    observedAt: "2026-09-17T02:14:00.000Z"
  });
  upsertMessageInboxItem(db, {
    ...input,
    conversationKey: digest("conversation-review"),
    actionGroup: "needs_review",
    actionCode: "retry",
    reasonCode: "MESSAGE_DISCOVERY_JOB_CONTEXT_UNAVAILABLE",
    observedAt: "2026-09-17T02:15:00.000Z"
  });
  const pageState = buildMessageInboxPageState(db, {
    profileId,
    now: new Date("2026-09-17T02:10:30.000Z")
  });
  assert.equal(pageState.groups.needsAction[0].primaryAction.label, "查看建议回复");
  assert.equal(pageState.groups.waiting[0].statusText, "已回复，等待对方消息");
  assert.equal(pageState.groups.needsReview[0].technicalReason, undefined);
  assert.equal(pageState.freshness.boss.label, "刚刚同步");
  assert.equal(pageState.counts.total, 4);
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("message_inbox_store_smoke ok");

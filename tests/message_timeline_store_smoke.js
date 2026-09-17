const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const storage = require("../src/core/storage");
const { upsertMessageEvents, listMessageEvents, latestMessageEvent } = require("../src/storage/message_timeline_store");

const digest = value => "sha256:" + crypto.createHash("sha256").update(value).digest("hex");
const NOW = "2026-09-18T01:00:00.000Z";

function insertProfile(db, name) {
  return Number(db.prepare("INSERT INTO candidate_profiles(display_name,profile_json,created_at,updated_at) VALUES (?, '{}', ?, ?)").run(name, NOW, NOW).lastInsertRowid);
}

function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "offergo-timeline-"));
  const db = storage.openDb(path.join(root, "fixture.sqlite"));
  try {
    const profileId = insertProfile(db, "候选人一");
    const otherProfileId = insertProfile(db, "候选人二");
    const conversationKey = digest("conversation-1");
    const first = {
      messageKey: digest("message-1"),
      platformMessageId: "101",
      direction: "friend",
      kind: "text",
      text: "方便沟通吗？",
      occurredAt: "2026-09-18T00:59:00.000Z",
      metadata: { cardType: "" }
    };
    const inserted = upsertMessageEvents(db, { profileId, platform: "zhaopin", conversationKey, observedAt: NOW, events: [first] });
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].text, "方便沟通吗？");

    upsertMessageEvents(db, {
      profileId,
      platform: "zhaopin",
      conversationKey,
      observedAt: "2026-09-18T01:05:00.000Z",
      events: [{ ...first, text: "不能覆盖首次保存的正文", metadata: { cardType: "303", refreshed: true } }]
    });
    let timeline = listMessageEvents(db, { profileId, platform: "zhaopin", conversationKey });
    assert.equal(timeline.length, 1);
    assert.equal(timeline[0].text, "方便沟通吗？");
    assert.deepEqual(timeline[0].metadata, { cardType: "303", refreshed: true });
    assert.equal(timeline[0].firstObservedAt, NOW);
    assert.equal(timeline[0].lastObservedAt, "2026-09-18T01:05:00.000Z");

    upsertMessageEvents(db, {
      profileId,
      platform: "zhaopin",
      conversationKey,
      observedAt: "2026-09-18T01:06:00.000Z",
      events: [
        { messageKey: digest("message-3"), platformMessageId: "103", direction: "platform", kind: "media_ignored", text: "", occurredAt: "2026-09-18T01:02:00.000Z", metadata: { mediaKind: "voice" } },
        { messageKey: digest("message-2"), platformMessageId: "102", direction: "platform", kind: "unknown_card", text: "卡片摘要", occurredAt: "2026-09-18T01:01:00.000Z", metadata: { raw: "x".repeat(5000) } }
      ]
    });
    timeline = listMessageEvents(db, { profileId, platform: "zhaopin", conversationKey });
    assert.deepEqual(timeline.map(item => item.platformMessageId), ["101", "102", "103"]);
    assert.equal(timeline[2].text, "");
    assert(Buffer.byteLength(JSON.stringify(timeline[1].metadata), "utf8") <= 2000);
    assert.equal(latestMessageEvent(db, { profileId, platform: "zhaopin", conversationKey }).platformMessageId, "103");
    assert.deepEqual(listMessageEvents(db, { profileId, platform: "zhaopin", conversationKey, limit: 2 }).map(item => item.platformMessageId), ["102", "103"]);
    assert.equal(listMessageEvents(db, { profileId: otherProfileId, platform: "zhaopin", conversationKey }).length, 0);
    assert.throws(() => upsertMessageEvents(db, { profileId, platform: "zhaopin", conversationKey: "bad", observedAt: NOW, events: [first] }), error => error.code === "MESSAGE_TIMELINE_INPUT_INVALID");
    assert.throws(() => upsertMessageEvents(db, { profileId, platform: "zhaopin", conversationKey, observedAt: NOW, events: [{ ...first, messageKey: "bad" }] }), error => error.code === "MESSAGE_TIMELINE_INPUT_INVALID");
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main();
console.log("message_timeline_store_smoke passed");

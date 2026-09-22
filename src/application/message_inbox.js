const { createHash } = require("node:crypto");
const messageInboxStore = require("../storage/message_inbox_store");
const messageTimelineStore = require("../storage/message_timeline_store");

function restoreLegacyZhaopinResumeRequestEvent(db, { profileId, context } = {}) {
  if (!context || context.platform !== "zhaopin"
    || !Array.isArray(context.manualActions)
    || !context.manualActions.some((item) => item?.kind === "resume_request")
    || !/^sha256:[a-f0-9]{64}$/.test(String(context.conversationKey || ""))
    || !/^\d{1,32}$/.test(String(context.lastMessageId || ""))) return null;
  const events = messageTimelineStore.listMessageEvents(db, {
    profileId,
    platform: "zhaopin",
    conversationKey: context.conversationKey,
    limit: 500
  });
  const existing = events.find((event) => event.platformMessageId === String(context.lastMessageId));
  if (existing) return existing.kind === "resume_request" ? existing : null;
  const messageKey = digest(["zhaopin", context.conversationKey, context.lastMessageId]);
  const observedAt = validIso(context.updatedAt) || validIso(context.createdAt) || new Date().toISOString();
  return messageTimelineStore.upsertMessageEvents(db, {
    profileId,
    platform: "zhaopin",
    conversationKey: context.conversationKey,
    observedAt,
    events: [{
      messageKey,
      platformMessageId: context.lastMessageId,
      direction: "friend",
      kind: "resume_request",
      text: "HR 邀请你发送简历",
      occurredAt: observedAt,
      metadata: { cardType: "11", restoredFrom: "message_inbound_context" }
    }]
  })[0] || null;
}

function digest(parts) {
  const canonical = parts.map((item) => String(item == null ? "" : item).trim()).join("\0");
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function validIso(value) {
  return Number.isFinite(Date.parse(String(value || ""))) ? new Date(value).toISOString() : "";
}

module.exports = {
  upsertMessageInboxItem: messageInboxStore.upsertMessageInboxItem,
  getMessageInboxItem: messageInboxStore.getMessageInboxItem,
  listMessageInboxItems: messageInboxStore.listMessageInboxItems,
  markMessageInboxItemDone: messageInboxStore.markMessageInboxItemDone,
  deleteMessageInboxItem: messageInboxStore.deleteMessageInboxItem,
  getMessageInboxSyncState: messageInboxStore.getMessageInboxSyncState,
  saveMessageInboxSyncState: messageInboxStore.saveMessageInboxSyncState,
  listMessageEvents: messageTimelineStore.listMessageEvents,
  latestMessageEvent: messageTimelineStore.latestMessageEvent,
  restoreLegacyZhaopinResumeRequestEvent
};

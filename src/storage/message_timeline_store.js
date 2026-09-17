const { immediateTransaction, storageError } = require("./storage_shared");

const PLATFORMS = new Set(["boss", "zhaopin"]);
const DIRECTIONS = new Set(["friend", "myself", "platform", "unknown"]);
const KINDS = new Set([
  "text", "platform_notice", "resume_request", "interview_invitation",
  "contact_exchange", "media_ignored", "unknown_card"
]);

function upsertMessageEvents(db, input = {}) {
  const profileId = positiveInteger(input.profileId, "profileId");
  const platform = enumValue(input.platform, PLATFORMS, "platform");
  const conversationKey = digestValue(input.conversationKey, "conversationKey");
  const observedAt = isoValue(input.observedAt, "observedAt");
  if (!Array.isArray(input.events)) throw timelineError("events must be an array");
  const events = input.events.map(normalizeEvent);
  const uniqueKeys = [...new Set(events.map(event => event.messageKey))];
  return immediateTransaction(db, () => {
    const upsert = db.prepare(`INSERT INTO message_events(
      profile_id, platform, conversation_key, message_key, platform_message_id,
      direction, kind, text, occurred_at, metadata_json, first_observed_at, last_observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, platform, conversation_key, message_key) DO UPDATE SET
      metadata_json = excluded.metadata_json,
      last_observed_at = excluded.last_observed_at`);
    for (const event of events) {
      upsert.run(profileId, platform, conversationKey, event.messageKey, event.platformMessageId,
        event.direction, event.kind, event.text, event.occurredAt, JSON.stringify(event.metadata), observedAt, observedAt);
    }
    const get = db.prepare(`SELECT * FROM message_events
      WHERE profile_id = ? AND platform = ? AND conversation_key = ? AND message_key = ?`);
    return uniqueKeys.map(messageKey => mapEvent(get.get(profileId, platform, conversationKey, messageKey)));
  });
}

function listMessageEvents(db, input = {}) {
  const profileId = positiveInteger(input.profileId, "profileId");
  const platform = enumValue(input.platform, PLATFORMS, "platform");
  const conversationKey = digestValue(input.conversationKey, "conversationKey");
  const limit = boundedLimit(input.limit);
  return db.prepare(`SELECT * FROM (
      SELECT * FROM message_events
      WHERE profile_id = ? AND platform = ? AND conversation_key = ?
      ORDER BY COALESCE(occurred_at, first_observed_at) DESC, id DESC
      LIMIT ?
    ) ORDER BY COALESCE(occurred_at, first_observed_at), id`)
    .all(profileId, platform, conversationKey, limit)
    .map(mapEvent);
}

function latestMessageEvent(db, input = {}) {
  const values = listMessageEvents(db, { ...input, limit: 1 });
  return values[0] || null;
}

function normalizeEvent(input) {
  if (!input || typeof input !== "object") throw timelineError("event must be an object");
  const kind = enumValue(input.kind, KINDS, "kind");
  const text = String(input.text || "").trim().slice(0, 4000);
  if (!["media_ignored", "platform_notice", "unknown_card"].includes(kind) && !text) {
    throw timelineError("actionable message text is required");
  }
  return {
    messageKey: digestValue(input.messageKey, "messageKey"),
    platformMessageId: inlineText(input.platformMessageId, 240),
    direction: enumValue(input.direction, DIRECTIONS, "direction"),
    kind,
    text,
    occurredAt: optionalIsoValue(input.occurredAt, "occurredAt"),
    metadata: safeMetadata(input.metadata)
  };
}

function safeMetadata(value) {
  let normalized;
  try {
    normalized = value && typeof value === "object" ? JSON.parse(JSON.stringify(value)) : {};
  } catch {
    throw timelineError("metadata must be JSON serializable");
  }
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") <= 2000) return normalized;
  const compact = { _truncated: true };
  for (const [key, item] of Object.entries(normalized)) {
    const safeKey = String(key).slice(0, 80);
    const safeValue = typeof item === "string" ? item.slice(0, 256)
      : typeof item === "number" || typeof item === "boolean" || item == null ? item
        : undefined;
    if (safeValue === undefined) continue;
    const candidate = { ...compact, [safeKey]: safeValue };
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > 2000) break;
    compact[safeKey] = safeValue;
  }
  return compact;
}

function mapEvent(row) {
  return {
    id: Number(row.id),
    profileId: Number(row.profile_id),
    platform: row.platform,
    conversationKey: row.conversation_key,
    messageKey: row.message_key,
    platformMessageId: row.platform_message_id || "",
    direction: row.direction,
    kind: row.kind,
    text: row.text || "",
    occurredAt: row.occurred_at || null,
    metadata: parseMetadata(row.metadata_json),
    firstObservedAt: row.first_observed_at,
    lastObservedAt: row.last_observed_at
  };
}

function parseMetadata(value) {
  try { return JSON.parse(value || "{}"); } catch { return {}; }
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw timelineError(`${name} must be a positive integer`);
  return number;
}

function digestValue(value, name) {
  const digest = String(value || "").trim().toLowerCase();
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw timelineError(`${name} must be a sha256 digest`);
  return digest;
}

function enumValue(value, allowed, name) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!allowed.has(normalized)) throw timelineError(`${name} is invalid`);
  return normalized;
}

function isoValue(value, name) {
  const text = String(value || "").trim();
  if (!Number.isFinite(Date.parse(text))) throw timelineError(`${name} must be an ISO timestamp`);
  return new Date(text).toISOString();
}

function optionalIsoValue(value, name) {
  return value == null || value === "" ? null : isoValue(value, name);
}

function inlineText(value, limit) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function boundedLimit(value) {
  if (value == null || value === "") return 500;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw timelineError("limit must be a positive integer");
  return Math.min(number, 1000);
}

function timelineError(message) {
  return storageError("MESSAGE_TIMELINE_INPUT_INVALID", message);
}

module.exports = { upsertMessageEvents, listMessageEvents, latestMessageEvent };

const { storageError } = require("./storage_shared");

const PLATFORMS = new Set(["boss", "zhaopin"]);
const DIRECTIONS = new Set(["friend", "myself", "platform", "unknown"]);
const ACTION_GROUPS = new Set(["needs_action", "waiting", "needs_review", "done"]);
const ACTION_ORDER_SQL = `CASE action_group
  WHEN 'needs_action' THEN 1
  WHEN 'waiting' THEN 2
  WHEN 'needs_review' THEN 3
  ELSE 4 END`;

function upsertMessageInboxItem(db, input = {}) {
  const profileId = positiveInteger(input.profileId, "profileId");
  const platform = platformValue(input.platform);
  const conversationKey = digestValue(input.conversationKey, "conversationKey");
  const observedAt = isoValue(input.observedAt, "observedAt");
  const lastActivityAt = isoValue(input.lastActivityAt || observedAt, "lastActivityAt");
  const jobId = optionalPositiveInteger(input.jobId, "jobId");
  const cardId = optionalPositiveInteger(input.cardId, "cardId");
  assertSourceOwnership(db, { profileId, platform, jobId, cardId, jobSource: input.jobSource });
  const actionGroup = enumValue(input.actionGroup, ACTION_GROUPS, "MESSAGE_INBOX_ACTION_INVALID");
  const lastDirection = enumValue(input.lastDirection || "unknown", DIRECTIONS, "MESSAGE_INBOX_DIRECTION_INVALID");
  db.prepare(`INSERT INTO message_inbox_items(
      profile_id, platform, conversation_key, source_job_id, job_id, card_id,
      last_message_id, last_activity_at, last_direction, unread,
      position_title, company, latest_excerpt, action_group, action_code,
      reason_code, first_observed_at, last_observed_at, resolved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, platform, conversation_key) DO UPDATE SET
      source_job_id = excluded.source_job_id,
      job_id = COALESCE(excluded.job_id, job_id),
      card_id = COALESCE(excluded.card_id, card_id),
      last_message_id = excluded.last_message_id,
      last_activity_at = excluded.last_activity_at,
      last_direction = excluded.last_direction,
      unread = excluded.unread,
      position_title = CASE WHEN excluded.position_title <> '' THEN excluded.position_title ELSE position_title END,
      company = CASE WHEN excluded.company <> '' THEN excluded.company ELSE company END,
      latest_excerpt = excluded.latest_excerpt,
      action_group = excluded.action_group,
      action_code = excluded.action_code,
      reason_code = excluded.reason_code,
      last_observed_at = excluded.last_observed_at,
      resolved_at = excluded.resolved_at`)
    .run(
      profileId,
      platform,
      conversationKey,
      inlineText(input.sourceJobId, 240),
      jobId,
      cardId,
      inlineText(input.lastMessageId, 240),
      lastActivityAt,
      lastDirection,
      input.unread === true ? 1 : 0,
      inlineText(input.positionTitle, 240),
      inlineText(input.company, 240),
      inlineText(input.latestExcerpt, 1000),
      actionGroup,
      inlineText(input.actionCode, 80),
      inlineText(input.reasonCode, 120),
      observedAt,
      observedAt,
      actionGroup === "done" ? isoValue(input.resolvedAt || observedAt, "resolvedAt") : null
    );
  return getMessageInboxItem(db, { profileId, platform, conversationKey });
}

function getMessageInboxItem(db, { profileId, platform, conversationKey } = {}) {
  const row = db.prepare(`SELECT * FROM message_inbox_items
    WHERE profile_id = ? AND platform = ? AND conversation_key = ?`).get(
    positiveInteger(profileId, "profileId"),
    platformValue(platform),
    digestValue(conversationKey, "conversationKey")
  );
  return row ? mapItem(row) : null;
}

function listMessageInboxItems(db, { profileId } = {}) {
  return db.prepare(`SELECT * FROM message_inbox_items
    WHERE profile_id = ?
    ORDER BY ${ACTION_ORDER_SQL}, last_activity_at DESC, conversation_key`)
    .all(positiveInteger(profileId, "profileId"))
    .map(mapItem);
}

function markMessageInboxItemDone(db, input = {}) {
  const result = db.prepare(`UPDATE message_inbox_items
    SET action_group = 'done', action_code = '', reason_code = ?, unread = 0,
      resolved_at = ?, last_observed_at = ?
    WHERE profile_id = ? AND platform = ? AND conversation_key = ?`).run(
    inlineText(input.reasonCode, 120),
    isoValue(input.resolvedAt, "resolvedAt"),
    isoValue(input.resolvedAt, "resolvedAt"),
    positiveInteger(input.profileId, "profileId"),
    platformValue(input.platform),
    digestValue(input.conversationKey, "conversationKey")
  );
  return result.changes > 0;
}

function deleteMessageInboxItem(db, input = {}) {
  const result = db.prepare(`DELETE FROM message_inbox_items
    WHERE profile_id = ? AND platform = ? AND conversation_key = ?`).run(
    positiveInteger(input.profileId, "profileId"),
    platformValue(input.platform),
    digestValue(input.conversationKey, "conversationKey")
  );
  return result.changes > 0;
}

function getMessageInboxSyncState(db, { profileId, platform } = {}) {
  const row = db.prepare(`SELECT * FROM message_inbox_sync_states
    WHERE profile_id = ? AND platform = ?`).get(
    positiveInteger(profileId, "profileId"),
    platformValue(platform)
  );
  return row ? mapSyncState(row) : null;
}

function saveMessageInboxSyncState(db, input = {}) {
  const profileId = positiveInteger(input.profileId, "profileId");
  const platform = platformValue(input.platform);
  db.prepare(`INSERT INTO message_inbox_sync_states(
      profile_id, platform, last_attempted_at, last_successful_at,
      coverage_start_at, coverage_complete, watermark_at, stop_code
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, platform) DO UPDATE SET
      last_attempted_at = excluded.last_attempted_at,
      last_successful_at = excluded.last_successful_at,
      coverage_start_at = excluded.coverage_start_at,
      coverage_complete = excluded.coverage_complete,
      watermark_at = excluded.watermark_at,
      stop_code = excluded.stop_code`).run(
    profileId,
    platform,
    isoValue(input.lastAttemptedAt, "lastAttemptedAt"),
    optionalIsoValue(input.lastSuccessfulAt, "lastSuccessfulAt"),
    optionalIsoValue(input.coverageStartAt, "coverageStartAt"),
    input.coverageComplete === true ? 1 : 0,
    optionalIsoValue(input.watermarkAt, "watermarkAt"),
    inlineText(input.stopCode, 120)
  );
  return getMessageInboxSyncState(db, { profileId, platform });
}

function assertSourceOwnership(db, { profileId, platform, jobId, cardId, jobSource }) {
  if (jobSource != null && String(jobSource).trim() !== platform) {
    throw inboxError("MESSAGE_INBOX_SOURCE_MISMATCH", "message inbox job source does not match the platform");
  }
  if (jobId != null) {
    const row = db.prepare("SELECT source FROM jobs WHERE id = ?").get(jobId);
    if (!row || row.source !== platform) {
      throw inboxError("MESSAGE_INBOX_SOURCE_MISMATCH", "message inbox job does not belong to the platform");
    }
  }
  if (cardId != null) {
    const row = db.prepare(`SELECT cards.profile_id, cards.source AS card_source, jobs.source AS job_source
      FROM candidate_progress_cards cards JOIN jobs ON jobs.id = cards.job_id
      WHERE cards.id = ?`).get(cardId);
    if (!row || Number(row.profile_id) !== profileId || row.card_source !== platform || row.job_source !== platform) {
      throw inboxError("MESSAGE_INBOX_SOURCE_MISMATCH", "message inbox card does not belong to the profile and platform");
    }
  }
}

function mapItem(row) {
  return {
    profileId: Number(row.profile_id),
    platform: row.platform,
    conversationKey: row.conversation_key,
    sourceJobId: row.source_job_id || "",
    jobId: row.job_id == null ? null : Number(row.job_id),
    cardId: row.card_id == null ? null : Number(row.card_id),
    lastMessageId: row.last_message_id || "",
    lastActivityAt: row.last_activity_at,
    lastDirection: row.last_direction,
    unread: row.unread === 1,
    positionTitle: row.position_title || "",
    company: row.company || "",
    latestExcerpt: row.latest_excerpt || "",
    actionGroup: row.action_group,
    actionCode: row.action_code || "",
    reasonCode: row.reason_code || "",
    firstObservedAt: row.first_observed_at,
    lastObservedAt: row.last_observed_at,
    resolvedAt: row.resolved_at || null
  };
}

function mapSyncState(row) {
  return {
    profileId: Number(row.profile_id),
    platform: row.platform,
    lastAttemptedAt: row.last_attempted_at,
    lastSuccessfulAt: row.last_successful_at || null,
    coverageStartAt: row.coverage_start_at || null,
    coverageComplete: row.coverage_complete === 1,
    watermarkAt: row.watermark_at || null,
    stopCode: row.stop_code || ""
  };
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw inboxError("MESSAGE_INBOX_INPUT_INVALID", `${name} must be a positive integer`);
  return number;
}

function optionalPositiveInteger(value, name) {
  if (value == null || value === "") return null;
  return positiveInteger(value, name);
}

function platformValue(value) {
  const platform = String(value || "").trim().toLowerCase();
  if (!PLATFORMS.has(platform)) throw inboxError("MESSAGE_INBOX_PLATFORM_INVALID", "message inbox platform is invalid");
  return platform;
}

function digestValue(value, name) {
  const digest = String(value || "").trim().toLowerCase();
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw inboxError("MESSAGE_INBOX_INPUT_INVALID", `${name} must be a sha256 digest`);
  return digest;
}

function enumValue(value, allowed, code) {
  const normalized = String(value || "").trim();
  if (!allowed.has(normalized)) throw inboxError(code, "message inbox enum value is invalid");
  return normalized;
}

function inlineText(value, limit) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function isoValue(value, name) {
  const text = String(value || "").trim();
  if (!Number.isFinite(Date.parse(text))) throw inboxError("MESSAGE_INBOX_INPUT_INVALID", `${name} must be an ISO timestamp`);
  return new Date(text).toISOString();
}

function optionalIsoValue(value, name) {
  return value == null || value === "" ? null : isoValue(value, name);
}

function inboxError(code, message) {
  return storageError(code, message);
}

module.exports = {
  upsertMessageInboxItem,
  getMessageInboxItem,
  listMessageInboxItems,
  markMessageInboxItemDone,
  deleteMessageInboxItem,
  getMessageInboxSyncState,
  saveMessageInboxSyncState
};

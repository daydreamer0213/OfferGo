const { immediateTransaction, storageError } = require("./storage_shared");

const PLATFORMS = new Set(["boss", "zhaopin"]);
const ACTION_KINDS = new Set(["resume_request_accept", "resume_request_decline"]);
const STATUSES = new Set([
  "confirmed", "selecting", "verified", "click_dispatched", "succeeded",
  "target_mismatch", "platform_rejected", "ambiguous", "stopped"
]);
const ACTIVE_STATUSES = ["confirmed", "selecting", "verified", "click_dispatched"];
const CLICKED_STATUSES = new Set(["click_dispatched", "succeeded", "platform_rejected", "ambiguous"]);
const TRANSITIONS = new Map([
  ["confirmed", new Set(["selecting", "stopped"])],
  ["selecting", new Set(["verified", "target_mismatch", "stopped"])],
  ["verified", new Set(["click_dispatched", "target_mismatch", "stopped"])],
  ["click_dispatched", new Set(["succeeded", "platform_rejected", "ambiguous"])]
]);

function confirmMessageAction(db, input = {}) {
  const profileId = positiveInteger(input.profileId, "profileId");
  const platform = enumValue(input.platform, PLATFORMS, "platform");
  const conversationKey = digestValue(input.conversationKey, "conversationKey");
  const messageKey = digestValue(input.messageKey, "messageKey");
  const actionKind = enumValue(input.actionKind, ACTION_KINDS, "actionKind");
  const idempotencyKey = uuidValue(input.idempotencyKey);
  const confirmedAt = isoValue(input.confirmedAt, "confirmedAt");
  return immediateTransaction(db, () => {
    const repeated = db.prepare(`SELECT * FROM message_platform_actions
      WHERE profile_id = ? AND idempotency_key = ?`).get(profileId, idempotencyKey);
    if (repeated) {
      const mapped = mapAction(repeated);
      if (mapped.platform === platform && mapped.conversationKey === conversationKey
        && mapped.messageKey === messageKey && mapped.actionKind === actionKind) return mapped;
      throw actionError("MESSAGE_ACTION_IDEMPOTENCY_CONFLICT", "message action idempotency key belongs to another action");
    }
    const event = db.prepare(`SELECT * FROM message_events
      WHERE profile_id = ? AND platform = ? AND conversation_key = ? AND message_key = ?`)
      .get(profileId, platform, conversationKey, messageKey);
    if (!event || event.kind !== "resume_request" || event.direction !== "friend") {
      throw actionError("MESSAGE_ACTION_SOURCE_NOT_ACTIONABLE", "message action source is missing or no longer actionable");
    }
    const conflict = db.prepare(`SELECT * FROM message_platform_actions
      WHERE profile_id = ? AND platform = ? AND conversation_key = ? AND message_key = ? LIMIT 1`)
      .get(profileId, platform, conversationKey, messageKey);
    if (conflict) {
      const mapped = mapAction(conflict);
      if (mapped.actionKind === actionKind) return mapped;
      throw actionError("MESSAGE_ACTION_DECISION_CONFLICT", "message action already has a different decision");
    }
    const metadata = parseJson(event.metadata_json);
    const evidence = {
      sourceMessageId: String(event.platform_message_id || ""),
      cardType: String(metadata.cardType || "")
    };
    const result = db.prepare(`INSERT INTO message_platform_actions(
      profile_id, platform, conversation_key, message_key, action_kind,
      idempotency_key, status, click_count, evidence_json, error_code, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'confirmed', 0, ?, NULL, ?, ?)`)
      .run(profileId, platform, conversationKey, messageKey, actionKind, idempotencyKey,
        JSON.stringify(evidence), confirmedAt, confirmedAt);
    return getMessageAction(db, { profileId, actionId: Number(result.lastInsertRowid) });
  });
}

function getMessageAction(db, input = {}) {
  const row = db.prepare(`SELECT * FROM message_platform_actions WHERE id = ? AND profile_id = ?`)
    .get(positiveInteger(input.actionId, "actionId"), positiveInteger(input.profileId, "profileId"));
  return row ? mapAction(row) : null;
}

function listActiveMessageActions(db, input = {}) {
  const where = input.profileId == null ? "" : "AND profile_id = ?";
  const args = [...ACTIVE_STATUSES, ...(input.profileId == null ? [] : [positiveInteger(input.profileId, "profileId")])];
  return db.prepare(`SELECT * FROM message_platform_actions
    WHERE status IN (${ACTIVE_STATUSES.map(() => "?").join(",")}) ${where}
    ORDER BY updated_at, id`).all(...args).map(mapAction);
}

function listMessageActions(db, input = {}) {
  return db.prepare(`SELECT * FROM message_platform_actions
    WHERE profile_id = ? ORDER BY updated_at DESC, id DESC`)
    .all(positiveInteger(input.profileId, "profileId")).map(mapAction);
}

function transitionMessageAction(db, input = {}) {
  const profileId = positiveInteger(input.profileId, "profileId");
  const actionId = positiveInteger(input.actionId, "actionId");
  const expectedStatus = enumValue(input.expectedStatus, STATUSES, "expectedStatus");
  const status = enumValue(input.status, STATUSES, "status");
  if (!TRANSITIONS.get(expectedStatus)?.has(status)) {
    throw actionError("MESSAGE_ACTION_TRANSITION_INVALID", `message action cannot move from ${expectedStatus} to ${status}`);
  }
  const current = getMessageAction(db, { profileId, actionId });
  if (!current) throw actionError("MESSAGE_ACTION_NOT_FOUND", "message action was not found");
  if (current.status !== expectedStatus) throw actionError("MESSAGE_ACTION_STATE_CONFLICT", "message action status changed");
  const clickCount = input.clickCount == null ? current.clickCount : Number(input.clickCount);
  if (!Number.isInteger(clickCount) || clickCount < current.clickCount || clickCount > 1
    || (CLICKED_STATUSES.has(status) && clickCount !== 1)
    || (!CLICKED_STATUSES.has(status) && clickCount !== 0)) {
    throw actionError("MESSAGE_ACTION_CLICK_COUNT_INVALID", "message action click ownership is invalid");
  }
  const evidence = input.evidence == null ? current.evidence : { ...current.evidence, ...safeEvidence(input.evidence) };
  const result = db.prepare(`UPDATE message_platform_actions SET
      status = ?, click_count = ?, evidence_json = ?, error_code = ?, updated_at = ?
    WHERE id = ? AND profile_id = ? AND status = ?`)
    .run(status, clickCount, JSON.stringify(evidence), nullableCode(input.errorCode),
      isoValue(input.updatedAt, "updatedAt"), actionId, profileId, expectedStatus);
  if (result.changes !== 1) throw actionError("MESSAGE_ACTION_STATE_CONFLICT", "message action status changed");
  return getMessageAction(db, { profileId, actionId });
}

function mapAction(row) {
  return {
    id: Number(row.id),
    profileId: Number(row.profile_id),
    platform: row.platform,
    conversationKey: row.conversation_key,
    messageKey: row.message_key,
    actionKind: row.action_kind,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    clickCount: Number(row.click_count),
    evidence: parseJson(row.evidence_json),
    errorCode: row.error_code || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parseJson(value) { try { return JSON.parse(value || "{}"); } catch { return {}; } }
function positiveInteger(value, name) { const n = Number(value); if (!Number.isSafeInteger(n) || n <= 0) throw actionError("MESSAGE_ACTION_INPUT_INVALID", `${name} must be a positive integer`); return n; }
function enumValue(value, allowed, name) { const text = String(value || "").trim().toLowerCase(); if (!allowed.has(text)) throw actionError("MESSAGE_ACTION_INPUT_INVALID", `${name} is invalid`); return text; }
function digestValue(value, name) { const text = String(value || "").trim().toLowerCase(); if (!/^sha256:[a-f0-9]{64}$/.test(text)) throw actionError("MESSAGE_ACTION_INPUT_INVALID", `${name} must be a sha256 digest`); return text; }
function uuidValue(value) { const text = String(value || "").trim().toLowerCase(); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(text)) throw actionError("MESSAGE_ACTION_INPUT_INVALID", "idempotencyKey must be a UUID"); return text; }
function isoValue(value, name) { const text = String(value || "").trim(); if (!Number.isFinite(Date.parse(text))) throw actionError("MESSAGE_ACTION_INPUT_INVALID", `${name} must be an ISO timestamp`); return new Date(text).toISOString(); }
function nullableCode(value) { if (value == null || value === "") return null; const text = String(value); if (!/^[A-Z0-9_]{1,100}$/.test(text)) throw actionError("MESSAGE_ACTION_INPUT_INVALID", "errorCode is invalid"); return text; }
function safeEvidence(value) { if (!value || typeof value !== "object" || Array.isArray(value)) throw actionError("MESSAGE_ACTION_INPUT_INVALID", "evidence is invalid"); const copy = JSON.parse(JSON.stringify(value)); if (JSON.stringify(copy).length > 8000) throw actionError("MESSAGE_ACTION_INPUT_INVALID", "evidence is too large"); return copy; }
function actionError(code, message) { return storageError(code, message); }

module.exports = { confirmMessageAction, getMessageAction, listActiveMessageActions, listMessageActions, transitionMessageAction };

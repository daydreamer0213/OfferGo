const PLATFORMS = new Set(["boss", "zhaopin"]);
const { MESSAGE_ACTION_WINDOW_MS } = require("../core/message_requested_actions");

function messageReplyWindowExpired({ actionGroup, lastDirection, lastActivityAt } = {}, now = new Date()) {
  const activityMs = Date.parse(String(lastActivityAt || ""));
  const nowMs = new Date(now).getTime();
  return ["needs_action", "needs_review"].includes(actionGroup) && lastDirection === "friend"
    && Number.isFinite(activityMs) && Number.isFinite(nowMs)
    && nowMs - activityMs > MESSAGE_ACTION_WINDOW_MS;
}

function getConfirmedFutureInterview(db, { profileId, cardId, lastActivityAt, messageGroupKey, now = new Date() } = {}) {
  const card = db.prepare("SELECT stage, scheduled_at, last_event_at FROM candidate_progress_cards WHERE id = ? AND profile_id = ?")
    .get(Number(cardId), Number(profileId));
  const scheduledMs = Date.parse(card?.scheduled_at || "");
  if (!card || card.stage !== "interview_scheduled" || !Number.isFinite(scheduledMs) || scheduledMs <= new Date(now).getTime()) return null;
  const activity = lastActivityAt || db.prepare(`SELECT created_at FROM message_inbound_contexts
    WHERE profile_id = ? AND card_id = ? AND message_group_key = ?`).get(Number(profileId), Number(cardId), messageGroupKey)?.created_at;
  const confirmedMs = Date.parse(card.last_event_at || "");
  if (!Number.isFinite(confirmedMs) || !Number.isFinite(Date.parse(activity || "")) || Date.parse(activity) > confirmedMs) return null;
  return { scheduledAt: card.scheduled_at };
}

function assertMessageReplyWindowOpen(db, { profileId, cardId, messageGroupKey, expectedLastMessageId = null, now = new Date() } = {}) {
  const context = db.prepare(`SELECT contexts.*, cards.source AS platform FROM message_inbound_contexts contexts
    JOIN candidate_progress_cards cards ON cards.id = contexts.card_id AND cards.profile_id = contexts.profile_id
    WHERE contexts.profile_id = ? AND contexts.card_id = ? AND contexts.message_group_key = ?`)
    .get(Number(profileId), Number(cardId), messageGroupKey);
  if (!context || context.message_intent === "follow_up") return;
  const messageId = expectedLastMessageId || context.last_message_id;
  const event = db.prepare(`SELECT occurred_at, first_observed_at FROM message_events
    WHERE profile_id = ? AND platform = ? AND conversation_key = ? AND platform_message_id = ? AND direction = 'friend'
    ORDER BY id DESC LIMIT 1`).get(Number(profileId), context.platform, context.conversation_key, messageId);
  const inbox = db.prepare(`SELECT last_activity_at FROM message_inbox_items
    WHERE profile_id = ? AND platform = ? AND conversation_key = ? AND last_message_id = ? AND last_direction = 'friend'`)
    .get(Number(profileId), context.platform, context.conversation_key, messageId);
  // Anchor the pending group to its actual HR message, never a later sync or the conversation's first contact.
  const lastActivityAt = event?.occurred_at || event?.first_observed_at || inbox?.last_activity_at || context.created_at;
  if (messageReplyWindowExpired({ actionGroup: "needs_action", lastDirection: "friend", lastActivityAt }, now)) {
    throw Object.assign(new Error("这条消息已超过 7 天未回复，不再处理。"), { code: "MESSAGE_REPLY_WINDOW_EXPIRED" });
  }
}

function listIncomingLinkedContexts(db, profileId) {
  return db.prepare(`SELECT contexts.*, cards.source AS platform, cards.job_id, jobs.title, jobs.company
    FROM message_inbound_contexts contexts
    JOIN candidate_progress_cards cards ON cards.id = contexts.card_id AND cards.profile_id = contexts.profile_id
    JOIN jobs ON jobs.id = cards.job_id
    WHERE contexts.profile_id = ? AND cards.source = jobs.source
    ORDER BY contexts.updated_at DESC, contexts.id DESC`).all(Number(profileId))
    .filter((row) => PLATFORMS.has(row.platform));
}

function listClassifiedMessageHistory(db, { profileId, eventTypes = [] } = {}) {
  const types = [...new Set(eventTypes.map(String).filter(Boolean))];
  if (!types.length) return [];
  return db.prepare(`SELECT events.*, cards.source AS platform, cards.thread_key, cards.job_id, jobs.title, jobs.company
    FROM candidate_progress_events events
    JOIN candidate_progress_cards cards ON cards.id = events.card_id
    JOIN jobs ON jobs.id = cards.job_id
    WHERE cards.profile_id = ? AND cards.thread_key <> '' AND cards.source = jobs.source
      AND events.type IN (${types.map(() => "?").join(",")})
    ORDER BY events.occurred_at DESC, events.id DESC`).all(Number(profileId), ...types)
    .filter((row) => PLATFORMS.has(row.platform));
}

function listRawUnresolvedMessageItems(db, profileId) {
  return db.prepare(`SELECT * FROM message_discovery_unresolved_items
    WHERE profile_id = ? ORDER BY last_observed_at DESC, conversation_key ASC`).all(Number(profileId))
    .filter((row) => PLATFORMS.has(row.platform));
}

function recordIgnoredInboundEvent(db, { profileId, conversationKey, previewDigest, observedAt } = {}) {
  db.prepare(`INSERT INTO events(job_id, event_type, payload_json, created_at)
    VALUES (NULL, 'message_inbound_ignored', ?, ?)`)
    .run(JSON.stringify({ profileId: Number(profileId), conversationKey, previewDigest }), observedAt);
}

function findExactIdentityCandidates(db, { profileId, title, company } = {}) {
  return db.prepare(`SELECT DISTINCT jobs.id, jobs.title, jobs.company
    FROM jobs
    LEFT JOIN candidate_progress_cards cards ON cards.job_id = jobs.id AND cards.profile_id = ?
    LEFT JOIN job_observations observations ON observations.job_id = jobs.id
    LEFT JOIN batches ON batches.id = observations.batch_id
    WHERE lower(trim(jobs.title)) = lower(trim(?))
      AND lower(trim(COALESCE(jobs.company, ''))) = lower(trim(?))
      AND (cards.id IS NOT NULL OR batches.profile_id = ?)
      AND COALESCE(cards.stage, '') NOT IN ('rejected', 'closed')
    ORDER BY jobs.last_seen_at DESC, jobs.id DESC LIMIT 20`)
    .all(Number(profileId), String(title || ""), String(company || ""), Number(profileId));
}

function getPersistedCardJobIdentity(db, { cardId, jobId } = {}) {
  const row = db.prepare(`SELECT j.source, j.source_id FROM candidate_progress_cards c
    JOIN jobs j ON j.id = c.job_id WHERE c.id = ? AND c.job_id = ? AND c.source = j.source`)
    .get(Number(cardId), Number(jobId));
  return row ? { source: row.source, sourceId: row.source_id || "" } : null;
}

function getLatestInboundContextIdentity(db, cardId) {
  const row = db.prepare(`SELECT message_group_key, conversation_key FROM message_inbound_contexts
    WHERE card_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1`).get(Number(cardId));
  return row ? { messageGroupKey: row.message_group_key, conversationKey: row.conversation_key } : null;
}

function getDurableMessageDraftContext(db, { profileId, cardId } = {}) {
  return db.prepare(`SELECT c.id AS card_id, c.job_id, c.plan_id, c.stage,
    j.title, j.company, j.location, j.salary, j.description, j.analysis_json, j.quality_tags_json, j.risks_json,
    j.source, j.source_id, c.source AS card_source
    FROM candidate_progress_cards c JOIN jobs j ON j.id = c.job_id
    WHERE c.id = ? AND c.profile_id = ?`).get(Number(cardId), Number(profileId)) || null;
}

function getMessageGroupClassification(db, { profileId, cardId, messageGroupKey } = {}) {
  const rows = db.prepare(`SELECT events.metadata_json
    FROM candidate_progress_events events
    JOIN candidate_progress_cards cards ON cards.id = events.card_id
    WHERE cards.profile_id = ? AND cards.id = ? AND events.type = 'message_group_classified'
    ORDER BY events.occurred_at DESC, events.id DESC`).all(Number(profileId), Number(cardId));
  const expected = String(messageGroupKey || "");
  for (const row of rows) {
    try {
      const metadata = JSON.parse(String(row.metadata_json || "{}"));
      if (metadata && typeof metadata === "object" && metadata.messageGroupKey === expected) return metadata;
    } catch {}
  }
  return null;
}

function updateMessageGroupFactRequest(db, { profileId, cardId, messageGroupKey, missingFact = null } = {}) {
  const rows = db.prepare(`SELECT events.id, events.metadata_json
    FROM candidate_progress_events events JOIN candidate_progress_cards cards ON cards.id = events.card_id
    WHERE cards.profile_id = ? AND cards.id = ? AND events.type = 'message_group_classified'
    ORDER BY events.occurred_at DESC, events.id DESC`).all(Number(profileId), Number(cardId));
  for (const row of rows) {
    const metadata = JSON.parse(row.metadata_json);
    if (metadata.messageGroupKey !== messageGroupKey) continue;
    metadata.missingFactKey = String(missingFact?.key || "");
    metadata.missingFactQuestion = String(missingFact?.question || "");
    db.prepare("UPDATE candidate_progress_events SET metadata_json = ? WHERE id = ?")
      .run(JSON.stringify(metadata), row.id);
    return;
  }
  throw new Error("message group classification was not found");
}

module.exports = {
  getConfirmedFutureInterview,
  messageReplyWindowExpired,
  assertMessageReplyWindowOpen,
  listIncomingLinkedContexts,
  listClassifiedMessageHistory,
  listRawUnresolvedMessageItems,
  recordIgnoredInboundEvent,
  findExactIdentityCandidates,
  getPersistedCardJobIdentity,
  getLatestInboundContextIdentity,
  getDurableMessageDraftContext,
  getMessageGroupClassification,
  updateMessageGroupFactRequest
};

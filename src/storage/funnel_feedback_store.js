const { listMessageEvents } = require('./message_timeline_store');

const DIGEST = /^sha256:[a-f0-9]{64}$/;

function listFunnelFeedbackEvidence(db, { profileId, planId, entries = [], now = new Date().toISOString() } = {}) {
  if (!Number.isSafeInteger(profileId) || profileId <= 0 || !Number.isSafeInteger(planId) || planId <= 0
    || !Array.isArray(entries) || !Number.isFinite(Date.parse(now))) {
    throw new TypeError('funnel feedback requires a valid profile, plan, entries and time');
  }
  const nowMs = Date.parse(now);
  const getEntry = db.prepare(`SELECT f.*, c.source AS site, c.thread_key, c.stage, c.scheduled_at,
      j.title, j.company, j.description, d.resume_text
    FROM candidate_funnel_entries f
    JOIN search_plans p ON p.id = f.plan_id AND p.profile_id = f.profile_id
    JOIN candidate_funnel_strategy_rounds r ON r.id = f.strategy_round_id
      AND r.profile_id = f.profile_id AND r.plan_id = f.plan_id
    JOIN candidate_progress_cards c ON c.id = f.card_id AND c.profile_id = f.profile_id
      AND c.plan_id = f.plan_id AND c.job_id = f.job_id
    JOIN jobs j ON j.id = f.job_id AND j.source = c.source
    LEFT JOIN candidate_resume_versions v ON v.id = f.resume_version_id AND v.profile_id = f.profile_id
    LEFT JOIN resume_documents d ON d.id = v.resume_document_id AND d.profile_id = f.profile_id
    WHERE f.id = ? AND f.profile_id = ? AND f.plan_id = ?`);
  const getClassifications = db.prepare(`SELECT id, type, metadata_json, occurred_at
    FROM candidate_progress_events WHERE card_id = ?
      AND type IN ('incoming_message_classified', 'recruiter_rejected')
      AND occurred_at >= ? AND occurred_at <= ? ORDER BY occurred_at, id`);
  const getResumeSent = db.prepare(`SELECT MAX(updated_at) AS sent_at FROM message_platform_actions
    WHERE profile_id = ? AND platform = ? AND conversation_key = ?
      AND action_kind = 'resume_request_accept' AND status = 'succeeded'
      AND created_at >= ? AND updated_at >= ? AND updated_at <= ?`);
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    if (!entry || !Number.isSafeInteger(entry.id) || entry.id <= 0
      || entry.profileId !== profileId || entry.planId !== planId || seen.has(entry.id)) continue;
    const row = getEntry.get(entry.id, profileId, planId);
    if (!row || !['boss', 'zhaopin'].includes(row.site)
      || entry.jobId !== Number(row.job_id) || entry.cardId !== Number(row.card_id)
      || entry.strategyRoundId !== Number(row.strategy_round_id) || entry.site !== row.site
      || (entry.resumeVersionId || null) !== (Number(row.resume_version_id) || null)
      || entry.startedAt !== row.started_at) continue;
    const startedMs = Date.parse(row.started_at);
    if (!Number.isFinite(startedMs) || startedMs > nowMs) continue;
    seen.add(entry.id);
    const conversationKey = DIGEST.test(row.thread_key) ? row.thread_key : '';
    const messages = conversationKey ? listMessageEvents(db, {
      profileId, platform: row.site, conversationKey, limit: 1000
    }).filter(message => {
      const time = Date.parse(message.occurredAt || message.firstObservedAt);
      return Number.isFinite(time) && time >= startedMs && time <= nowMs;
    }) : [];
    const classifications = conversationKey ? getClassifications.all(row.card_id, row.started_at, new Date(nowMs).toISOString())
      .flatMap(event => {
        let metadata;
        try { metadata = JSON.parse(event.metadata_json); } catch { return []; }
        if (!metadata || metadata.platform !== row.site || metadata.threadKey !== row.thread_key
          || !DIGEST.test(metadata.messageKey)) return [];
        return [{ id: Number(event.id), type: event.type, messageKey: metadata.messageKey,
          messageIntent: String(metadata.messageIntent || ''), messageCategory: String(metadata.messageCategory || ''),
          occurredAt: event.occurred_at }];
      }) : [];
    result.push({
      entryId: Number(row.id), jobId: Number(row.job_id), cardId: Number(row.card_id), site: row.site,
      conversationKey,
      directionKey: row.direction_key || '', startedAt: row.started_at,
      resumeVersionId: Number(row.resume_version_id) || null,
      // The JD is the current local record; a successful resume action does not identify the file sent.
      title: row.title || '', company: row.company || '', description: row.description || '',
      resumeText: row.resume_text || '', cardStage: row.stage, scheduledAt: row.scheduled_at || null,
      resumeSentAt: conversationKey ? getResumeSent.get(profileId, row.site, conversationKey, row.started_at, row.started_at,
        new Date(nowMs).toISOString()).sent_at || null : null,
      messages, classifications
    });
  }
  return result;
}

module.exports = { listFunnelFeedbackEvidence };

const { nowIso, parseJson, storageError } = require('./storage_shared');

function id(value) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) throw new TypeError('资料编号无效');
  return result;
}

function text(value, limit, label) {
  const result = String(value || '').trim();
  if (!result || result.length > limit) throw new TypeError(`${label}不能为空或超过长度限制`);
  return result;
}

function row(value) {
  return value ? {
    id: Number(value.id), profileId: Number(value.profile_id), subject: value.subject, text: value.evidence_text,
    sourceKind: value.source_kind, sourceId: value.source_id, sourceItemKey: value.source_item_key,
    sourceQuote: value.source_quote, scope: parseJson(value.scope_json, { kind: 'global', key: '' }),
    createdAt: value.created_at, updatedAt: value.updated_at, withdrawnAt: value.withdrawn_at
  } : null;
}

function owned(db, profileId, evidenceId) {
  const found = db.prepare('SELECT * FROM candidate_evidence_entries WHERE profile_id = ? AND id = ?').get(id(profileId), id(evidenceId));
  if (!found) throw storageError('CANDIDATE_EVIDENCE_NOT_FOUND', '这条经历不存在或不属于当前用户');
  return found;
}

function saveCandidateEvidence(db, input) {
  const profileId = id(input.profileId);
  if (!db.prepare('SELECT id FROM candidate_profiles WHERE id = ?').get(profileId)) throw storageError('CANDIDATE_NOT_FOUND', '用户资料不存在');
  const sourceKind = text(input.sourceKind, 40, '来源');
  if (!['interview_turn', 'manual'].includes(sourceKind)) throw new TypeError('经历来源无效');
  const scope = input.scope || { kind: 'global', key: '' };
  if (!['global', 'experience', 'job', 'company'].includes(scope.kind)) throw new TypeError('适用范围无效');
  if (scope.kind !== 'global' && !String(scope.key || '').trim()) throw new TypeError('适用范围缺少对象');
  const now = input.confirmedAt ? new Date(input.confirmedAt).toISOString() : nowIso();
  const result = db.prepare(`INSERT INTO candidate_evidence_entries(
    profile_id, subject, evidence_text, source_kind, source_id, source_item_key, source_quote, scope_json, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(profile_id, source_kind, source_id, source_item_key) DO UPDATE SET
    subject = excluded.subject, evidence_text = excluded.evidence_text, scope_json = excluded.scope_json,
    source_quote = excluded.source_quote, withdrawn_at = NULL, updated_at = excluded.updated_at
  RETURNING *`).get(profileId, text(input.subject, 160, '主题'), text(input.text, 8000, '经历'), sourceKind,
    text(input.sourceId, 80, '来源编号'), text(input.sourceItemKey, 80, '来源条目'), text(input.sourceQuote, 20000, '来源原话'),
    JSON.stringify({ kind: scope.kind, key: String(scope.key || '').trim().slice(0, 160) }), now, now);
  return row(result);
}

function listCandidateEvidence(db, { profileId, includeWithdrawn = false }) {
  return db.prepare(`SELECT * FROM candidate_evidence_entries WHERE profile_id = ?
    ${includeWithdrawn ? '' : 'AND withdrawn_at IS NULL'} ORDER BY updated_at DESC, id DESC`).all(id(profileId)).map(row);
}

function reviseCandidateEvidence(db, input) {
  owned(db, input.profileId, input.id);
  return row(db.prepare(`UPDATE candidate_evidence_entries SET subject = ?, evidence_text = ?, updated_at = ?
    WHERE profile_id = ? AND id = ? AND withdrawn_at IS NULL RETURNING *`).get(
    text(input.subject, 160, '主题'), text(input.text, 8000, '经历'), nowIso(), id(input.profileId), id(input.id)));
}

function withdrawCandidateEvidence(db, input) {
  owned(db, input.profileId, input.id);
  return row(db.prepare(`UPDATE candidate_evidence_entries SET withdrawn_at = COALESCE(withdrawn_at, ?), updated_at = ?
    WHERE profile_id = ? AND id = ? RETURNING *`).get(nowIso(), nowIso(), id(input.profileId), id(input.id)));
}

module.exports = { saveCandidateEvidence, listCandidateEvidence, reviseCandidateEvidence, withdrawCandidateEvidence };

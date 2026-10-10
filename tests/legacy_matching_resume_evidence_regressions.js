const assert = require('node:assert/strict');
const store = require('../src/storage/candidate_store');
const { openDb } = require('../src/core/storage');
const { runtimeAnalysisContext } = require('../src/core/analysis_revision');

const rawText = '姓名：李明\n联系方式：13800000001｜liming@example.invalid\n住址：广州某街道12号\n本科在读，每周可实习4天。不了解云平台部署，没有软件系统开发工作经历。';
const oldProfile = { candidate: { name: '李明', targetTitles: ['产品经理实习生'] }, source: { model: 'recorded-old' }, projects: [] };
const card = { targetDirections: ['产品经理实习生'], strongEvidence: [], transferableCapabilities: [], cautionTransitions: [], userNotes: [] };

function setup(profile = oldProfile, text = rawText) {
  const db = openDb(':memory:');
  const saved = store.saveProfileAnalysis(db, { profile,
    document: { text, originalFileName: 'resume.txt', contentHash: 'old-doc-hash', format: 'text' } });
  const draft = store.createMatchingCardDraft(db, { profileId: saved.profileId, profileVersionId: saved.profileVersionId,
    resumeDocumentId: saved.resumeDocumentId, resumeContentHash: 'old-doc-hash', card });
  store.confirmMatchingCard(db, { profileId: saved.profileId, cardId: draft.id });
  return { db, saved, cardId: draft.id };
}
function materialSnapshot(db) {
  return JSON.stringify(['candidate_profiles', 'profile_versions', 'resume_documents', 'candidate_matching_cards']
    .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()));
}
function queryCount(db, run) {
  const prepare = db.prepare.bind(db);
  let count = 0;
  db.prepare = (...args) => { count++; return prepare(...args); };
  try { return { result: run(), count }; } finally { db.prepare = prepare; }
}
let failed = 0;
function check(name, run) {
  const fixture = setup();
  try { run(fixture); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
  finally { fixture.db.close(); }
}

check('legacy evidence uses the confirmed version, masks identity, changes cache hash and never writes storage', ({ db, saved }) => {
  store.saveProfileAnalysis(db, { profileId: saved.profileId,
    profile: { candidate: { name: '陈新' }, source: { resumeEvidenceText: '不同的新版本内容' } },
    document: { text: '姓名：陈新\n新版本已负责云部署', originalFileName: 'new.txt', contentHash: 'new-doc-hash' } });
  const before = materialSnapshot(db);
  const normal = queryCount(db, () => store.getCandidateMatchingContext(db, saved.profileId));
  assert.equal(normal.count, 2, '默认状态读取不得增加恢复SQL');
  assert.deepEqual(normal.result.candidateProfile, oldProfile);
  assert.equal(normal.result.resumeEvidenceRecovery, undefined);
  const recovered = store.getCandidateMatchingContext(db, saved.profileId, { includeResumeEvidence: true });
  assert.equal(recovered.resumeEvidenceRecovery.status, 'recovered');
  assert.equal(recovered.profileVersionId, saved.profileVersionId);
  for (const boundary of [/本科在读/, /每周可实习4天/, /不了解云平台部署/, /没有软件系统开发工作经历/]) {
    assert.match(recovered.candidateProfile.source.resumeEvidenceText, boundary);
  }
  for (const secret of ['李明', '13800000001', 'liming@example.invalid', '广州某街道12号', '新版本已负责云部署']) {
    assert(!recovered.candidateProfile.source.resumeEvidenceText.includes(secret), secret);
  }
  assert.notEqual(runtimeAnalysisContext(recovered.candidateProfile, {}).profileVersion,
    runtimeAnalysisContext(normal.result.candidateProfile, {}).profileVersion);
  assert.equal(materialSnapshot(db), before, '恢复只改变返回副本');
});

check('new profiles retain the saved model input without a recovery document read', ({ db, saved }) => {
  const current = { ...oldProfile, source: { resumeEvidenceText: '[姓名已隐藏] 原始模型材料' } };
  db.prepare('UPDATE profile_versions SET profile_json = ? WHERE id = ?').run(JSON.stringify(current), saved.profileVersionId);
  const observed = queryCount(db, () => store.getCandidateMatchingContext(db, saved.profileId, { includeResumeEvidence: true }));
  assert.equal(observed.count, 2);
  assert.deepEqual(observed.result.candidateProfile, current);
  assert.equal(observed.result.resumeEvidenceRecovery.status, 'existing');
});

check('a generic stored candidate name can recover a labeled identity from the bound document', ({ db, saved }) => {
  db.prepare('UPDATE profile_versions SET profile_json = ? WHERE id = ?')
    .run(JSON.stringify({ ...oldProfile, candidate: { ...oldProfile.candidate, name: '候选人' } }), saved.profileVersionId);
  const result = store.getCandidateMatchingContext(db, saved.profileId, { includeResumeEvidence: true });
  assert.equal(result.resumeEvidenceRecovery.status, 'recovered');
  assert.match(result.candidateProfile.source.resumeEvidenceText, /不了解云平台部署/);
  assert(!result.candidateProfile.source.resumeEvidenceText.includes('李明'));
});

for (const [name, tamper, reasonCode] of [
  ['wrong document', (db, saved, cardId) => db.prepare('UPDATE candidate_matching_cards SET resume_document_id = NULL WHERE id = ?').run(cardId), 'DOCUMENT_BINDING_MISMATCH'],
  ['wrong hash', (db, saved, cardId) => db.prepare('UPDATE candidate_matching_cards SET resume_content_hash = ? WHERE id = ?').run('different-hash', cardId), 'DOCUMENT_HASH_MISMATCH'],
  ['wrong document owner', (db, saved) => {
    const other = store.saveProfileAnalysis(db, { profile: oldProfile,
      document: { text: rawText, originalFileName: 'other.txt', contentHash: 'other-hash' } });
    db.prepare('UPDATE resume_documents SET profile_id = ? WHERE id = ?').run(other.profileId, saved.resumeDocumentId);
  }, 'DOCUMENT_PROFILE_MISMATCH'],
  ['wrong version owner', (db, saved) => {
    const other = store.saveProfileAnalysis(db, { profile: oldProfile,
      document: { text: rawText, originalFileName: 'other.txt', contentHash: 'other-hash' } });
    db.prepare('UPDATE profile_versions SET profile_id = ? WHERE id = ?').run(other.profileId, saved.profileVersionId);
  }, 'VERSION_PROFILE_MISMATCH'],
  ['unrecognized identity', (db, saved) => {
    db.prepare('UPDATE profile_versions SET profile_json = ? WHERE id = ?').run(JSON.stringify({ ...oldProfile, candidate: { name: '候选人' } }), saved.profileVersionId);
    db.prepare('UPDATE resume_documents SET resume_text = ? WHERE id = ?').run('没有署名的项目材料，不能判断身份。', saved.resumeDocumentId);
  }, 'RESUME_PRIVACY_REDACTION_FAILED'],
  ['empty original document', (db, saved) => db.prepare('UPDATE resume_documents SET resume_text = ? WHERE id = ?').run('', saved.resumeDocumentId), 'DOCUMENT_TEXT_MISSING']
]) {
  check(`${name} retains the original profile with a safe recovery diagnostic`, ({ db, saved, cardId }) => {
    tamper(db, saved, cardId);
    const before = materialSnapshot(db);
    const normal = store.getCandidateMatchingContext(db, saved.profileId);
    const recovered = store.getCandidateMatchingContext(db, saved.profileId, { includeResumeEvidence: true });
    assert.deepEqual(recovered.candidateProfile, normal.candidateProfile);
    assert.equal(recovered.candidateProfile.source.resumeEvidenceText, undefined);
    assert.equal(recovered.resumeEvidenceRecovery.status, 'unavailable');
    assert.equal(recovered.resumeEvidenceRecovery.reasonCode, reasonCode);
    assert.equal(materialSnapshot(db), before);
    assert(!JSON.stringify(recovered.resumeEvidenceRecovery).includes('13800000001'));
  });
}

check('same-bound 1000-character prefix restores the full redacted text without overwriting user changes', ({ db, saved, cardId }) => {
  const raw = '姓名：李明\n' + '订单接口与数据库交付记录。'.repeat(120) + '\n后半段：独立完成检索评估和上线问题定位。';
  const prepared = require('../src/core/resume_privacy').prepareResumeTextForModel(raw, { strict: true }).text;
  db.prepare('UPDATE resume_documents SET resume_text = ? WHERE id = ?').run(raw, saved.resumeDocumentId);
  const prefixProfile = { ...oldProfile, source: { resumeEvidenceText: prepared.slice(0, 1000) } };
  db.prepare('UPDATE profile_versions SET profile_json = ? WHERE id = ?').run(JSON.stringify(prefixProfile), saved.profileVersionId);
  const before = materialSnapshot(db);
  const recovered = store.getCandidateMatchingContext(db, saved.profileId, { includeResumeEvidence: true });
  assert.equal(recovered.candidateProfile.source.resumeEvidenceText, prepared);
  assert.equal(recovered.resumeEvidenceRecovery.reasonCode, 'TRUNCATED_PROFILE_EVIDENCE');
  assert.equal(materialSnapshot(db), before);
  assert.equal(require('../src/core/profile_schema').normalizeCandidateProfile(prefixProfile,
    { resumeEvidenceText: prepared }).source.resumeEvidenceText, prepared);

  prefixProfile.source.resumeEvidenceText = '用户重新整理了经历。'.repeat(120).slice(0, 1000);
  db.prepare('UPDATE profile_versions SET profile_json = ? WHERE id = ?').run(JSON.stringify(prefixProfile), saved.profileVersionId);
  const edited = store.getCandidateMatchingContext(db, saved.profileId, { includeResumeEvidence: true });
  assert.equal(edited.candidateProfile.source.resumeEvidenceText, prefixProfile.source.resumeEvidenceText);
  assert.equal(edited.resumeEvidenceRecovery.status, 'existing');

  prefixProfile.source.resumeEvidenceText = prepared.slice(0, 1000);
  db.prepare('UPDATE profile_versions SET profile_json = ? WHERE id = ?').run(JSON.stringify(prefixProfile), saved.profileVersionId);
  db.prepare('UPDATE candidate_matching_cards SET resume_content_hash = ? WHERE id = ?').run('wrong-hash', cardId);
  const mismatched = store.getCandidateMatchingContext(db, saved.profileId, { includeResumeEvidence: true });
  assert.equal(mismatched.candidateProfile.source.resumeEvidenceText, prefixProfile.source.resumeEvidenceText);
  assert.equal(mismatched.resumeEvidenceRecovery.reasonCode, 'DOCUMENT_HASH_MISMATCH');
});

if (failed) process.exitCode = 1;
else console.log('legacy_matching_resume_evidence_regressions ok (10 checks)');

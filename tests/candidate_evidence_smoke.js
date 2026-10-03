const assert = require('node:assert/strict');
const storage = require('../src/core/storage');
const evidence = require('../src/storage/candidate_evidence_store');
const { selectRelevantCandidateMaterial } = require('../src/core/candidate_evidence');
const db = storage.openDb(':memory:');
try {
  const owner = storage.saveProfileAnalysis(db, { profile: { candidate: { name: '甲' } }, document: { contentHash: 'a', text: '甲的简历', originalFileName: 'a.txt', format: 'text' }, searchPlan: { directions: ['工程师'] } });
  const other = storage.saveProfileAnalysis(db, { profile: { candidate: { name: '乙' } }, document: { contentHash: 'b', text: '乙的简历', originalFileName: 'b.txt', format: 'text' }, searchPlan: { directions: ['工程师'] } });
  const input = { profileId: owner.profileId, subject: '知识库接口联调', text: '我参与接口联调，没有主导架构。', sourceKind: 'interview_turn', sourceId: '1', sourceItemKey: '1', sourceQuote: '我参与接口联调，没有主导架构。' };
  const saved = evidence.saveCandidateEvidence(db, input);
  assert.equal(evidence.saveCandidateEvidence(db, input).id, saved.id);
  assert.equal(evidence.listCandidateEvidence(db, { profileId: owner.profileId }).length, 1);
  assert.throws(() => evidence.reviseCandidateEvidence(db, { profileId: other.profileId, id: saved.id, subject: 'x', text: 'x' }));
  assert.deepEqual(evidence.listCandidateEvidence(db, { profileId: other.profileId }), []);
  evidence.reviseCandidateEvidence(db, { profileId: owner.profileId, id: saved.id, subject: '知识库联调', text: '我参与知识库的接口联调。' });
  assert.equal(evidence.listCandidateEvidence(db, { profileId: owner.profileId })[0].text, '我参与知识库的接口联调。');
  evidence.withdrawCandidateEvidence(db, { profileId: owner.profileId, id: saved.id });
  assert.equal(evidence.listCandidateEvidence(db, { profileId: owner.profileId }).length, 0);
  const records = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, finalText: '目前在广州', updatedAt: '2026-10-03', scope: { kind: 'global' } }));
  records.push({ id: 99, questionSummary: '知识库接口联调', finalText: '我完成过接口联调和检索测试。', updatedAt: '2025-01-01', scope: { kind: 'global' } });
  records.push({ id: 100, text: '知识库接口联调', scope: { kind: 'company', key: '别家公司' } });
  assert.equal(selectRelevantCandidateMaterial(records, { query: '你做过知识库接口联调吗？', job: { company: '本家公司' }, limit: 12 })[0].id, 99);
  assert(!selectRelevantCandidateMaterial(records, { query: '知识库', job: { company: '本家公司' } }).some(row => row.id === 100));
  console.log('candidate_evidence_smoke ok');
} finally { db.close(); }

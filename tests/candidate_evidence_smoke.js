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
  // Removing concept matching would let the twelve recent city answers hide these older stories.
  const recentUnrelated = Array.from({ length: 12 }, (_, i) => ({ id: 200 + i, text: '目前在广州，周末喜欢散步。', updatedAt: '2026-10-03', scope: { kind: 'global' } }));
  const paraphrases = [
    { query: '碰到难题一般怎么处理？', text: '先复现故障，再定位原因，拆成小步骤验证；最后总结经验。' },
    { query: '你怎样和别人一起把事情做好？', text: '我主动同步进度，协调分工，和同事互相支持完成任务。' },
    { query: '这件事中你本人具体起了什么作用？', text: '我负责收集反馈，独立整理记录，亲自跟进后续事项。' },
    { query: '这次工作最终带来了哪些成效？', text: '交付后等待时间缩短了两天，满意度提高了，目标按期达成。' },
    { query: '为什么选择这份工作？', text: '我希望继续学习，也喜欢服务客户，这与我的长期职业方向一致。' }
  ];
  for (const { query, text } of paraphrases) {
    const story = { id: 299, text, updatedAt: '2025-01-01', scope: { kind: 'experience', key: '旧经历' } };
    const selected = selectRelevantCandidateMaterial([...recentUnrelated, story], { query, limit: 12 });
    assert.equal(selected[0].id, 299, `older evidence should match paraphrase: ${query}`);
    assert(selected.some(row => row === story), 'selection preserves the original item');
  }
  const specific = { id: 300, text: paraphrases[0].text, updatedAt: '2025-01-01', scope: { kind: 'global' } };
  const generic = { id: 301, text: '处理难题需要合作，个人贡献、结果和动机都很重要。', updatedAt: '2026-10-03', scope: { kind: 'global' } };
  assert.equal(selectRelevantCandidateMaterial([generic, specific], { query: paraphrases[0].query, limit: 1 })[0].id, 300,
    'a recent list of capability names must not outrank concrete steps');
  const exact = { id: 302, subject: '知识库接口联调', text: '知识库接口联调时，我先复现接口异常。', updatedAt: '2024-01-01' };
  assert.equal(selectRelevantCandidateMaterial([specific, exact], { query: '你在知识库接口联调中碰到难题怎么处理？', limit: 1 })[0].id, 302,
    'precise story words still outrank a broader capability match');
  const scoped = [
    { ...specific, id: 310, scope: { kind: 'job', key: 'different-job' } },
    { ...specific, id: 311, scope: { kind: 'company', key: '别家公司' } },
    { ...specific, id: 312, withdrawnAt: '2026-10-03' },
    { ...specific, id: 313, scope: { kind: 'job', key: 'target-job' } },
    { ...specific, id: 314, scope: { kind: 'company', key: ' 本家公司 ' } }
  ];
  assert.deepEqual(selectRelevantCandidateMaterial(scoped, { query: paraphrases[0].query, job: { id: 1, sourceId: 'target-job', company: '本家公司' } }).map(row => row.id), [313, 314],
    'concept matches must still respect job, company, and withdrawal boundaries');
  assert.deepEqual(selectRelevantCandidateMaterial(scoped, { query: paraphrases[0].query }).map(row => row.id), [],
    'target-scoped stories cannot enter general material');
  const budgeted = [
    { id: 320, text: paraphrases[0].text.repeat(3), updatedAt: '2026-10-03' },
    { id: 321, text: '复现故障，定位原因。', updatedAt: '2025-01-01' },
    { id: 322, text: '复现问题，找出原因。', updatedAt: '2024-01-01' }
  ];
  assert.deepEqual(selectRelevantCandidateMaterial(budgeted, { query: paraphrases[0].query, limit: 2, maxChars: 19 }).map(row => row.id), [321],
    'skip an oversized story and keep the shared character budget');
  assert.deepEqual(selectRelevantCandidateMaterial(budgeted, { query: paraphrases[0].query, limit: 1, maxChars: 100 }).map(row => row.id), [320],
    'concept ranking preserves the requested count limit');
  console.log('candidate_evidence_smoke ok');
} finally { db.close(); }

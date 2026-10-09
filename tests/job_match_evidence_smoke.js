const assert = require('node:assert/strict');
const { buildJobMatchEvidence, verifyJobMatchEvidence } = require('../src/core/job_match_evidence');

const candidateProfile = {
  education: [{ degree: '本科', endDate: '2024-06', status: '已毕业' }],
  projects: [{ name: '接口项目', canSay: ['使用 Python 编写客户查询接口，并根据慢查询日志优化 SQL。'] }],
  credentials: [],
  source: { resumeEvidenceText: '本科，2024年6月毕业。使用 Python 编写客户查询接口，并根据慢查询日志优化 SQL。' }
};
const jobFacts = { description: '本科及以上学历。负责 Python 接口开发与查询性能优化。' };
const evidence = buildJobMatchEvidence({ candidateProfile, jobFacts });
const degree = evidence.entries.find(e => e.sourcePath === 'education[0].degree');
const date = evidence.entries.find(e => e.sourcePath === 'education[0].endDate');
const jd = evidence.entries.find(e => e.sourceKind === 'jd');
const action = evidence.entries.find(e => e.sourcePath === 'projects[0].canSay[0]');
assert.equal(degree.value, '本科');
assert.equal(date.precision, 'month');
assert.equal(evidence.entries.some(e => /credentials\[/.test(e.sourcePath)), false, 'an empty credential list is not evidence of having no certificate');
assert.equal(verifyJobMatchEvidence({ evidence, refs: [degree.id], sourceKind: 'profile_fact' }).valid, true);
assert.equal(verifyJobMatchEvidence({ evidence, refs: [jd.id], sourceKind: 'resume' }).valid, false);
assert.deepEqual(verifyJobMatchEvidence({ evidence, refs: ['C-does-not-exist'] }).invalidIds, ['C-does-not-exist']);
assert.equal(verifyJobMatchEvidence({ evidence, refs: [{ id: degree.id, quote: '硕士' }] }).valid, false, 'a real ID does not validate an invented degree');
assert.equal(verifyJobMatchEvidence({ evidence, refs: [{ id: action.id, quote: action.quote }] }).valid, true);
assert.equal(verifyJobMatchEvidence({ evidence, refs: [action.id, action.id] }).valid, true);
const reordered = buildJobMatchEvidence({ candidateProfile: {
  source: candidateProfile.source, credentials: [], projects: candidateProfile.projects, education: candidateProfile.education
}, jobFacts });
assert.deepEqual(reordered, evidence, 'object key insertion order must not change stable evidence IDs');
const yearOnly = buildJobMatchEvidence({ candidateProfile: { education: [{ endDate: '2026' }] }, jobFacts });
assert.equal(yearOnly.entries.find(e => e.sourcePath === 'education[0].endDate').precision, 'year');
assert.deepEqual(JSON.parse(JSON.stringify(evidence)), evidence);
console.log('job_match_evidence_smoke ok');

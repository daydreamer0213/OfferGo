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
assert.equal(verifyJobMatchEvidence({ evidence, refs: [degree.id], sourceKind: 'profile_fact', claim: '简历：取得硕士学历' }).valid,
false, '真实本科 ID 不能替虚构硕士背书');
assert.equal(verifyJobMatchEvidence({ evidence, refs: [action.id], sourceKind: 'profile_fact', claim: '简历：具备接口开发和查询优化的实践' }).valid,
true, '有真实来源的自然概括应被接受');
const durationEvidence = buildJobMatchEvidence({ candidateProfile: { experience: [{ durationMonths: 8 }] } });
assert.equal(verifyJobMatchEvidence({ evidence: durationEvidence, refs: [durationEvidence.entries[0].id],
  claim: '简历：拥有一年开发经验' }).valid, false, '八个月不能被夸大成一年');
const linkedDuration = buildJobMatchEvidence({ candidateProfile: { experience: [{ durationMonths: 8, canSay: ['编写客户查询接口。'] }] } });
const actionRef = linkedDuration.entries.find(entry => entry.sourcePath.endsWith('canSay[0]')).id;
assert.equal(verifyJobMatchEvidence({ evidence: linkedDuration, refs: [actionRef], claim: '简历：拥有三年接口开发经验' }).valid,
false, '引用工作内容也必须核对同条经历已知时长');
assert.equal(verifyJobMatchEvidence({ evidence: linkedDuration, refs: [actionRef], claim: '简历：八个月接口开发实习' }).valid, true);
const limited = buildJobMatchEvidence({ candidateProfile: { source: {
  resumeEvidenceText: '仅在本地课程项目编写接口，未负责生产系统。'
} } });
assert.equal(verifyJobMatchEvidence({ evidence: limited, refs: [limited.entries[0].id],
  claim: '简历：独立负责生产系统接口架构与交付' }).valid, false);
assert.equal(verifyJobMatchEvidence({ evidence: limited, refs: [limited.entries[0].id],
  claim: '简历：有本地接口实践，可迁移到生产系统开发，尚未证明生产交付' }).valid, true);
const limitedSummary = buildJobMatchEvidence({ candidateProfile: { projects: [{ canSay: ['编写接口'] }], source: {
  resumeEvidenceText: '仅在本地课程项目编写接口，未负责生产系统。'
} } });
assert.equal(verifyJobMatchEvidence({ evidence: limitedSummary, refs: [limitedSummary.entries.find(entry => entry.sourceKind === 'profile_fact').id],
  claim: '简历：独立负责生产系统接口交付' }).valid, false, '只引用摘要不能绕过原简历明确工作边界');
assert.equal(verifyJobMatchEvidence({ evidence, refs: [date.id], claim: '简历：2027年毕业' }).valid, false);
const permits = buildJobMatchEvidence({ candidateProfile: { credentials: [
  { name: '中国工作许可', details: '未持有' }, { name: '教师资格证', details: '已取得' }
] } });
assert.equal(verifyJobMatchEvidence({ evidence: permits, refs: permits.entries.map(entry => entry.id), claim: '简历：已取得教师资格证' }).valid, true,
'另一证照不满足不能否定已取得的证照');
assert.equal(verifyJobMatchEvidence({ evidence: permits, refs: permits.entries.filter(entry => entry.sourcePath.startsWith('credentials[0]')).map(entry => entry.id),
  claim: '简历：持有中国工作许可' }).valid, false);
const collaboration = buildJobMatchEvidence({ candidateProfile: { projects: [{
  canSay: ['进行日志排查与基础测试'], roleBoundary: '不主张独立售前或客户项目管理'
}] } });
assert.equal(verifyJobMatchEvidence({ evidence: collaboration, refs: collaboration.entries.map(entry => entry.id),
  claim: '简历：未涉及客户现场联调或项目交付' }).valid, false, '没有独立管理责任不能变成没有参与协作经历');
assert.equal(verifyJobMatchEvidence({ evidence: collaboration, refs: collaboration.entries.map(entry => entry.id),
  claim: '简历：参与日志排查与测试，未独立负责客户项目管理' }).valid, true, '保留有依据的个人行动和责任范围');
assert.equal(verifyJobMatchEvidence({ evidence: collaboration, refs: collaboration.entries.map(entry => entry.id),
  claim: '简历：不主张独立售前，不代表没有客户沟通经验' }).valid, true, '否定推论不是声称没有相关经历');
const unrelatedAbsence = buildJobMatchEvidence({ candidateProfile: { projects: [{
  canSay: ['进行日志排查与测试，未使用Kubernetes'], roleBoundary: '不主张独立售前或客户项目管理'
}] } });
assert.equal(verifyJobMatchEvidence({ evidence: unrelatedAbsence, refs: unrelatedAbsence.entries.map(entry => entry.id),
  claim: '简历：未参与客户沟通' }).valid, false, '其他工具的明确缺口不能证明客户沟通缺口');
console.log('job_match_evidence_smoke ok');

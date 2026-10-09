const assert = require('node:assert/strict');
const { buildJobMatchEvidence } = require('../src/core/job_match_evidence');
const {
  normalizeJobConditions, assessJobConditions, summarizeQualifications, projectCapabilityRequirements
} = require('../src/core/job_match_conditions');

const windowClause = '本科毕业时间需在2026年11月1日至2027年10月31日之间。';
const dates = [{ allOf: [{ kind: 'graduation_date', operator: 'within', value: ['2026-11-01', '2027-10-31'] }] }];
function evaluate({ candidateProfile, label, alternatives, trackIds = ['T1'], strength = 'mandatory', selectedTrackId = 'T1', reportedResults = [] }) {
  const evidence = buildJobMatchEvidence({ candidateProfile, jobFacts: { description: label } });
  const conditions = normalizeJobConditions({ jobUnderstanding: {
    hiringTracks: [{ id: 'T1' }, { id: 'T2' }],
    eligibilityItems: [{ id: 'E1', label, evidence: `JD：${label}`, trackIds, strength, alternatives }]
  }, evidence });
  const conditionResults = assessJobConditions({ conditions, reportedResults, evidence, selectedTrackId });
  return { conditions, conditionResults, summary: summarizeQualifications({ conditions, conditionResults, selectedTrackId }) };
}
for (const [date, expected] of [
  ['2024-06', 'conflict'], ['2026-10-31', 'conflict'], ['2026-11-01', 'satisfied'],
  ['2027-10-31', 'satisfied'], ['2027-11-01', 'conflict'], ['2026', 'unknown'], ['', 'unknown']
]) {
  const result = evaluate({ candidateProfile: { education: [{ degree: '本科', endDate: date }] }, label: windowClause, alternatives: dates });
  assert.equal(result.summary.status, expected, `date precision and bounds: ${date}`);
}
assert.equal(evaluate({ candidateProfile: { education: [
  { degree: '本科', endDate: '2024-06', status: '已毕业' }, { degree: '硕士', status: '在读' }
] }, label: '毕业时间需在2026年11月1日至2027年10月31日之间。', alternatives: dates }).summary.status, 'unknown');
const scopedDate = [{ allOf: [{ ...dates[0].allOf[0], educationLevels: ['本科'] }] }];
assert.equal(evaluate({ candidateProfile: { education: [
  { degree: '本科', endDate: '2024-06', status: '已毕业' }, { degree: '硕士', status: '在读' }
] }, label: windowClause, alternatives: scopedDate }).summary.status, 'conflict', 'an unrelated ongoing master must not hide an explicit bachelor date conflict');
const joint = [{ allOf: [
  { kind: 'education_level', operator: 'at_least', value: '硕士' },
  { kind: 'graduation_date', operator: 'within', value: ['2026-11-01', '2027-10-31'] }
] }];
assert.equal(evaluate({ candidateProfile: { education: [
  { degree: '本科', endDate: '2027-06', status: '已毕业' }, { degree: '硕士', endDate: '2024-06', status: '已毕业' }
] }, label: '硕士及以上学历，毕业时间需在2026年11月1日至2027年10月31日之间。', alternatives: joint }).summary.status, 'conflict', 'degree and date must come from the same education record');
const degree = [{ allOf: [{ kind: 'education_level', operator: 'at_least', value: '硕士' }] }];
assert.equal(evaluate({ candidateProfile: { education: [{ degree: '本科' }] }, label: '硕士及以上学历', alternatives: degree,
  reportedResults: [{ conditionId: 'E1', state: 'satisfied', resumeEvidence: '简历：取得硕士学历' }] }).summary.status, 'conflict', 'a claimed master must not override an actual bachelor');
assert.equal(evaluate({ candidateProfile: { education: [{ degree: '本科', status: '已毕业' }] }, label: '仅限在校学生',
  alternatives: [{ allOf: [{ kind: 'student_status', operator: 'equals', value: 'in_school' }] }] }).summary.status, 'conflict');
const certificate = name => ({ allOf: [{ kind: 'credential', operator: 'has', value: name }] });
const credentialCandidate = details => ({ credentials: [{ name: 'C1驾驶证', details }] });
assert.equal(evaluate({ candidateProfile: credentialCandidate('尚未取得'), label: '必须持有C1驾驶证', alternatives: [certificate('C1驾驶证')] }).summary.status, 'conflict');
assert.equal(evaluate({ candidateProfile: { credentials: [] }, label: '必须持有C1驾驶证', alternatives: [certificate('C1驾驶证')] }).summary.status, 'unknown');
assert.equal(evaluate({ candidateProfile: credentialCandidate('已取得'), label: '必须持有C1或C2驾驶证', alternatives: [certificate('C1驾驶证'), certificate('C2驾驶证')] }).summary.status, 'satisfied');
assert.equal(evaluate({ candidateProfile: { credentials: [
  { name: 'C1驾驶证', details: '尚未取得' }, { name: 'C2驾驶证', details: '尚未取得' }
] }, label: '必须持有C1或C2驾驶证', alternatives: [certificate('C1驾驶证'), certificate('C2驾驶证')] }).summary.status, 'conflict');
assert.equal(evaluate({ candidateProfile: credentialCandidate('尚未取得'), label: '必须持有C1或C2驾驶证', alternatives: [certificate('C1驾驶证'), certificate('C2驾驶证')] }).summary.status, 'unknown');
assert.equal(evaluate({ candidateProfile: credentialCandidate('尚未取得'), label: 'T1必须持有C1驾驶证', alternatives: [certificate('C1驾驶证')], selectedTrackId: 'T2' }).summary.status, 'not_required');
assert.equal(evaluate({ candidateProfile: credentialCandidate('尚未取得'), label: '持有C1驾驶证优先', strength: 'preferred', alternatives: [certificate('C1驾驶证')] }).summary.status, 'not_required');

const evidence = buildJobMatchEvidence({ candidateProfile: { education: [{ degree: '本科' }] }, jobFacts: { description: '本科及以上学历。负责 Python 接口开发。' } });
const conditions = normalizeJobConditions({ evidence, jobUnderstanding: {
  hiringTracks: [{ id: 'T1' }], coreRequirements: [
    { id: 'R1', label: '本科及以上学历', evidence: 'JD：本科及以上学历', indispensable: true, trackIds: ['T1'] },
    { id: 'R2', label: 'Python 接口开发', evidence: 'JD：负责 Python 接口开发', foundation: true, trackIds: ['T1'] },
    { id: 'R3', label: '为本科教学平台开发接口', evidence: 'JD：负责 Python 接口开发', foundation: true, trackIds: ['T1'] }
  ]
} });
assert.equal(conditions.find(c => c.id === 'R1').category, 'qualification');
assert.equal(conditions.find(c => c.id === 'R2').category, 'capability');
assert.equal(conditions.find(c => c.id === 'R3').category, 'capability', 'a duty containing 本科 must not become an education gate');
const capabilityRows = projectCapabilityRequirements({ conditions, conditionResults: [
  { conditionId: 'R1', state: 'satisfied' }, { conditionId: 'R2', state: 'matched' }, { conditionId: 'R3', state: 'unknown' }
], selectedTrackId: 'T1' });
assert.equal(capabilityRows.length, 2);
assert.equal(capabilityRows.some(r => /学历/.test(r.requirement)), false);
assert.equal(capabilityRows.find(r => r.requirement === 'Python 接口开发').foundation, true);

const fixtures = require('./fixtures/job_match_effect_cases.json');
for (const fixture of fixtures.cases.filter(item => item.verification === 'qualification')) {
  for (const candidateProfile of [fixture.candidateProfile, ...(fixture.additionalCandidateProfiles || [])]) {
    const evidence = buildJobMatchEvidence({ candidateProfile, jobFacts: fixture.jobFacts });
    const conditions = normalizeJobConditions({ jobUnderstanding: fixture.jobUnderstanding, evidence });
    const conditionResults = assessJobConditions({ conditions, evidence, selectedTrackId: fixture.selectedTrackId });
    assert.equal(summarizeQualifications({ conditions, conditionResults, selectedTrackId: fixture.selectedTrackId }).status,
      fixture.expected.qualificationStatus, `${fixture.id}: ${fixture.reason}`);
  }
}

const credentialEvidence = buildJobMatchEvidence({ candidateProfile: credentialCandidate('已取得'),
  jobFacts: { description: '必须持有C1驾驶证' } });
const inferredCredential = normalizeJobConditions({ evidence: credentialEvidence,
  jobUnderstanding: { eligibilityItems: ['必须持有C1驾驶证'] } });
assert.equal(summarizeQualifications({ conditions: inferredCredential,
  conditionResults: assessJobConditions({ conditions: inferredCredential, evidence: credentialEvidence }) }).status, 'satisfied');
const separateIds = normalizeJobConditions({ evidence, jobUnderstanding: {
  eligibilityItems: ['本科及以上学历'], coreRequirements: ['Python接口开发'], bonusRequirements: ['SQL优先']
} });
assert.equal(new Set(separateIds.map(condition => condition.id)).size, 3);
assert.throws(() => normalizeJobConditions({ evidence, jobUnderstanding: {
  eligibilityItems: [{ id: 'E1', label: '本科及以上学历' }], coreRequirements: [{ id: 'E1', label: 'Python接口开发' }]
} }), /DUPLICATE_ID/);
assert.equal(evaluate({ candidateProfile: { education: [
  { degree: '本科', endDate: '2024-06', status: '已毕业' }, { endDate: '2027-06', status: '在读' }
] }, label: windowClause, alternatives: scopedDate }).summary.status, 'unknown');
for (const label of ['不限制毕业时间', '不限定毕业时间']) {
  const evidence = buildJobMatchEvidence({ candidateProfile: {}, jobFacts: { description: label } });
  const conditions = normalizeJobConditions({ evidence, jobUnderstanding: { eligibilityItems: [label] } });
  assert.equal(summarizeQualifications({ conditions, conditionResults: assessJobConditions({ conditions, evidence }) }).status, 'not_required');
}
const permitEvidence = buildJobMatchEvidence({ candidateProfile: {}, jobFacts: { description: '必须具备中国工作许可' } });
const permit = normalizeJobConditions({ evidence: permitEvidence, jobUnderstanding: { eligibilityItems: ['必须具备中国工作许可'] } });
const falsePermit = assessJobConditions({ conditions: permit, evidence: permitEvidence, reportedResults: [
  { conditionId: 'E1', state: 'satisfied', candidateEvidenceRefs: [permitEvidence.entries[0].id] }
] });
assert.equal(summarizeQualifications({ conditions: permit, conditionResults: falsePermit }).status, 'unknown', 'JD cannot be evidence of candidate eligibility');
for (const [resume, expected] of [['未持有教师资格证', 'conflict'], ['已取得教师资格证', 'satisfied'], ['计划报考教师资格证', 'unknown']]) {
  assert.equal(evaluate({ candidateProfile: { credentials: [], source: { resumeEvidenceText: resume } },
    label: '必须持有教师资格证', alternatives: [certificate('教师资格证')] }).summary.status,
  expected, 'explicit original resume facts survive a summary omission');
}
assert.equal(evaluate({ candidateProfile: { education: [{ degree: '本科' }] },
  label: '硕士及以上学历，教师资格证优先', alternatives: degree }).summary.status,
'conflict', 'a certificate preference does not cancel an independently mandatory degree');
assert.equal(normalizeJobConditions({ evidence, jobUnderstanding: { eligibilityConstraints: ['JD：本科及以上学历'] } })[0].category, 'qualification');
console.log('job_match_conditions_smoke ok');

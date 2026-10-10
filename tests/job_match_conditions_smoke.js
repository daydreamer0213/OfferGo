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
const bachelor = [{ allOf: [{ kind: 'education_level', operator: 'at_least', value: '本科' }] }];
for (const [label, degree, expected] of [['必须本科学历', '本科', 'satisfied'],
  ['必须全日制本科及以上学历', '非全日制本科', 'conflict']]) {
  assert.equal(evaluate({ candidateProfile: { education: [{ degree }] }, label,
    alternatives: [{ allOf: [{ kind: 'semantic', operator: 'meets', value: label }] }] }).summary.status, expected);
}
assert.equal(evaluate({ candidateProfile: { education: [{ degree: '非全日制本科' }] },
  label: '本科及以上学历，必须为全日制', alternatives: bachelor }).summary.status, 'conflict');
for (const [mode, expected] of [['全日制', 'satisfied'], ['非全日制', 'conflict']]) {
  assert.equal(evaluate({ candidateProfile: { education: [{ degree: '本科' }], source: {
    resumeEvidenceText: `已取得本科学历，学制为${mode}，2024年6月毕业。`
  } }, label: '全日制本科及以上学历', alternatives: bachelor }).summary.status, expected);
}
const modeOrCredentialProfile = { education: [{ degree: '本科' }],
  credentials: [{ name: '教师资格证', held: false }], projects: [{ name: '软件交付', canSay: ['完成软件交付'] }] };
const modeOrCredentialEvidence = buildJobMatchEvidence({ candidateProfile: modeOrCredentialProfile });
assert.equal(evaluate({ candidateProfile: modeOrCredentialProfile,
  label: '全日制本科并具有软件交付经验，或者持有教师资格证', alternatives: [{ allOf: [bachelor[0].allOf[0],
    { kind: 'semantic', operator: 'meets', value: '软件交付经验' }] }, { allOf: [{ kind: 'credential', operator: 'has', value: '教师资格证' }] }],
  reportedResults: [{ id: 'E1', state: 'satisfied', resumeEvidence: '简历：本科；完成软件交付',
    candidateEvidenceRefs: modeOrCredentialEvidence.entries.map(entry => entry.id) }] }).summary.status, 'unknown');
assert.equal(evaluate({ candidateProfile: { education: [{ degree: '非全日制本科' }] },
  label: '全日制本科及以上学历', alternatives: [{ allOf: [{ kind: 'semantic', operator: 'meets', value: '全日制本科及以上学历' }] }] }).summary.status,
  'conflict', '语义形式的单一学历要求也应进入确定比较，不能漏掉学制');
for (const [education, expected] of [
  [[{ degree: '非全日制本科' }], 'conflict'],
  [[{ degree: '本科', studyMode: '非全日制' }], 'conflict'],
  [[{ degree: '本科', studyMode: '全日制' }], 'satisfied'],
  [[{ degree: '本科' }], 'unknown'],
  [[{ degree: '非全日制本科' }, { degree: '大专', studyMode: '全日制' }], 'conflict'],
  [[{ degree: '非全日制本科' }, { degree: '硕士', studyMode: '全日制' }], 'satisfied']
]) {
  const result = evaluate({ candidateProfile: { education }, label: '要求全日制本科及以上学历', alternatives: bachelor });
  assert.equal(result.summary.status, expected, '学制与学历必须在同一条教育记录共同满足');
  if (expected === 'conflict') {
    const decision = require('../src/core/job_match_decision').decideJobMatch({ job: {}, analysis: {
      semanticStatus: 'complete', conditionSchemaVersion: 1, conditions: result.conditions,
      conditionResults: result.conditionResults, selectedTrackId: 'T1', requirementMatches: [], responsibilityMatches: []
    } });
    assert.equal(decision.recommendation, 'not_recommended');
    assert.equal(decision.decisionSource, 'qualification_conflict');
  }
}
for (const label of ['本科及以上学历', '本科及以上学历，全日制优先', '本科及以上学历，学制不限']) {
  assert.equal(evaluate({ candidateProfile: { education: [{ degree: '非全日制本科' }] }, label, alternatives: bachelor }).summary.status,
    'satisfied', '普通本科和全日制优先不能成为学制硬门槛');
}
const educationChoices = ['本科','硕士'].map(value => ({ allOf: [{ kind: 'education_level', operator: 'equals', value }] }));
assert.equal(evaluate({ candidateProfile: { education: [{ degree: '非全日制硕士' }] },
  label: '必须符合以下任一项：全日制本科，或者全日制硕士学历', alternatives: educationChoices }).summary.status, 'conflict');
assert.equal(evaluate({ candidateProfile: { education: [{ degree: '非全日制硕士' }] },
  label: '必须符合以下任一项：全日制本科，或者硕士学历（学制不限）', alternatives: educationChoices }).summary.status,
  'satisfied', '局部学制约束不能越过OR边界污染明确不限学制的替代分支');
const unknownModeProfile = { education: [{ degree: '本科' }], projects: [{ name: '软件交付', canSay: ['完成软件交付'] }] };
const unknownModeEvidence = buildJobMatchEvidence({ candidateProfile: unknownModeProfile });
assert.equal(evaluate({ candidateProfile: unknownModeProfile, label: '全日制本科并具有软件交付经验', alternatives: [{ allOf: [
  bachelor[0].allOf[0], { kind: 'semantic', operator: 'meets', value: '软件交付经验' }
] }], reportedResults: [{ id: 'E1', state: 'satisfied', resumeEvidence: '简历：本科；完成软件交付',
  candidateEvidenceRefs: unknownModeEvidence.entries.map(entry => entry.id) }] }).summary.status,
  'unknown', '语义经验已满足也不能覆盖同一合取分支中未知的学制');
assert.equal(evaluate({ candidateProfile: { education: [{ degree: '本科' }], source: { resumeEvidenceText: '已取得非全日制本科学历，2024年6月毕业。' } },
  label: '全日制本科及以上学历', alternatives: bachelor }).summary.status, 'conflict', '原简历已明确学制时补齐画像遗漏');
for (const [label, fact, expected] of [
  ['计算机科学与技术或相关专业', '电子信息工程', 'unknown'],
  ['仅接受计算机科学与技术专业', '电子信息工程', 'conflict'],
  ['计算机科学与技术或相关专业', '招聘方已确认不接受电子信息工程专业', 'conflict']
]) {
  const candidateProfile = { education: [{ major: fact }] };
  const evidence = buildJobMatchEvidence({ candidateProfile });
  assert.equal(evaluate({ candidateProfile, label,
    alternatives: [{ allOf: [{ kind: 'semantic', operator: 'meets', value: label }] }],
    reportedResults: [{ id: 'E1', state: 'conflict', resumeEvidence: `简历：${fact}，非计算机科学与技术或相关专业。`,
      candidateEvidenceRefs: evidence.entries.map(entry => entry.id) }]
  }).summary.status, expected, '开放的相关专业范围不能因专业名称不同而直接认定冲突');
}
assert.equal(evaluate({ candidateProfile: { experiences: [{ durationMonths: 8, highlights: ['参与接口开发'] }] },
  label: '3-5年工作经验', alternatives: [{ allOf: [{ kind: 'semantic', operator: 'meets', value: '3-5年工作经验' }] }]
}).summary.status, 'not_required', '模型把年限放入资格时也必须保留原有可冲政策');
assert.equal(evaluate({ candidateProfile: { experiences: [{ durationMonths: 8 }] },
  label: '3-5 年经验', alternatives: [{ allOf: [{ kind: 'semantic', operator: 'meets', value: '项目能力突出者，年限可适当放宽' }] }]
}).summary.status, 'not_required', '模型把年限可放宽改写进替代分支，也不能重新变成资格硬门槛');
assert.equal(evaluate({ candidateProfile: {}, label: '3-5 年经验', alternatives: [{ allOf: [
  { kind: 'semantic', operator: 'meets', value: '必须掌握Java，年限可适当放宽' }
] }] }).conditions[0].category, 'qualification', '同一分支中的独立技能前提不能因年限可放宽而消失');
assert.equal(evaluate({ candidateProfile: {}, label: '必须熟练Java并具备3年经验',
  alternatives: [{ allOf: [{ kind: 'semantic', operator: 'meets', value: '必须熟练Java并具备3年经验' }] }]
}).conditions[0].category, 'qualification', '混合独立技能前提不能被年限政策整条抹掉');
for (const [degree, expected] of [['本科','satisfied'], ['大专','conflict']]) {
  const label = '本科及以上学历且具备3年经验';
  const candidateProfile = { education: [{ degree }], experiences: [{ durationMonths: 8 }] };
  const evidence = buildJobMatchEvidence({ candidateProfile });
  assert.equal(evaluate({ candidateProfile, label, alternatives: [{ allOf: [{ kind: 'semantic', operator: 'meets', value: label }] }],
    reportedResults: [{ id: 'E1', state: 'conflict', resumeEvidence: `简历：${degree}，8个月工作经验`,
      candidateEvidenceRefs: evidence.entries.map(entry => entry.id) }] }).summary.status, expected,
  '合取仍用语义原子时只移除可冲年限，保留学历资格');
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
for (const [credentials, expected] of [
  [[{ name: 'C1驾驶证', details: '已取得' }], 'satisfied'],
  [[{ name: 'C1驾驶证', details: '尚未取得' }, { name: 'C2驾驶证', details: '尚未取得' }], 'conflict'],
  [[{ name: 'C1驾驶证', details: '尚未取得' }], 'unknown']
]) {
  const label = '必须持有C1或C2驾驶证';
  const evidence = buildJobMatchEvidence({ candidateProfile: { credentials }, jobFacts: { description: label } });
  const conditions = normalizeJobConditions({ evidence, jobUnderstanding: { coreRequirements: [
    { id: 'R1', label: '持有C1或C2驾驶证', evidence: `JD：${label}`, trackIds: ['T1'], indispensable: true }
  ] } });
  assert.equal(summarizeQualifications({ conditions, conditionResults: assessJobConditions({ conditions, evidence }) }).status,
    expected, '真实旧格式输出中的任选证照不能合成一张不存在的证照');
}
assert.equal(evaluate({ candidateProfile: { education: [
  { degree: '本科', endDate: '2024-06', status: '已毕业' }, { degree: '硕士', status: '在读' }
] }, label: windowClause, alternatives: [{ allOf: [
  { kind: 'education_level', operator: 'at_least', value: '本科' },
  { kind: 'graduation_date', operator: 'within', value: ['2026-11-01', '2027-10-31'] }
] }] }).summary.status, 'conflict', '真实模型漏写educationLevels时仍应遵守JD明确的本科日期范围');
assert.equal(evaluate({ candidateProfile: { education: [
  { degree: '本科', endDate: '2024-06', status: '已毕业' }, { degree: '硕士', endDate: '2027-06', status: '已毕业' }
], credentials: [{ name: 'C1驾驶证', details: '已取得' }] },
label: '本科毕业时间需在2026年11月1日至2027年10月31日之间，并必须持有C1或C2驾驶证',
alternatives: ['C1驾驶证','C2驾驶证'].map(value => ({ allOf: [
  { kind: 'education_level', operator: 'at_least', value: '本科' },
  { kind: 'graduation_date', operator: 'within', value: ['2026-11-01','2027-10-31'] },
  { kind: 'credential', operator: 'has', value }
] })) }).summary.status, 'conflict', '证照的替代分支不能抹掉每个分支共用的本科日期范围');
assert.equal(evaluate({ candidateProfile: { credentials: [{ name: 'C1驾驶证', details: '未持有' }] },
  label: '必须持有C1驾驶证', alternatives: [certificate('C1驾驶证')] }).summary.status, 'conflict', '未持有不能被持有子串误判');
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
assert.equal(evaluate({ candidateProfile: { education: [], source: { resumeEvidenceText: '已取得本科学历，2024年6月毕业。' } },
  label: '本科及以上学历', alternatives: [{ allOf: [{ kind: 'education_level', operator: 'at_least', value: '本科' }] }] }).summary.status,
'satisfied', '画像漏掉学历时应复用原简历明确事实');
assert.equal(evaluate({ candidateProfile: { education: [{ degree: '博士' }] }, label: '硕士及以上学历',
  alternatives: [{ allOf: [{ kind: 'education_level', operator: 'equals', value: '硕士' }] }] }).summary.status,
'satisfied', '及以上不能被模型改成恰好该学历');
assert.equal(evaluate({ candidateProfile: { education: [{ degree: '本科' }], source: { resumeEvidenceText: '已取得本科学历，2024年6月毕业。' } },
  label: '仅招2024届', alternatives: [{ allOf: [{ kind: 'graduation_date', operator: 'cohort', value: [2024] }] }] }).summary.status,
'satisfied', '原简历已有毕业日期时补齐画像遗漏');
assert.equal(evaluate({ candidateProfile: { education: [{ degree: '本科', endDate: '2022' }], source: { resumeEvidenceText: '本科2022毕业。硕士2025毕业。' } },
  label: '硕士及以上学历', alternatives: [{ allOf: [{ kind: 'education_level', operator: 'at_least', value: '硕士' }] }] }).summary.status,
'satisfied', '画像遗漏后续学历时仍使用原简历明确记录');
assert.notEqual(evaluate({ candidateProfile: { education: [], source: { resumeEvidenceText: '因未完成毕业要求，未获得本科学历。' } },
  label: '本科及以上学历', alternatives: [{ allOf: [{ kind: 'education_level', operator: 'at_least', value: '本科' }] }] }).summary.status,
'satisfied', '原文明确未获得学历不能回填为已取得');
console.log('job_match_conditions_smoke ok');
const masterJdEvidence = buildJobMatchEvidence({ candidateProfile: { education: [{ degree: '本科' }] },
  jobFacts: { description: '硕士及以上学历' } });
for (const item of [
  { label: '本科及以上学历', evidence: 'JD：本科及以上学历', alternatives: [{ allOf: [{ kind: 'education_level', operator: 'at_least', value: '本科' }] }] },
  { label: '硕士及以上学历', evidence: 'JD：硕士及以上学历', alternatives: [{ allOf: [{ kind: 'education_level', operator: 'at_least', value: '本科' }] }] }
]) {
  const conditions = normalizeJobConditions({ evidence: masterJdEvidence, jobUnderstanding: { eligibilityItems: [
    { ...item, jdEvidenceRefs: [masterJdEvidence.entries.find(entry => entry.sourceKind === 'jd').id] }
  ] } });
  const result = assessJobConditions({ conditions, evidence: masterJdEvidence });
  assert.notEqual(summarizeQualifications({ conditions, conditionResults: result }).status, 'satisfied',
    '真实 JD 来源 ID 不能为改写的学历门槛背书');
}

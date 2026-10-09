const { graduationDateWindow, educationRank, requiredCohortConstraint } = require('./job_eligibility');
const { verifyJobMatchEvidence } = require('./job_match_evidence');

const QUALIFICATION_STATES = new Set(['satisfied', 'conflict', 'unknown']);
const CAPABILITY_STATES = new Set(['matched', 'transferable', 'missing', 'unknown']);
const text = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const compact = value => text(value).replace(/\s+/g, '');
const applies = (condition, track) => !track || !condition.trackIds?.length || condition.trackIds.includes(track);

function inferredAtoms(label) {
  const clauses = text(label).split(/[，,；;。]|并且|同时|且/).map(part => part.trim()).filter(Boolean);
  const hard = clauses.filter(part => !/优先|加分|可选|不限|不要求|不限制|不限定|无需/.test(part))
    .flatMap(inferSingleAtoms);
  return hard.length ? hard : inferSingleAtoms(label);
}

function inferSingleAtoms(label) {
  const source = text(label);
  if (/不(?:要求|限制|限定).{0,8}(?:学历|毕业|在校|在读|证)|(?:学历|毕业时间|毕业日期).{0,8}(?:不要求|不限|无要求)/.test(source)) return [];
  const cohort = requiredCohortConstraint(source);
  if (cohort?.dateWindow) return [{ kind: 'graduation_date', operator: 'within',
    value: [cohort.dateWindow.minimum, cohort.dateWindow.maximum] }];
  if (cohort) return [{ kind: 'graduation_date', operator: 'cohort',
    value: cohort.years.length ? cohort.years : [cohort.minimum, cohort.maximum], range: !cohort.years.length }];
  const degree = source.match(/^(?:学历(?:要求)?[:：]?\s*|(?:至少|最低|要求|须具备|具有|具备)\s*)?(中专|高中|大专|专科|本科|学士|硕士|研究生|博士)(?:及以上|以上)?(?:学历|学位|毕业|及以上|以上|$)/);
  if (degree) return [{ kind: 'education_level', operator: 'at_least', value: degree[1] }];
  if (/(?:仅限|只招|必须|需为|面向).{0,8}(?:在校|在读)(?:生|学生)/.test(source)) {
    return [{ kind: 'student_status', operator: 'equals', value: 'in_school' }];
  }
  const credentialSource = source.replace(/^(?:(?:必须|需要|要求|须|应当|持有|取得|具备|持)\s*)+/, '');
  const credential = credentialSource !== source && credentialSource.match(/^([A-Za-z0-9\u4e00-\u9fa5]{1,18}(?:驾驶证|资格证|执业证|证书|认证))/);
  if (credential) return [{ kind: 'credential', operator: 'has', value: credential[1] }];
  return [];
}

function jdRefs(item, evidence) {
  if (Array.isArray(item.jdEvidenceRefs)) return item.jdEvidenceRefs;
  const quote = compact(item.evidence || item.jdEvidence || item.label).replace(/^JD[:：]?/i, '');
  return (evidence.entries || []).filter(entry => entry.sourceKind === 'jd'
    && quote && compact(entry.quote).includes(quote)).map(entry => entry.id);
}

function normalizeJobConditions({ jobUnderstanding = {}, evidence = {} } = {}) {
  const conditions = [];
  const append = (raw, category, index) => {
    const item = typeof raw === 'string' ? { label: raw } : raw || {};
    const label = text(item.label || item.requirement).replace(/^JD[:：]\s*/i, '');
    if (!label) return;
    const atoms = inferredAtoms(label);
    const qualification = category === 'qualification' || item.category === 'qualification' || atoms.length > 0;
    const hasIndependentHardCondition = label.split(/[，,；;。]|并且|同时|且/).some(part =>
      !/优先|加分|可选|不限|不要求|不限制|不限定|无需/.test(part) && inferSingleAtoms(part).length > 0);
    const soft = !hasIndependentHardCondition && /优先|加分|可选|不限|不要求|不限制|不限定|无需|无硬性要求/.test(label) && !/必须|仅限|只招/.test(label);
    const normalized = {
      id: text(item.id) || `${category === 'qualification' ? 'E' : category === 'preference' ? 'B' : 'R'}${index + 1}`,
      category: qualification ? 'qualification' : item.category === 'preference' ? 'preference' : category,
      label, trackIds: Array.isArray(item.trackIds) ? [...new Set(item.trackIds)] : [],
      strength: item.strength === 'preferred' || soft || category === 'preference' ? 'preferred' : 'mandatory',
      jdEvidenceRefs: jdRefs(item, evidence),
      alternatives: Array.isArray(item.alternatives) && item.alternatives.length
        ? item.alternatives.map(branch => ({ allOf: Array.isArray(branch.allOf) ? branch.allOf.map(atom => ({ ...atom })) : [] }))
        : [{ allOf: atoms.length ? atoms : [{ kind: 'semantic', operator: 'meets', value: label }] }],
      foundation: item.foundation === true, central: item.central === true, indispensable: item.indispensable === true
    };
    const existing = conditions.find(condition => condition.id === normalized.id);
    if (existing) throw new Error(`JOB_CONDITION_DUPLICATE_ID: ${normalized.id}`);
    conditions.push(normalized);
  };
  const eligibility = Array.isArray(jobUnderstanding.eligibilityItems)
    ? jobUnderstanding.eligibilityItems : jobUnderstanding.eligibilityConstraints || [];
  eligibility.forEach((item, i) => append(item, 'qualification', i));
  (jobUnderstanding.coreRequirements || []).forEach((item, i) => append(item, 'capability', i));
  (jobUnderstanding.bonusRequirements || []).forEach((item, i) => append(item, 'preference', i));
  return conditions;
}

function combineAll(states) {
  return states.includes('conflict') ? 'conflict' : states.length && states.every(state => state === 'satisfied') ? 'satisfied' : 'unknown';
}
function combineAny(states) {
  return states.includes('satisfied') ? 'satisfied' : states.length && states.every(state => state === 'conflict') ? 'conflict' : 'unknown';
}
function educationRecords(evidence) {
  const records = new Map();
  for (const entry of evidence.entries || []) {
    const match = entry.sourceKind === 'profile_fact' && entry.sourcePath.match(/^education\[(\d+)\]\.(.+)$/);
    if (!match) continue;
    const record = records.get(match[1]) || { facts: {}, refs: [] };
    record.facts[match[2]] = entry.value;
    record.refs.push(entry.id);
    records.set(match[1], record);
  }
  return [...records.values()];
}

function compareEducation(atom, record) {
  const facts = record.facts;
  if (atom.educationLevels?.length) {
    const actualLevel = educationRank(facts.degree || facts.level);
    if (!actualLevel) return 'unknown';
    if (!atom.educationLevels.some(level => educationRank(level) === actualLevel)) return 'outside_scope';
  }
  if (atom.kind === 'education_level') {
    const actual = educationRank(facts.degree || facts.level);
    const required = educationRank(atom.value);
    if (!actual || !required || !['at_least', 'equals'].includes(atom.operator)) return 'unknown';
    return (atom.operator === 'equals' ? actual === required : actual >= required) ? 'satisfied' : 'conflict';
  }
  if (atom.kind === 'student_status') {
    const status = text(facts.status || facts.graduationStatus);
    if (/在校|在读|就读中|studying|enrolled/i.test(status)) return atom.value === 'in_school' ? 'satisfied' : 'conflict';
    if (/已毕业|已经毕业|completed|graduated/i.test(status)) return atom.value === 'in_school' ? 'conflict' : 'satisfied';
    return 'unknown';
  }
  const date = graduationDateWindow(facts.endDate || facts.end || facts.graduationYear);
  if (!date) return 'unknown';
  if (atom.operator === 'cohort') {
    const values = atom.value || [];
    return (atom.range ? date.year >= values[0] && date.year <= values[1] : values.includes(date.year)) ? 'satisfied' : 'conflict';
  }
  if (atom.operator !== 'within' || !Array.isArray(atom.value) || atom.value.length !== 2) return 'unknown';
  const boundary = (value, end) => typeof value === 'number' ? value : graduationDateWindow(value)?.[end ? 'maximum' : 'minimum'];
  const minimum = boundary(atom.value[0], false), maximum = boundary(atom.value[1], true);
  if (!minimum || !maximum || minimum > maximum) return 'unknown';
  if (date.maximum < minimum || date.minimum > maximum) return 'conflict';
  return date.minimum >= minimum && date.maximum <= maximum ? 'satisfied' : 'unknown';
}

function compareCredential(atom, evidence) {
  const records = new Map();
  for (const entry of evidence.entries || []) {
    const match = entry.sourceKind === 'profile_fact' && entry.sourcePath.match(/^credentials\[(\d+)\]\.(.+)$/);
    if (!match) continue;
    const record = records.get(match[1]) || { refs: [], facts: {} };
    record.facts[match[2]] = entry.value;
    record.refs.push(entry.id);
    records.set(match[1], record);
  }
  const found = [...records.values()].filter(record => compact(record.facts.name) === compact(atom.value));
  if (atom.operator !== 'has') return { state: 'unknown', refs: [] };
  const states = found.map(record => {
    const details = text(record.facts.details || record.facts.status);
    if (record.facts.held === false || /尚未|未取得|未获得|没有|无证|未通过|已过期/.test(details)) return 'conflict';
    if (record.facts.held === true || /已取得|已获得|持有|已通过|有效/.test(details)) return 'satisfied';
    return 'unknown';
  });
  const structuredState = combineAny(states);
  if (structuredState !== 'unknown') return { state: structuredState, refs: found.flatMap(record => record.refs) };
  const name = compact(atom.value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const negative = new RegExp(`(?:尚未|未曾|未|没有)(?:持有|取得|获得|通过)?${name}|${name}(?:尚未|未)(?:取得|获得|通过)`);
  const positive = new RegExp(`(?:已取得|已获得|持有|已通过)${name}|${name}(?:已取得|已获得|有效)`);
  const original = (evidence.entries || []).filter(entry => entry.sourceKind === 'resume');
  const negatives = original.filter(entry => negative.test(compact(entry.quote)));
  const positives = original.filter(entry => positive.test(compact(entry.quote).replace(negative, '')));
  return { state: negatives.length && positives.length ? 'unknown' : negatives.length ? 'conflict' : positives.length ? 'satisfied' : 'unknown',
    refs: [...negatives, ...positives].map(entry => entry.id) };
}

function assessBranch(branch, evidence) {
  const atoms = branch.allOf || [];
  const education = atoms.filter(atom => ['education_level', 'graduation_date', 'student_status'].includes(atom.kind));
  const states = [], refs = [];
  if (education.length) {
    const records = educationRecords(evidence).filter(record => !education.some(atom => compareEducation(atom, record) === 'outside_scope'));
    states.push(combineAny(records.map(record => combineAll(education.map(atom => compareEducation(atom, record))))));
    refs.push(...records.flatMap(record => record.refs));
  }
  for (const atom of atoms.filter(atom => !education.includes(atom))) {
    const result = atom.kind === 'credential' ? compareCredential(atom, evidence) : { state: 'unknown', refs: [] };
    states.push(result.state); refs.push(...result.refs);
  }
  return { state: combineAll(states), refs };
}

function assessJobConditions({ conditions = [], reportedResults = [], evidence = {}, selectedTrackId } = {}) {
  return conditions.map(condition => {
    const reported = reportedResults.find(row => (row.conditionId || row.id) === condition.id) || {};
    const reportedState = reported.reportedState || reported.state || 'unknown';
    const branches = condition.alternatives.map(branch => assessBranch(branch, evidence));
    const candidateEvidenceRefs = [...new Set(branches.flatMap(branch => branch.refs))];
    const localState = combineAny(branches.map(branch => branch.state));
    const allowed = condition.category === 'qualification' ? QUALIFICATION_STATES : CAPABILITY_STATES;
    const grounding = verifyJobMatchEvidence({ evidence, refs: reported.candidateEvidenceRefs || [], sourceKind: ['resume', 'profile_fact'] });
    const hasRefs = (reported.candidateEvidenceRefs || []).length > 0;
    const jdValid = condition.jdEvidenceRefs.length > 0 && verifyJobMatchEvidence({ evidence,
      refs: condition.jdEvidenceRefs, sourceKind: 'jd' }).valid;
    let state = 'unknown', basis = 'local_comparison';
    if (jdValid && condition.category === 'qualification' && localState !== 'unknown') state = localState;
    else if (jdValid && hasRefs && grounding.valid && allowed.has(reportedState)
      && (condition.category !== 'qualification' || condition.alternatives.some(branch => branch.allOf.some(atom => atom.kind === 'semantic')))) {
      state = reportedState; basis = 'grounded_model';
      candidateEvidenceRefs.push(...(reported.candidateEvidenceRefs || []));
    }
    if (!applies(condition, selectedTrackId)) state = 'not_required';
    return { conditionId: condition.id, category: condition.category, state, reportedState, basis,
      reasonCode: !jdValid ? 'jd_evidence_unverified' : state === 'unknown' ? 'qualification_information_unknown' : `condition_${state}`,
      candidateEvidenceRefs: [...new Set(candidateEvidenceRefs)], jdEvidenceRefs: condition.jdEvidenceRefs,
      adjustmentReason: state !== reportedState ? (!jdValid ? 'JD 来源尚未核实' : basis === 'local_comparison' ? '根据已知资料核对条件' : '引用来源尚未核实') : '' };
  });
}

function summarizeQualifications({ conditions = [], conditionResults = [], selectedTrackId } = {}) {
  const required = conditions.filter(condition => condition.category === 'qualification'
    && condition.strength === 'mandatory' && applies(condition, selectedTrackId));
  const stateFor = condition => conditionResults.find(row => row.conditionId === condition.id)?.state || 'unknown';
  const conflictIds = required.filter(condition => stateFor(condition) === 'conflict').map(condition => condition.id);
  const unresolvedIds = required.filter(condition => !['satisfied', 'conflict'].includes(stateFor(condition))).map(condition => condition.id);
  return { status: !required.length ? 'not_required' : conflictIds.length ? 'conflict' : unresolvedIds.length ? 'unknown' : 'satisfied',
    conflictIds, unresolvedIds };
}

function projectCapabilityRequirements({ conditions = [], conditionResults = [], selectedTrackId } = {}) {
  return conditions.filter(condition => condition.category !== 'qualification' && applies(condition, selectedTrackId)).map(condition => {
    const result = conditionResults.find(row => row.conditionId === condition.id) || {};
    return { id: condition.id, requirement: condition.label, group: condition.category === 'preference' ? 'bonus' : 'core',
      state: CAPABILITY_STATES.has(result.state) ? result.state : 'unknown', foundation: condition.foundation,
      central: condition.central, indispensable: condition.indispensable,
      jdEvidenceRefs: condition.jdEvidenceRefs, candidateEvidenceRefs: result.candidateEvidenceRefs || [] };
  });
}

module.exports = { normalizeJobConditions, assessJobConditions, summarizeQualifications, projectCapabilityRequirements };

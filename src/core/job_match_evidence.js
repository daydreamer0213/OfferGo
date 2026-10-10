const crypto = require('node:crypto');

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .filter(key => key !== 'generatedAt').map(key => [key, canonical(value[key])]));
  return value;
}

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function buildJobMatchEvidence({ candidateProfile = {}, jobFacts = {} } = {}) {
  const entries = [];
  function collect(value, sourcePath, sourceKind, sourceHash, prefix) {
    if (Array.isArray(value)) {
      value.forEach((item, index) => collect(item, `${sourcePath}[${index}]`, sourceKind, sourceHash, prefix));
    } else if (value && typeof value === 'object') {
      Object.keys(value).sort().filter(key => key !== 'generatedAt').forEach(key => collect(value[key],
        sourcePath ? `${sourcePath}.${key}` : key, sourceKind, sourceHash, prefix));
    } else if (value !== null && value !== undefined && String(value).trim()) {
      const quote = String(value).trim();
      const date = /(?:endDate|graduationYear|graduationDate|\.end)$/.test(sourcePath)
        ? quote.match(/^((?:19|20)\d{2})(?:\s*(?:年|[-/.])\s*(\d{1,2})(?:\s*(?:月|[-/.])\s*(\d{1,2}))?)?/) : null;
      entries.push({ id: `${prefix}-${hash([sourcePath, value]).slice(0, 16)}`, sourceKind, sourcePath,
        sourceHash, quote, value, precision: date
          ? (date[3] ? 'day' : date[2] ? 'month' : 'year') : 'exact' });
    }
  }
  const candidateHash = hash(candidateProfile);
  const resumeText = candidateProfile.source?.resumeEvidenceText || candidateProfile.source?.resumeText;
  if (resumeText) collect(resumeText, 'source.resumeEvidenceText', 'resume', hash(resumeText), 'S');
  const facts = { ...candidateProfile };
  delete facts.source;
  collect(facts, '', 'profile_fact', candidateHash, 'C');
  collect(jobFacts, '', 'jd', hash(jobFacts), 'J');
  return { entries };
}

function verifyJobMatchEvidence({ evidence = {}, refs = [], sourceKind, claim = '', state = '' } = {}) {
  const byId = new Map((evidence.entries || []).map(entry => [entry.id, entry]));
  const invalidIds = [];
  const mismatches = [];
  for (const ref of refs) {
    const id = typeof ref === 'string' ? ref : ref?.id;
    const entry = byId.get(id);
    const allowedSources = Array.isArray(sourceKind) ? sourceKind : sourceKind ? [sourceKind] : null;
    if (!entry || (allowedSources && !allowedSources.includes(entry.sourceKind))) invalidIds.push(id || '');
    else if (typeof ref === 'object' && ref.quote !== undefined
      && !entry.quote.normalize('NFKC').replace(/\s+/g, '').includes(String(ref.quote).normalize('NFKC').replace(/\s+/g, ''))) {
      mismatches.push({ id, quote: ref.quote });
    }
  }
  if (claim && !invalidIds.length && !mismatches.length && refs.length) {
    const referenced = [...new Set(refs.map(ref => typeof ref === 'string' ? ref : ref.id))].map(id => byId.get(id));
    const support = referenced.map(entry => entry.quote).join('；');
    const sourceAbsences = absenceAssertions(support);
    const unrecorded = [...String(claim).matchAll(/(?:未(?:记录|证明|体现|提及)|没有(?:记录|提及))([^，,；;。]{1,40})/g)]
      .map(match => match[1].replace(/\s/g, ''));
    if (state === 'missing' && ((!sourceAbsences.length
      && referenced.every(entry => /(?:avoidSaying\[\d+\]|roleBoundary)$/.test(entry.sourcePath)))
      || unrecorded.some(object => !sourceAbsences.some(source => source.includes(object) || object.includes(source))))) {
      mismatches.push({ claim, reason: 'unsupported_absence_from_expression_boundary' });
    }
    const rawResume = (evidence.entries || []).find(entry => entry.sourceKind === 'resume')?.quote;
    const normalizedClaim = String(claim).normalize('NFKC');
    const claimedAbsences = absenceAssertions(normalizedClaim);
    if (state === 'missing' && claimedAbsences.some(object =>
      !sourceAbsences.some(source => source.includes(object) || object.includes(source)))) {
      mismatches.push({ claim, reason: 'unsupported_explicit_absence' });
    }
    if (claimedAbsences.length && /不主张|未(?:独立负责|主导|负责)|不负责|没有独立/.test(support)
      && claimedAbsences.some(object => !sourceAbsences.some(source => source.includes(object)))) {
      mismatches.push({ claim, reason: 'unsupported_absence_from_ownership_limit' });
    }
    const productionClaim = /生产系统|生产环境|线上系统|正式环境/.test(normalizedClaim)
      && /负责|独立|承担|交付|设计|上线|部署|主导/.test(normalizedClaim)
      && !/未(?:负责|参与|接触)|没有|可迁移|可以迁移|尚未|未证明|不代表|待验证/.test(normalizedClaim);
    if (productionClaim && /(?:仅|只).{0,20}(?:本地|课程|练习)|未负责.{0,12}(?:生产|线上)|没有.{0,12}(?:生产|线上)/.test(`${support}；${rawResume || ''}`)
      && !/(?:负责|交付|部署|主导).{0,16}(?:生产系统|生产环境|线上系统)/.test(support.replace(/未负责.{0,16}(?:生产系统|生产环境|线上系统)/g, ''))) {
      mismatches.push({ claim, reason: 'unsupported_production_ownership' });
    }
    const credentialOwners = new Set(referenced.map(entry => entry.sourcePath.match(/^credentials\[\d+\]/)?.[0]).filter(Boolean));
    for (const owner of credentialOwners) {
      const facts = (evidence.entries || []).filter(entry => entry.sourcePath.startsWith(`${owner}.`));
      const name = facts.find(entry => entry.sourcePath.endsWith('.name'))?.quote;
      if (name && normalizedClaim.split(/[，,；;。]/).some(clause => clause.includes(name)
        && /已取得|已获得|已持有|持有/.test(clause) && !/未取得|未获得|未持有|没有|尚未/.test(clause))
        && /未取得|未获得|未持有|没有|尚未/.test(facts.map(entry => entry.quote).join('；'))) {
        mismatches.push({ claim, reason: 'unsupported_credential_possession', fact: name });
      }
    }
    const graduationClaim = normalizedClaim.match(/((?:19|20)\d{2})(?:年|届|[-/.]\d{1,2})?(?:[^。；;，,]{0,8})毕业/);
    const educationOwners = new Set(referenced.map(entry => entry.sourcePath.match(/^education\[\d+\]/)?.[0]).filter(Boolean));
    const dates = (evidence.entries || []).filter(entry => /(?:endDate|graduationYear|graduationDate|\.end)$/.test(entry.sourcePath)
      && (referenced.some(ref => ref.id === entry.id) || educationOwners.has(entry.sourcePath.replace(/\.[^.]+$/, ''))));
    if (graduationClaim && dates.length && !dates.some(entry => entry.quote.includes(graduationClaim[1]))) {
      mismatches.push({ claim, reason: 'unsupported_graduation_year' });
    }
    for (const degree of ['博士', '硕士', '本科', '大专', '专科']) {
      const positive = value => String(value).split(/[，,；;。]/).some(clause => clause.includes(degree)
        && !new RegExp(`(?:没有|未取得|未获得|非|不是).{0,8}${degree}|${degree}.{0,8}(?:未取得|未获得)`).test(clause));
      if (positive(normalizedClaim) && (!positive(support) || (rawResume && /学历|学位|教育|本科|硕士|博士/.test(rawResume) && !positive(rawResume)))) {
        mismatches.push({ claim, reason: 'unsupported_education', fact: degree });
      }
    }
    const duration = normalizedClaim.match(/(\d+(?:\.\d+)?|一|两|二|三|四|五|六|七|八|九|十)\s*(年|个月|月).{0,10}(?:经验|经历|实习|工作)/);
    const owners = new Set(referenced.map(entry => entry.sourcePath.match(/^(?:experience|experiences|projects)\[\d+\]/)?.[0]).filter(Boolean));
    const durationFacts = (evidence.entries || []).filter(entry => /durationMonths$/.test(entry.sourcePath)
      && (referenced.some(ref => ref.id === entry.id) || owners.has(entry.sourcePath.replace(/\.durationMonths$/, ''))));
    let months = durationFacts.reduce((sum, entry) => sum + Number(entry.value || 0), 0);
    const numbers = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    if (!months) for (const written of support.matchAll(/(\d+(?:\.\d+)?|一|两|二|三|四|五|六|七|八|九|十)\s*(年|个月|月).{0,10}(?:经验|经历|实习|工作)/g)) {
      months += Number(numbers[written[1]] || written[1]) * (written[2] === '年' ? 12 : 1);
    }
    if (duration && months > 0) {
      const amount = Number(numbers[duration[1]] || duration[1]) * (duration[2] === '年' ? 12 : 1);
      if (amount > months) mismatches.push({ claim, reason: 'inflated_duration', months, claimedMonths: amount });
    }
  }
  return { valid: !invalidIds.length && !mismatches.length,
    invalidIds: [...new Set(invalidIds)], mismatches };
}

function inferCandidateEvidenceRefs(evidence, claim) {
  const quote = String(claim || '').replace(/^简历[:：]\s*/, '').replace(/[。.]$/, '').normalize('NFKC').trim();
  if (!quote) return [];
  return (evidence.entries || []).filter(entry => ['resume', 'profile_fact'].includes(entry.sourceKind)
    && entry.quote.normalize('NFKC').includes(quote))
    .sort((left, right) => left.quote.length - right.quote.length || left.id.localeCompare(right.id))
    .slice(0, 8).map(entry => entry.id);
}

function absenceAssertions(value) {
  return String(value).split(/[，,；;。]/).filter(clause => !/不代表|不意味着|不能说明|不能据此|并非没有/.test(clause))
    .flatMap(clause => [...clause.matchAll(/(?:未(?:涉及|参与|接触|使用|做过|实现|掌握|从事)|没有|不具备)([^，,；;。]{1,40})/g),
      ...clause.matchAll(/(?:^|[:：]|候选人|本人|用户)无(?!法|关|序|监督|状态|线|人)([^，,；;。]{1,40})/g)]
      .flatMap(match => match[1].split(/或者|或/).map(object => object.replace(/(?:的)?(?:相关)?(?:经验|经历|实践)$/, '').replace(/\s/g, ''))));
}

module.exports = { buildJobMatchEvidence, verifyJobMatchEvidence, inferCandidateEvidenceRefs };

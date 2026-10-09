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

function verifyJobMatchEvidence({ evidence = {}, refs = [], sourceKind } = {}) {
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
  return { valid: !invalidIds.length && !mismatches.length,
    invalidIds: [...new Set(invalidIds)], mismatches };
}

module.exports = { buildJobMatchEvidence, verifyJobMatchEvidence };

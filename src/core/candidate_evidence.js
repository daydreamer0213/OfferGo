function materialText(item = {}) {
  return [item.subject, item.questionSummary, item.sourceQuote, item.text, item.finalAnswer || item.finalText].filter(Boolean).join('\n');
}

function terms(value) {
  const text = String(value || '').normalize('NFKC').toLowerCase();
  const result = new Set(text.match(/[a-z0-9][a-z0-9.+#_-]*/g) || []);
  for (const part of text.match(/[\p{Script=Han}]+/gu) || []) {
    for (let i = 0; i < part.length - 1; i++) result.add(part.slice(i, i + 2));
  }
  return result;
}

function inScope(item, job = {}, query = '') {
  if (item.withdrawnAt) return false;
  const scope = item.scope || { kind: 'global' };
  if (scope.kind === 'job') return [job.id, job.sourceId].some(id => id != null && String(id) === String(scope.key));
  if (scope.kind === 'company') return String(job.company || '').trim() === String(scope.key || '').trim();
  // An experience key names the story, not a recipient. Its text is ranked for relevance below.
  return ['global', 'experience'].includes(scope.kind);
}

function selectRelevantCandidateMaterial(items, { query = '', job = {}, limit = 12, maxChars = 8000 } = {}) {
  const queryTerms = terms(query);
  const overlap = text => [...terms(text)].filter(term => queryTerms.has(term)).length;
  const ranked = (Array.isArray(items) ? items : []).filter(item => inScope(item, job, query))
    .map((item, index) => ({ item, index, score: overlap(item.subject || item.questionSummary) * 3 + overlap(materialText(item)) }))
    .sort((a, b) => b.score - a.score || String(b.item.updatedAt || '').localeCompare(String(a.item.updatedAt || '')) || a.index - b.index);
  const selected = [];
  let remaining = maxChars;
  for (const { item } of ranked) {
    const length = materialText(item).length;
    if (selected.length >= limit) break;
    if (length > remaining) continue;
    selected.push(item);
    remaining -= length;
  }
  return selected;
}

module.exports = { selectRelevantCandidateMaterial, materialText };

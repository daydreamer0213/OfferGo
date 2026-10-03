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

// General capability questions often share no literal words with the story.
// Match concrete actions rather than giving weight to a list of capability names.
const capabilityConcepts = [
  { query: /难题|困难|问题|挑战|排障|故障|排查|解决/, evidence: [
    /复现|排查|排障|定位原因|定位问题|找出原因|分析原因/,
    /拆.{0,6}(步骤|任务)|分解|缩小.{0,6}范围|逐项/,
    /验证|试验|尝试|测试/,
    /总结经验|复盘/
  ] },
  { query: /合作|协作|配合|团队|沟通|协调|和.{0,8}(别人|同事|团队)|一起.{0,8}(事情|完成|工作|做好)/, evidence: [
    /协调|分工/,
    /沟通|同步进度|互相支持|配合|协作|合作/,
    /同事|伙伴|团队/
  ] },
  { query: /个人贡献|本人|你.{0,6}(负责|贡献|作用|做了)|具体.{0,6}(作用|贡献)|职责|分工/, evidence: [
    /我.{0,6}(负责|承担|完成|推动|主导|参与)/,
    /独立|亲自|具体负责|主要负责/
  ] },
  { query: /成效|成果|结果|产出|收益|影响|带来|达成|指标/, evidence: [
    /交付|完成|达成|实现/,
    /提高|提升|降低|减少|缩短|增长|节省/,
    /\d+.{0,6}(天|小时|分钟|%|个|倍)/
  ] },
  { query: /动机|为什么|为何|选择|离职|职业.{0,4}(方向|规划)|想.{0,6}(工作|加入)/, evidence: [
    /希望|想要|喜欢|兴趣/,
    /职业|长期|发展|学习|成长/,
    /因为|原因|出于/
  ] }
];

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
  const concepts = capabilityConcepts.filter(concept => concept.query.test(query));
  const conceptScore = text => concepts.reduce((score, concept) => score + concept.evidence.filter(pattern => pattern.test(text)).length * 4, 0);
  const ranked = (Array.isArray(items) ? items : []).filter(item => inScope(item, job, query))
    .map((item, index) => ({ item, index, score: overlap(item.subject || item.questionSummary) * 3 + overlap(materialText(item)) + conceptScore(materialText(item)) }))
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

const { selectRelevantCandidateMaterial } = require('./candidate_evidence');

const VOLATILE_FACT_MAX_AGE_DAYS = Object.freeze({
  employment_status: 7,
  availability_date: 7,
  interview_availability: 7,
  current_city: 30,
  expected_salary: 30,
  accepts_travel: 90,
  accepts_relocation: 90,
  accepts_overtime: 90
});

const STABLE_FACT_PREFIXES = Object.freeze([
  "gap.",
  "leaving_reason.",
  "short_project."
]);

function factStatus(now, fact = {}) {
  const key = String(fact.key || "").trim();
  const confirmedAt = String(fact.updatedAt || fact.confirmedAt || "").trim();
  if (!key) return { status: "invalid", confirmedAt };
  if (STABLE_FACT_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    return { status: "valid", confirmedAt };
  }
  const maxAgeDays = VOLATILE_FACT_MAX_AGE_DAYS[key];
  if (maxAgeDays === undefined) {
    return { status: fact.source === "user_provided" && Number.isFinite(Date.parse(confirmedAt))
      ? "valid" : "requires_confirmation", confirmedAt };
  }
  const confirmedMs = Date.parse(confirmedAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(confirmedMs)) return { status: "expired", maxAgeDays, confirmedAt };
  const ageDays = (Number.isFinite(nowMs) ? nowMs : Date.now()) - confirmedMs;
  const status = ageDays / 86_400_000 <= maxAgeDays ? "valid" : "expired";
  return { status, maxAgeDays, confirmedAt };
}

// Only explicit current statements become facts. The source remains the confirmed
// record, so edits and withdrawal take effect without creating stale copies.
function mergeCandidateFacts(facts = [], evidence = [], { job = {}, factRevisions = [] } = {}) {
  const applicable = selectRelevantCandidateMaterial(evidence, { job, limit: evidence.length, maxChars: Infinity });
  const projected = applicable.flatMap(entry => {
    const text = String(entry.text || '');
    const found = [];
    const add = (factKey, factValue) => found.push({ factKey, factValue, source: 'confirmed_evidence', updatedAt: entry.updatedAt || entry.createdAt || '' });
    let candidateSubject = true;
    for (const clause of text.split(/[，,。；;\n]/)) {
      if (/(?:同事|朋友|客户|招聘方|HR|别人|他们|她们|他|她)(?:目前|现在|已经|已|可以|仍|还)/i.test(clause)) candidateSubject = false;
      else if (/(?:我|本人)(?:目前|现在|已经|已|可以|仍|还)/.test(clause)) candidateSubject = true;
      if (!candidateSubject || /(?:如果|假如|可能|尚未确定|没有确定|还没确定)/.test(clause)) continue;
      if (/(?:去年|前年|当时|曾经|以前|之前|那时|过去|\d{4}年)/.test(clause)
        && !/(?:目前|现在|如今|当前)/.test(clause)) continue;
      if (/(?:已经|已)离职/.test(clause)) add('employment_status', '已离职');
      else if (/(?:目前|现在|仍然|仍|还)在职/.test(clause)) add('employment_status', '在职');
      const arrival = clause.match(/(下周[一二三四五六日天]?|两周后|一个月内|随时|\d{4}-\d{2}-\d{2}|\d{1,2}月\d{1,2}日)(?:就|即可|可以|可|能)?(?:到岗|入职)/);
      if (arrival && !/(?:如果|假如)/.test(text)) add('availability_date', arrival[1]);
      const city = clause.match(/(?:目前居住在|现居|常住(?:在)?|我目前在|目前在)([\p{Script=Han}]{2,6})$/u);
      if (city && !/(?:在职|离职|项目|团队|出差|旅游)/.test(city[1])) add('current_city', city[1].replace(/(?:工作|生活)$/, ''));
      const salary = clause.match(/(?:期望薪资|薪资期望|期望工资|期望薪酬)[为是:：\s]*([0-9]+(?:\.[0-9]+)?(?:\s*[-–~至到]\s*[0-9]+(?:\.[0-9]+)?)?\s*(?:[kK]|万|元)(?:\s*[-–~至到]\s*[0-9]+(?:\.[0-9]+)?\s*(?:[kK]|万|元))?)/);
      if (salary) add('expected_salary', salary[1].replace(/\s+/g, ''));
      for (const [key, pattern] of [
        ['accepts_travel', /不接受(?:短期)?出差|(?:可以)?接受短期出差/],
        ['accepts_relocation', /(?:不接受|接受)(?:异地(?:工作)?|搬迁)/],
        ['accepts_overtime', /不接受加班|(?:可以)?接受(?:偶尔|合理)?加班/],
        ['interview_availability', /下周[一二三四五六日天](?:上午|下午|晚上)?(?=.{0,3}(?:方便|可以).{0,3}(?:面试|视频沟通))/]
      ]) {
        const match = clause.match(pattern);
        if (match) add(key, match[0]);
      }
    }
    return found;
  });
  const byKey = new Map();
  for (const fact of [...projected, ...facts]) {
    const factKey = String(fact.factKey || fact.key || '');
    if (!factKey) continue;
    const normalized = { ...fact, factKey, factValue: fact.factValue ?? fact.value };
    const current = byKey.get(factKey);
    const at = Date.parse(fact.updatedAt || fact.confirmedAt || '') || 0;
    const previousAt = current ? Date.parse(current.updatedAt || current.confirmedAt || '') || 0 : -1;
    if (at >= previousAt) byKey.set(factKey, normalized);
  }
  const latestRevision = new Map();
  for (const revision of factRevisions.filter(item => !item.withdrawnAt)) {
    const at = Date.parse(revision.createdAt) || 0;
    const previous = latestRevision.get(revision.factKey);
    if (!previous || at > previous.at || (at === previous.at && revision.id > previous.revision.id)) latestRevision.set(revision.factKey, { at, revision });
  }
  for (const [key, { at, revision }] of latestRevision) {
    if (revision.operation === 'delete' && at >= (Date.parse(byKey.get(key)?.updatedAt || '') || 0)) byKey.delete(key);
  }
  return [...byKey.values()];
}

module.exports = {
  mergeCandidateFacts,
  VOLATILE_FACT_MAX_AGE_DAYS,
  STABLE_FACT_PREFIXES,
  factStatus
};

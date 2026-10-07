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

const TEMPORAL_DATE_PATTERN = /大后天|后天|明天|今天|昨日|昨天|(?:下周|本周|这周)(?:[一二三四五六日天末])?|周[一二三四五六日天末]|(?:\d+|一|两|二)天后|(?:\d+|一|两|二)周后|\d{4}-\d{1,2}-\d{1,2}|\d{4}年\d{1,2}月\d{1,2}日|\d{1,2}月\d{1,2}日/g;
const DATED_WINDOW_END = new RegExp(`(?:到|至)\\s*(?:${TEMPORAL_DATE_PATTERN.source})`);

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
  const temporal = temporalDateInfo(fact.value ?? fact.factValue, confirmedAt);
  if ((key === 'interview_availability' && !isOngoingInterviewAvailability(fact.value ?? fact.factValue)
      || (key === 'availability_date' && isLimitedAvailability(fact.value ?? fact.factValue)))
    && temporal.endDate && temporal.endDate < calendarDate(now || new Date().toISOString())) {
    return { status: 'requires_confirmation', maxAgeDays, confirmedAt, date: temporal.endDate };
  }
  const confirmedMs = Date.parse(confirmedAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(confirmedMs)) return { status: "expired", maxAgeDays, confirmedAt };
  const ageDays = (Number.isFinite(nowMs) ? nowMs : Date.now()) - confirmedMs;
  const status = ageDays / 86_400_000 <= maxAgeDays ? "valid" : "expired";
  return { status, maxAgeDays, confirmedAt };
}

// Resolve on a copy: stored words remain available for editing and audit. The
// confirmation date, never the generation date, anchors relative expressions.
function calendarDate(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms + 8 * 3600000).toISOString().slice(0,10) : '';
}

function temporalDateInfo(value, confirmedAt) {
  const raw = String(value || '');
  const anchor = calendarDate(confirmedAt);
  if (!anchor) return { text: raw, endDate: '' };
  const anchorMs = Date.parse(`${anchor}T00:00:00Z`);
  const day = offset => {
    const date = new Date(anchorMs + offset * 86400000);
    return Number.isFinite(date.getTime()) ? date.toISOString().slice(0,10) : '';
  };
  const weekday = (new Date(anchorMs).getUTCDay() + 6) % 7;
  const weekdayIndex = value => '一二三四五六日'.indexOf(value === '天' ? '日' : value);
  const dates = [];
  const normalized = raw.replace(TEMPORAL_DATE_PATTERN, (token, offset) => {
    let start, end;
    if (/^(?:\d+|一|两|二)(?:天|周)后$/.test(token)
      && /(?:录用(?:通知)?|通知|offer|签(?:完|好|订|署)?(?:了)?合同|合同签订|签约|交接|审批|体检|手续办完)(?:后|起)?的?$/i.test(raw.slice(0,offset).replace(/\s+/g,''))) return token;
    const offsets = { 大后天:3, 后天:2, 明天:1, 今天:0, 昨日:-1, 昨天:-1 };
    if (Object.hasOwn(offsets,token)) start=end=day(offsets[token]);
    else if (/周[一二三四五六日天末]?$/.test(token)) {
      const next = token.startsWith('下周');
      const bare = token.startsWith('周');
      const mondayOffset = -weekday + (next ? 7 : 0);
      const suffix = token.slice(-1);
      if (suffix === '周' || suffix === '末') {
        start=day(mondayOffset + (suffix === '末' ? 5 : 0)); end=day(mondayOffset+6);
      } else {
        let offset=mondayOffset+weekdayIndex(suffix);
        if (bare && offset < 0) offset += 7;
        start=end=day(offset);
      }
    } else if (/后$/.test(token)) {
      const number = token.match(/^(\d+|一|两|二)/)[1];
      start=end=day((/\d/.test(number) ? Number(number) : {一:1,两:2,二:2}[number]) * (token.includes('周') ? 7 : 1));
    } else {
      const parts = token.match(/\d+/g).map(Number);
      const [year,month,date] = parts.length === 3 ? parts : [Number(anchor.slice(0,4)),...parts];
      const ms = Date.UTC(year,month-1,date);
      const check = new Date(ms);
      if (check.getUTCFullYear()!==year || check.getUTCMonth()!==month-1 || check.getUTCDate()!==date) return token;
      start=end=check.toISOString().slice(0,10);
    }
    if (!start || !end) return token;
    dates.push(end);
    return start===end ? start : `${start}至${end}`;
  });
  return { text: normalized, endDate: dates.sort().at(-1) || '' };
}

function isLimitedAvailability(value) {
  const text = String(value || '');
  return /仅|只有|只在|只能|当天|当日|截至|截止|不晚于|最迟|之前|以前|前(?:到岗|入职)/.test(text)
    && !/(?:起|开始|之后|以后).{0,5}(?:到岗|入职)/.test(text);
}

function isOngoingInterviewAvailability(value) {
  const text = String(value || '');
  return /(?:开始|起).{0,8}(?:每天|每日|每周|都|一直|持续|均)/.test(text)
    && !/截至|截止|直到|只到|不晚于|最迟|之前|以前|仅限|只有|仅|当天|当日|为止/.test(text)
    && !DATED_WINDOW_END.test(text);
}

function isQualifiedAvailability(value) {
  const text = String(value || '');
  return /不能|无法|不可以|不可|不便|没法|尚未|还没|如果|假如|除非|前提|预计|计划|可能|大概|暂定|估计|未确定|没确定|不确定|有望|争取/.test(text)
    || /(?:录用(?:通知)?|通知|offer|合同|签约|交接|审批|体检|手续)(?:办完|办理完|完成|通过|签完|签好)?(?:之后|以后|后)/i.test(text)
    || /(?:录用(?:通知)?|通知|offer|签(?:完|好|订|署)?(?:了)?合同|合同签订|签约|交接|审批|体检|手续办完)(?:后|起)?\s*的?\s*(?:\d+|一|两|二)(?:天|周)后/i.test(text);
}

function currentFactValue(fact, now) {
  const key = fact.key || fact.factKey;
  const value = fact.value ?? fact.factValue;
  if (!['interview_availability','availability_date'].includes(key)) return value;
  const info = temporalDateInfo(value, fact.updatedAt || fact.confirmedAt);
  if (key === 'availability_date' && info.endDate && info.endDate < calendarDate(now)
    && !isLimitedAvailability(value)
    && !isQualifiedAvailability(value)) {
    return `现在可以到岗（原确认可到岗日期：${info.text}）`;
  }
  return info.text;
}

// Only explicit current statements become facts. The source remains the confirmed
// record, so edits and withdrawal take effect without creating stale copies.
function mergeCandidateFacts(facts = [], evidence = [], { job = {}, factRevisions = [] } = {}) {
  const applicable = selectRelevantCandidateMaterial(evidence, { job, limit: evidence.length, maxChars: Infinity });
  const projected = applicable.flatMap(entry => {
    const text = String(entry.text || '');
    const found = [];
    const add = (factKey, factValue) => found.push({ factKey, factValue, source: 'confirmed_evidence', updatedAt: entry.updatedAt || entry.createdAt || '' });
    for (const { text: clause, candidate, conditional, historical } of candidateClauses(text)) {
      if (!candidate || conditional || historical || /(?:可能|尚未确定|没有确定|还没确定)/.test(clause)) continue;
      if (historicalJoiningEvent(clause)) continue;
      if (/(?:尚未|没有|未|还没)(?:已经|已)?离职/.test(clause)) add('employment_status', '在职');
      else if (/(?:已经|已)离职/.test(clause)) add('employment_status', '已离职');
      else if (/(?:我|目前|现在|仍然|仍|还)在职/.test(clause)) add('employment_status', '在职');
      const arrival = clause.match(/(下周[一二三四五六日天]?|两周后|一个月内|随时|\d{4}-\d{2}-\d{2}|\d{1,2}月\d{1,2}日)(?:就|即可|可以|可|能|不能|无法|不可以|不可|不便|没法)?(?:到岗|入职)/);
      if (arrival) add('availability_date', isQualifiedAvailability(clause) ? clause.trim() : arrival[1]);
      const city = clause.match(/(?:目前居住在|现居|常住(?:在)?|我目前在|目前在)([\p{Script=Han}]{2,6})$/u);
      if (city && !/(?:在职|离职|项目|团队|出差|旅游)/.test(city[1])) add('current_city', city[1].replace(/(?:工作|生活)$/, ''));
      const salary = clause.match(/(?:期望薪资|薪资期望|期望工资|期望薪酬)[为是:：\s]*([0-9]+(?:\.[0-9]+)?(?:\s*[-–~至到]\s*[0-9]+(?:\.[0-9]+)?)?\s*(?:[kK]|万|元)(?:\s*[-–~至到]\s*[0-9]+(?:\.[0-9]+)?\s*(?:[kK]|万|元))?)/);
      if (salary) add('expected_salary', salary[1].replace(/\s+/g, ''));
      for (const [key, pattern] of [
        ['accepts_travel', /(?:不能|无法|不可以|不愿意)(?:接受)?(?:短期|长期)?出差|不接受(?:短期|长期)?出差|(?:可以)?接受(?:短期|长期)?出差/],
        ['accepts_relocation', /(?:不能|无法|不可以|不愿意)(?:接受)?(?:异地(?:工作)?|搬迁)|(?:不接受|接受)(?:异地(?:工作)?|搬迁)/],
        ['accepts_overtime', /(?:不能|无法|不可以|不愿意)(?:接受)?(?:偶尔|合理)?加班|不接受加班|(?:可以)?接受(?:偶尔|合理)?加班/],
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

function candidateClauses(text) {
  let candidate = true;
  let conditional = false;
  let historical = false;
  let reset = false;
  return String(text || '').split(/(?<=[。；;\n])|[，,]|(?:并且|而且|同时|但是|但|并)(?=(?:我)?(?:目前|现在|下周|期望|可以|已|仍))/).map(part => {
    if (reset) { candidate = true; conditional = false; historical = false; }
    reset = /[。；;\n]$/.test(part);
    const clause = part.replace(/[。；;\n]+$/g, '').trim();
    if (/(?:我(?:的)?(?:同事|朋友)|^(?:同事|朋友|客户|招聘方|HR|别人|他们|她们|他|她))/i.test(clause)) candidate = false;
    else if (/^(?:但|而|不过)?(?:我|本人)(?!的?(?:同事|朋友))/.test(clause)) candidate = true;
    if (/(?:如果|假如|除非|前提是)/.test(clause)) conditional = true;
    if (/(?:目前|现在|如今|当前)/.test(clause)) historical = false;
    else if (/(?:去年|前年|当时|曾经|以前|之前|那时|过去|\d{4}年)/.test(clause)) historical = true;
    return { text: clause, candidate, conditional, historical };
  }).filter(clause => clause.text);
}

function historicalJoiningEvent(clause, now = new Date().toISOString()) {
  // A past dated employer event is work history, not an available joining date.
  if (/可以|能够|计划|预计|准备|目前|现在|当前|如今|仍在职|到岗|无法|不能/.test(clause)) return false;
  const event = clause.match(/(\d{4})[-年](\d{1,2})[-月](\d{1,2})日?(?:已)?入职(?:了)?[^，。；;\n]{0,30}(?:公司|企业|团队|岗位)/);
  return Boolean(event && Date.UTC(Number(event[1]), Number(event[2]) - 1, Number(event[3])) < Date.parse(now));
}

// Reuse confirmed stories, but do not reuse expired logistics hidden inside a
// project answer. This operates on copies, including quotes used for retrieval.
function currentCandidateMaterial(items = [], { now = new Date().toISOString(), facts = [], factRevisions = [] } = {}) {
  const latest = new Map(facts.map(fact => [fact.factKey || fact.key, fact]));
  const deleted = new Map();
  for (const revision of factRevisions.filter(item => !item.withdrawnAt && item.operation === 'delete')) {
    const at = Date.parse(revision.createdAt) || 0;
    if (at >= (deleted.get(revision.factKey) || 0)) deleted.set(revision.factKey, at);
  }
  const result = [];
  for (const item of items) {
    if (item.withdrawnAt) continue;
    // Memory updatedAt can merely record a scope change; createdAt is the answer date.
    const at = item.source === 'user_edited_reply' ? item.createdAt || item.updatedAt : item.updatedAt || item.createdAt;
    const clean = value => {
      const currentValue = item.source === 'user_edited_reply'
        ? applySourceEvidenceUpdates(value, item.sourceEvidenceUpdates) : String(value || '');
      const clauses = candidateClauses(currentValue);
      const retained = clauses.filter(({ text: clause, candidate, conditional, historical }) => {
        const keys = volatileClauseKeys(clause);
        if (!keys.length) return true;
        if (historicalJoiningEvent(clause, now)) return true;
        // The active resume has no fact confirmation date. Preserve its content
        // unless an explicit current fact or deletion overrides this statement.
        if (item.source === 'active_resume') {
          if (!candidate || conditional || historical) return true;
          const projected = mergeCandidateFacts([], [{ text: clause }]);
          return keys.every(key => {
            if (deleted.has(key)) return false;
            const replacement = latest.get(key);
            if (!replacement || factStatus(now, { ...replacement, key }).status !== 'valid') return true;
            const statement = projected.find(fact => fact.factKey === key);
            return !statement || String(statement.factValue) === String(replacement.factValue ?? replacement.value);
          });
        }
        if (!candidate || conditional || historical || /(?:可能|尚未确定|没有确定|还没确定)/.test(clause)) return false;
        return keys.every(key => {
          if (factStatus(now, { key, value: clause, updatedAt: at }).status !== 'valid') return false;
          const sourceAt = Date.parse(at) || 0;
          if ((deleted.get(key) ?? -1) >= sourceAt) return false;
          const replacement = latest.get(key);
          if (!replacement) return true;
          const replacementAt = Date.parse(replacement.updatedAt || replacement.confirmedAt) || 0;
          if (replacementAt !== sourceAt) return replacementAt < sourceAt;
          // Same-timestamp manual corrections win in mergeCandidateFacts too.
          const projected = mergeCandidateFacts([], [{ text: clause, updatedAt: at }]).find(fact => fact.factKey === key);
          return !projected || String(projected.factValue) === String(replacement.factValue ?? replacement.value);
        });
      });
      const normalized = retained.map(clause => ({...clause, text: volatileClauseKeys(clause.text).length
        && !clause.historical && !historicalJoiningEvent(clause.text, now)
        ? temporalDateInfo(clause.text, at).text : clause.text}));
      return retained.length === clauses.length && normalized.every((clause,index)=>clause.text===clauses[index].text)
        ? currentValue : normalized.map(clause => clause.text).join('，');
    };
    const copy = { ...item };
    for (const field of ['text', 'sourceQuote', 'finalAnswer', 'finalText', 'subject', 'questionSummary']) {
      if (typeof copy[field] === 'string') copy[field] = clean(copy[field]);
    }
    delete copy.sourceEvidenceUpdates;
    if (item.source === 'user_edited_reply') {
      delete copy.originalText;
      delete copy.changedText;
    }
    if (item.sourceKind === 'manual' && item.text !== item.sourceQuote) delete copy.sourceQuote;
    if (String(copy.text || copy.finalAnswer || copy.finalText || '').replace(/[，,。；;\s]/g, '')) result.push(copy);
  }
  return result;
}

function applySourceEvidenceUpdates(value, updates = []) {
  let result = String(value || '');
  for (const update of Array.isArray(updates) ? updates : []) {
    const quote = String(update.sourceQuote || '').trim();
    if (!quote) continue;
    const replacement = update.withdrawnAt ? '' : String(update.text || '');
    if (result.includes(quote)) {
      result = result.split(quote).join(replacement);
      continue;
    }
    // Only formatting-equivalent complete source spans may map. Do not replace
    // isolated numbers or infer that similar stories describe the same event.
    const characters = [...quote.normalize('NFKC').replace(/[\s，,。.;；:：！？!?“”"'‘’（）()\[\]【】]/g, '')];
    if (characters.length < 8) continue;
    const separator = '[\\s，,。.;；:：！？!?“”"\'‘’（）()\\[\\]【】]*';
    const pattern = new RegExp(characters.map(character => character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(separator)
      + (/[。.;；]$/.test(quote) ? separator : ''), 'g');
    let normalized = '';
    const boundaries = new Map([[0, 0]]);
    for (const { segment, index } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(result)) {
      normalized += segment.normalize('NFKC');
      boundaries.set(normalized.length, index + segment.length);
    }
    for (const match of [...normalized.matchAll(pattern)].reverse()) {
      const start = boundaries.get(match.index), end = boundaries.get(match.index + match[0].length);
      if (start !== undefined && end !== undefined) result = result.slice(0, start) + replacement + result.slice(end);
    }
  }
  return result;
}

function volatileClauseKeys(clause) {
  const keys = [];
  if (/(?:我|目前|现在|当前|仍|还)(?:已经|已)?(?:在职|离职)|(?:已经|已|尚未|没有|还没|未)离职/.test(clause)) keys.push('employment_status');
  if (/到岗|入职时间|(?:本周|下周|这周|今天|明天|后天|周[一二三四五六日天]|随时|立即|一周内|两周后|两周内|一个月内|\d+天后|\d+周后|\d{4}-\d{2}-\d{2}|\d{1,2}月\d{1,2}日).{0,8}入职/.test(clause)) keys.push('availability_date');
  if (/(?:本周|下周|今天|明天|后天|周[一二三四五六日天]|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}月\d{1,2}日).*(?:面试|视频沟通)/.test(clause)) keys.push('interview_availability');
  if (/期望(?:薪资|工资|薪酬)|薪资期望/.test(clause)) keys.push('expected_salary');
  if (/目前居住|现居|常住|我目前在/.test(clause)) keys.push('current_city');
  if (/接受|不能|无法|不可以|不考虑|愿意/.test(clause)) {
    if (/出差/.test(clause)) keys.push('accepts_travel');
    if (/异地|搬迁/.test(clause)) keys.push('accepts_relocation');
    if (/加班/.test(clause)) keys.push('accepts_overtime');
  }
  return keys;
}

module.exports = {
  mergeCandidateFacts,
  currentCandidateMaterial,
  applySourceEvidenceUpdates,
  currentFactValue,
  VOLATILE_FACT_MAX_AGE_DAYS,
  STABLE_FACT_PREFIXES,
  factStatus
};

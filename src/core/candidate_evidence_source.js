// Preserve explicit source qualifications, rather than trying to verify ordinary self-reported facts.
const FICTION = /(?:下面|以下|这里|这段)(?:的回答)?(?:是|只是|仅是)[^。！？!?；;\n]{0,16}(?:练习示范|示范答案|假设方案|虚构案例)[^。！？!?；;\n]{0,20}(?:不是|并非)(?:我的?|自己的?)?(?:实际|真实)?经历|把(?:练习示范|示范答案|假设方案).{0,8}(?:改成|当成|说成)(?:了)?(?:自己的|我的|自己|我)经历|(?:我|这段).{0,6}(?:编造|杜撰|捏造).{0,8}(?:经历|履历|业绩)/g;
const FICTION_TAIL = /(?:以上|前面|这段|刚才).{0,8}(?:只是|仅是|都是).{0,8}(?:练习示范|示范答案|虚构|编造)/g;
const INVENTED_NUMBERS = /编(?:了|造(?:了|的)?)[^，,。！？!?；;\n]{0,30}(?:数字|百分比|指标)|(?:数字|百分比|指标).{0,4}(?:是)?(?:我)?编(?:的|造的)/g;
const ACTUAL_RESET = /实际发生的是|真实经历是|(?:但|而)(?:我)?(?:实际|确实)|我实际(?:做过|参与|完成)/;
const ACTUAL_ACTION = /(?:去年|之前|以前|当时|上次|那次).{0,12}(?:我|我们)|(?:我|我们)[^，,。！？!?；;\n]*?(?:做过|参与过|完成过|负责过|练习过)|(?:我|我们)(?:曾经|之前|目前|现在)?(?:正在|已经|曾|参与|负责|完成|整理了|比较了|学习|练习|准备|在学|在练|在准备)/;
const METHOD = /^\s*(?:(?:如果|假如|若|假设|设想).{0,40}(?:我会|我将|先|再)|我(?:会|将)(?:先|从|按|把|整理|确认|调整))/;

function affirmativeMatches(pattern, value) {
  return [...value.matchAll(pattern)].filter(match => !/(?:不是|并非|没有|不曾|不要|避免|并未|未曾)(?:我|我们)?\s*$/.test(value.slice(Math.max(0, match.index - 10), match.index))
    && !/(?:不是|并非|没有|不曾).{0,3}(?:编|杜撰|捏造)/.test(match[0]));
}

function sourceRanges(question, answer) {
  const ranges = [];
  const scenario = /(?:^|[。？！!?])\s*(?:请\s*)?(?:假设|假如|如果|设想)/.test(question);
  let frame = 'fact';
  let firstClause = true;
  let lastFictionStart = 0;
  for (const sentence of answer.matchAll(/[^。！？!?；;\n]+[。！？!?；;\n]*/g)) {
    const fiction = affirmativeMatches(FICTION, sentence[0]);
    const tails = affirmativeMatches(FICTION_TAIL, sentence[0]);
    const numbers = affirmativeMatches(INVENTED_NUMBERS, sentence[0]);
    for (const declaration of numbers) {
      ranges.push({ start: sentence.index + declaration.index, end: sentence.index + declaration.index + declaration[0].length, kind: 'fiction' });
      const rest = sentence[0].slice(declaration.index);
      const actual = rest.search(ACTUAL_RESET);
      for (const number of rest.slice(0, actual < 0 ? rest.length : actual).matchAll(/\d+(?:\.\d+)?\s*[%％]?/g)) {
        const start = sentence.index + declaration.index + number.index;
        ranges.push({ start, end: start + number[0].length, kind: 'fiction' });
      }
    }
    for (const clause of sentence[0].matchAll(/[^，,]+[，,]*/g)) {
      const start = sentence.index + clause.index;
      const end = start + clause[0].length;
      if (/^\s*(?:下面|以下|接下来|这里).{0,8}(?:举|模拟|看).{0,16}(?:案例|例子)|^\s*(?:以|用).{0,20}为例/.test(clause[0])) lastFictionStart = start;
      if (firstClause && scenario && /^\s*(?:先(?!说|介绍)|首先(?!说|介绍)|第一步|以.{0,20}为例)/.test(clause[0])) frame = 'method';
      firstClause = false;
      const declaration = fiction.find(match => sentence.index + match.index >= start && sentence.index + match.index < end);
      if (declaration) {
        frame = 'fiction';
        lastFictionStart = start;
      } else if (ACTUAL_RESET.test(clause[0]) || (frame !== 'fiction' && ACTUAL_ACTION.test(clause[0]) && !METHOD.test(clause[0]))) {
        frame = 'fact';
      } else if (frame !== 'fiction' && METHOD.test(clause[0])) {
        frame = 'method';
      }
      ranges.push({ start, end, kind: frame });
    }
    for (const tail of tails) {
      // A trailing declaration qualifies its example, including a quote that omits the declaration.
      const end = sentence.index + tail.index + tail[0].length;
      ranges.push({ start: lastFictionStart, end, kind: 'fiction' });
      frame = 'fiction';
    }
  }
  return ranges;
}

function classifyEvidenceSource({ question = '', answer = '', quote = answer } = {}) {
  const source = String(answer || '');
  const selected = String(quote || '').trim();
  if (!selected) return 'invalid';
  const ranges = sourceRanges(String(question || ''), source);
  const kinds = [];
  for (let start = source.indexOf(selected); start !== -1; start = source.indexOf(selected, start + 1)) {
    const overlaps = ranges.filter(range => range.start < start + selected.length && range.end > start);
    kinds.push(overlaps.some(range => range.kind === 'fiction') ? 'fiction'
      : overlaps.some(range => range.kind === 'method') ? 'method' : 'fact');
  }
  if (!kinds.length) return 'invalid';
  return new Set(kinds).size > 1 ? 'ambiguous' : kinds[0];
}

module.exports = { classifyEvidenceSource };

const INTERVIEW_TYPES = new Set(["general", "technical", "behavioral", "mixed"]);
const INTERVIEW_DIFFICULTIES = new Set(["warmup", "standard", "challenging"]);

function cleanText(value, maxLength, label, { required = true } = {}) {
  const text = String(value ?? "").trim();
  if (required && !text) throw new Error(`${label}不能为空`);
  if (text.length > maxLength) throw new Error(`${label}过长`);
  return text;
}

function boundedTextArray(value, label, { maxItems = 6, itemLength = 1_000 } = {}) {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label}格式无效`);
  return value.map((item) => cleanText(item, itemLength, label));
}

function buildResumeInterviewEvidenceCatalog(sourceText) {
  const lines = String(sourceText ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error("简历证据不能为空");
  return lines.map((text, index) => ({ id: `R${index + 1}`, kind: "resume", text }));
}

function projectInterviewFacts({ factRevisions = [], answerMemories = [], allowedScopeKinds = [], includeTimestamps = false } = {}) {
  const allowedScopes = new Set(allowedScopeKinds.map((kind) => String(kind || "").trim()).filter(Boolean));
  const memoriesById = new Map((Array.isArray(answerMemories) ? answerMemories : [])
    .filter((memory) => memory && !memory.withdrawnAt)
    .map((memory) => [Number(memory.id), memory]));
  const newestByKey = new Map();

  for (const revision of Array.isArray(factRevisions) ? factRevisions : []) {
    if (!revision || revision.withdrawnAt) continue;
    const factKey = String(revision.factKey || "").trim();
    if (!factKey) continue;
    const memoryId = Number(revision.answerMemoryId || 0);
    const memory = memoryId ? memoriesById.get(memoryId) : null;
    if (memoryId && (!memory || !allowedScopes.has(String(memory.scope?.kind || "")))) continue;
    const rankedAt = Date.parse(memory ? memory.updatedAt : revision.createdAt);
    const rank = Number.isFinite(rankedAt) ? rankedAt : 0;
    const id = Number(revision.id || 0);
    const current = newestByKey.get(factKey);
    if (!current || rank > current.rank || (rank === current.rank && id > current.id)) {
      newestByKey.set(factKey, { revision, rank, id });
    }
  }

  return [...newestByKey.entries()]
    .filter(([, selected]) => selected.revision.operation !== "delete")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([factKey, selected]) => ({
      factKey,
      factValue: String(selected.revision.factValue ?? ""),
      source: String(selected.revision.source || ""),
      ...(includeTimestamps ? { updatedAt: new Date(selected.rank).toISOString() } : {})
    }));
}

function normalizeInterviewSettings(input = {}) {
  const type = cleanText(input.type || "mixed", 30, "面试类型");
  if (!INTERVIEW_TYPES.has(type)) throw new Error(`不支持的面试类型：${type}`);
  const difficulty = cleanText(input.difficulty || "standard", 30, "面试难度");
  if (!INTERVIEW_DIFFICULTIES.has(difficulty)) throw new Error(`不支持的面试难度：${difficulty}`);
  const plannedQuestions = Number(input.plannedQuestions ?? 6);
  if (!Number.isInteger(plannedQuestions) || plannedQuestions < 3 || plannedQuestions > 12) {
    throw new Error("计划题数必须为 3-12");
  }
  return { type, difficulty, plannedQuestions };
}

function turnNumberSet(turns) {
  return new Set((Array.isArray(turns) ? turns : []).map((turn) => Number(turn.turnNumber))
    .filter((value) => Number.isInteger(value) && value > 0));
}

function normalizeTurnNumbers(value, validTurns, label) {
  if (!Array.isArray(value) || value.length > 12) throw new Error(`${label}题号格式无效`);
  const numbers = [...new Set(value.map(Number))];
  for (const turnNumber of numbers) {
    if (!Number.isInteger(turnNumber) || !validTurns.has(turnNumber)) {
      throw new Error(`${label}引用了不存在的题号：${turnNumber}`);
    }
  }
  return numbers;
}

function normalizeAnswerReview(value, validTurns) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("回答复盘格式无效");
  return {
    conclusion: cleanText(value.conclusion, 2_000, "回答结论"),
    strengths: boundedTextArray(typeof value.strengths === 'string' && value.strengths.trim() ? [value.strengths] : value.strengths, "回答优点"),
    improvements: boundedTextArray(typeof value.improvements === 'string' && value.improvements.trim() ? [value.improvements] : value.improvements, "回答改进点"),
    turnNumbers: normalizeTurnNumbers(value.turnNumbers, validTurns, "回答复盘")
  };
}

function normalizeQuestion(value, evidenceById) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("下一题格式无效");
  const basedOn = value.basedOnTurnNumber;
  const resumeEvidenceIds = [...new Set((Array.isArray(value.resumeEvidenceIds) ? value.resumeEvidenceIds : [])
    .map((item) => String(item || "").trim()).filter(Boolean))];
  if (resumeEvidenceIds.length < 1 || resumeEvidenceIds.length > 4) throw new Error("问题必须引用 1-4 条简历证据");
  for (const evidenceId of resumeEvidenceIds) {
    if (!evidenceById.has(evidenceId)) throw new Error(`问题引用了不存在的简历证据：${evidenceId}`);
  }
  const text = cleanText(value.text, 4_000, "问题");
  return {
    ...(value.questionKind ? { questionKind: cleanText(value.questionKind, 30, "题目类型") } : {}),
    text,
    focus: cleanText(value.focus, 120, "问题重点"),
    resumeEvidenceIds,
    basedOnTurnNumber: basedOn === null || basedOn === undefined || basedOn === ""
      ? null
      : Number(basedOn),
    answerEvidence: cleanText(value.answerEvidence, 300, "回答片段", { required: false })
  };
}

function assertQuestionResponsibilityBoundary(question, citedEvidence, context) {
  const ownership = /你(?:主要)?(负责|主导|牵头|独立完成|独立负责|全权负责)的([^，,。？！?！；;]+)/.exec(question.text);
  if (!ownership) return;
  const duty = ownership[2].split(/有哪些|有什么|有何|如何|怎么|怎样|中|时/)[0].replace(/(?:工作|项目)$/, '').trim();
  const supports = text => String(text || '').split(/[，,。；;！？!?\n]/).some(clause => {
    if (/(?:没有|没|未|不|并非|不是|无需|不曾).{0,8}(?:负责|主导|牵头|独立完成)|(?:同事|别人|他人|团队|主管).{0,6}(?:负责|主导|牵头)|(?:如果|假如|设想|希望|计划|将来)/.test(clause)) return false;
    const at = clause.indexOf(ownership[1]);
    return at >= 0 && duty.length >= 2 && clause.slice(at + ownership[1].length).includes(duty);
  });
  const linked = item => question.resumeEvidenceIds.some(id => (item.resumeEvidenceIds || []).includes(id));
  const supplemental = (context.candidateEvidence || []).filter(item => linked(item) && !item.withdrawnAt);
  const latest = context.turns?.at(-1);
  const answer = question.basedOnTurnNumber === Number(latest?.turnNumber)
    && latest?.answer?.includes(question.answerEvidence) && linked(latest) ? latest.answer : '';
  if (![...citedEvidence, ...supplemental].some(item => supports(item.text)) && !supports(answer)) {
    throw Object.assign(new Error("问题不能超出简历证据中的职责边界"), { code: 'MOCK_INTERVIEW_RESPONSIBILITY_BOUNDARY' });
  }
}

function normalizedQuestion(text) {
  return String(text || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu, '')
    .replace(/^(?:(?:请问|请|你能否|你可以|能否))+/, '')
    .replace(/(?:说说|讲讲|介绍|描述|说明)(?:一下)?/g, '说明')
    .replace(/怎样|如何/g, '怎么').replace(/难点/g, '难题');
}

function assertTrainingQuestion(text, turns, answerEvidence = '') {
  const normalized = normalizedQuestion(text);
  if (turns.some(turn => normalizedQuestion(turn.question || turn.questionText) === normalized)) {
    throw Object.assign(new Error('下一题重复了已问问题，请换成新的能力考察问题'), { code: 'MOCK_INTERVIEW_REPEATED_QUESTION' });
  }
  // A project preface alone is not training. Preserve mixed questions that actually ask about capability or motivation.
  // A validated quotation of the user's answer is context, not a new HR request.
  const requestText = answerEvidence ? text.replace(`“${answerEvidence}”`, '').replace(`"${answerEvidence}"`, '') : text;
  const clauses = requestText.split(/[，,。.!！?？;；]/).filter(Boolean);
  const logistics = clause => /(?:到岗|入职|上岗|来上班|开始工作|报到).*(?:时间|日期|多久|何时|什么时候|几天)|(?:何时|什么时候|多久|几天|哪天|几号|是否|能否|可以|能).*?(?:到岗|入职|上岗|来上班|开始工作|报到)/.test(clause)
    || /(?:期望|预期|期待|希望|要求|接受多少).*?(?:薪资|薪酬|工资|待遇)|(?:薪资|薪酬|工资|待遇).*?(?:期望|预期|期待|要求|多少|范围)/.test(clause)
    || /在职还是|是否.*离职|(?:目前|现在|当前).*?(?:在职|离职|就业状态|工作状态)|(?:在职|离职).*?(?:了吗|了么|吗|么)/.test(clause)
    || /(?:在哪|哪个|哪些|意向|期望|希望|接受).*?(?:城市|工作地点)|(?:是否|能否|可以|能|接受).*?出差|出差.*?(?:频率|接受|吗)/.test(clause)
    || /面试.*?(?:时间|日期|安排|方便)|(?:何时|什么时候|几点|哪天|是否|能否|可以|方便).*?(?:参加面试|安排面试)/.test(clause);
  const substantiveClauses = clauses.filter(clause => {
    if (/为什么|为何|原因|动机/.test(clause)
      && !/到岗|入职|薪资|薪酬|工资|待遇|出差|面试安排/.test(clause)) return true;
    return /请(?:介绍|说明|描述)|(?:继续)?说明|说说|讲讲|如何|怎么|怎样|哪些|什么(?:技术|难题|问题|工作|贡献|结果|成果|经历|取舍)/.test(clause)
      && /技术|设计|实现|取舍|排障|难题|解决|复盘|项目|贡献|个人行动|协作|成果/.test(clause);
  });
  const logisticsCount = clauses.filter(clause => logistics(clause) && !substantiveClauses.includes(clause)).length;
  if ((!substantiveClauses.length && logisticsCount) || (logisticsCount >= 2 && logisticsCount > substantiveClauses.length)) {
    throw Object.assign(new Error('日常条件和安排确认不能充当面试训练题'), { code: 'MOCK_INTERVIEW_LOGISTICS_QUESTION' });
  }
}

function validateInterviewStep(raw, context = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("面试步骤格式无效");
  const turns = Array.isArray(context.turns) ? context.turns : [];
  const resumeEvidenceCatalog = Array.isArray(context.resumeEvidenceCatalog) ? context.resumeEvidenceCatalog : [];
  const evidenceById = new Map(resumeEvidenceCatalog.map((item) => [String(item?.id || "").trim(), item]));
  if (turns.length === 0 && raw.answerReview != null) throw new Error("首题不能包含回答复盘");
  const validTurns = turnNumberSet(turns);
  const complete = raw.complete === true;
  const answerReview = raw.answerReview == null ? null : normalizeAnswerReview(raw.answerReview, validTurns);
  const nextQuestion = raw.nextQuestion == null ? null : normalizeQuestion(raw.nextQuestion, evidenceById);

  if (turns.length > 0 && !answerReview) throw Object.assign(new Error("回答后必须先生成复盘"), { code: 'MOCK_INTERVIEW_ANSWER_REVIEW_REQUIRED' });
  if (turns.length > 0) {
    const latestTurnNumber = Number(turns[turns.length - 1].turnNumber);
    if (!answerReview.turnNumbers.includes(latestTurnNumber)) {
      throw new Error("回答复盘必须引用刚回答的上一题");
    }
  }
  if (complete && nextQuestion) throw new Error("面试结束时不能同时生成下一题");
  if (!complete && !nextQuestion) throw new Error("未结束时必须生成下一题");

  if (nextQuestion) {
    if (turns.length === 0 && nextQuestion.basedOnTurnNumber !== null) {
      throw new Error("首题不能引用上一题");
    }
    if (turns.length === 0 && nextQuestion.answerEvidence) {
      throw new Error("首题不能包含上一回答片段");
    }
    if (nextQuestion.questionKind && !["follow_up", "topic_transition"].includes(nextQuestion.questionKind)) {
      throw Object.assign(new Error("题目类型无效：questionKind 只能为 follow_up 或 topic_transition，不能使用面试风格"),
        { code: 'MOCK_INTERVIEW_QUESTION_KIND_INVALID' });
    }
    const transition = nextQuestion.questionKind === "topic_transition" && context.interviewBrief;
    if (transition && (nextQuestion.basedOnTurnNumber !== null || nextQuestion.answerEvidence)) {
      throw new Error("转换主题不能伪造上一回答引用");
    }
    if (turns.length > 0 && !transition) {
      const previousTurnNumber = Number(turns[turns.length - 1].turnNumber);
      if (nextQuestion.basedOnTurnNumber !== previousTurnNumber) {
        throw new Error("追问必须引用上一题回答");
      }
      const previousAnswer = String(turns[turns.length - 1].answer || "");
      if (!nextQuestion.answerEvidence
        || !previousAnswer.includes(nextQuestion.answerEvidence)
        || (!context.interviewBrief && !nextQuestion.text.includes(nextQuestion.answerEvidence))) {
        throw new Error("追问必须用上一题回答中的真实回答片段承接");
      }
    }
    assertQuestionResponsibilityBoundary(nextQuestion, nextQuestion.resumeEvidenceIds.map(id => evidenceById.get(id)), context);
    assertTrainingQuestion(nextQuestion.text, turns, nextQuestion.answerEvidence);
  }

  return { answerReview, nextQuestion, complete };
}

function rejectProbabilityFields(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (/offer.*probab|probab.*offer|录用.*概率/i.test(key)) throw new Error("复盘不能包含录用概率");
    rejectProbabilityFields(child);
  }
}

function normalizeTurnReasonItems(value, validTurns, label) {
  if (!Array.isArray(value) || value.length > 12) throw new Error(`${label}格式无效`);
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${label}格式无效`);
    const turnNumber = Number(item.turnNumber);
    if (!Number.isInteger(turnNumber) || !validTurns.has(turnNumber)) {
      throw new Error(`${label}引用了不存在的题号：${turnNumber}`);
    }
    return { turnNumber, reason: cleanText(item.reason, 1_000, `${label}理由`) };
  });
}

function reportHighlights(value, validTurns, label) {
  if (!Array.isArray(value) || value.length > 3) throw new Error(`${label}格式无效`);
  return boundedTextArray(value.map(item => {
    if (typeof item === 'string') return item;
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.text !== 'string') {
      throw new Error(`${label}文字格式无效`);
    }
    const turnNumber = Number(item.turnNumber);
    if (!Number.isInteger(turnNumber) || !validTurns.has(turnNumber)) throw new Error(`${label}引用了不存在的题号`);
    return `第${turnNumber}题：${cleanText(item.text, 980, label)}`;
  }), label, { maxItems: 3 });
}

function validateInterviewReport(raw, context = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("面试复盘格式无效");
  rejectProbabilityFields(raw);
  const validTurns = turnNumberSet(context.turns);
  const answerStructures = Array.isArray(raw.answerStructures) ? raw.answerStructures.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("回答结构格式无效");
    const turnNumber = Number(item.turnNumber);
    if (!Number.isInteger(turnNumber) || !validTurns.has(turnNumber)) {
      throw new Error(`回答结构引用了不存在的题号：${turnNumber}`);
    }
    const outline = typeof item.outline === "string" ? [item.outline] : item.outline;
    return { turnNumber, outline: boundedTextArray(outline, "回答结构", { maxItems: 8, itemLength: 500 }) };
  }) : (() => { throw new Error("回答结构格式无效"); })();
  if (answerStructures.length > 12) throw new Error("回答结构过多");
  return {
    ...(Array.isArray(raw.evidenceCandidates) ? { evidenceCandidates: raw.evidenceCandidates.slice(0, 3).flatMap(item => {
      const turn = (context.turns || []).find(turn => Number(turn.turnNumber) === Number(item?.turnNumber));
      const sourceQuote = String(item?.sourceQuote || '').trim();
      const subject = String(item?.subject || '').trim();
      const text = String(item?.text || '').trim();
      if (!turn || !sourceQuote || !String(turn.answerText || turn.answer || '').includes(sourceQuote)
        || !subject || subject.length > 160 || !text || text.length > 8000 || sourceQuote.length > 8000) return [];
      // Confirmed learning material uses the verified answer, not model embellishment.
      return [{ turnNumber: Number(item.turnNumber), subject, text: sourceQuote, sourceQuote }];
    }).filter((item, index, items) => items.findIndex(other => other.sourceQuote === item.sourceQuote) === index) } : {}),
    conclusion: cleanText(raw.conclusion, 3_000, "复盘结论"),
    strengths: reportHighlights(raw.strengths, validTurns, "最强项"),
    improvements: reportHighlights(raw.improvements, validTurns, "改进项"),
    followUpRisks: normalizeTurnReasonItems(raw.followUpRisks, validTurns, "追问风险"),
    retryRecommendations: normalizeTurnReasonItems(raw.retryRecommendations, validTurns, "重练建议"),
    answerStructures
  };
}

function validateRetryReview(raw, context = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("重答复盘格式无效");
  rejectProbabilityFields(raw);
  const expectedTurnNumber = Number(context.turnNumber);
  const turnNumber = Number(raw.turnNumber);
  if (!Number.isInteger(turnNumber) || turnNumber !== expectedTurnNumber) throw new Error("重答复盘题号不匹配");
  if (typeof raw.improved !== "boolean") throw new Error("重答改进结果格式无效");
  return {
    turnNumber,
    conclusion: cleanText(raw.conclusion, 2_000, "重答结论"),
    improved: raw.improved,
    strengths: boundedTextArray(raw.strengths, "重答优点"),
    remainingImprovements: boundedTextArray(raw.remainingImprovements, "剩余改进点")
  };
}

function buildInterviewBrief({ sessionKind, job, resumeEvidenceCatalog = [], candidateEvidence = [], priorWeaknesses = [] }) {
  const generalThemes = ['经历与求职方向', '实际承担的工作', '解决问题与取舍', '协作与沟通', '成果与复盘'];
  const understanding = job?.analysis?.jobUnderstanding || job?.analysis || {};
  const jobFocus = job ? {
    role: understanding.roleSummary || job.analysis?.roleSummary || '',
    description: job.description,
    coreResponsibilities: understanding.coreResponsibilities || job.analysis?.coreResponsibilities || [],
    coreRequirements: understanding.coreRequirements || job.analysis?.coreRequirements || [],
    requirementMatches: job.analysis?.requirementMatches || [],
    roleGaps: job.analysis?.roleGaps || [],
    questionsToVerify: job.analysis?.questionsToVerify || [],
    roleResumeEvidence: job.analysis?.roleResumeEvidence || [],
    requirements: understanding.coreRequirements || job.analysis?.coreRequirements
      || understanding.requirements || job.analysis?.requirementAssessments || [],
    matchingEvidence: job.analysis?.evidence || {}
  } : null;
  return { sessionKind, generalThemes, jobFocus, resumeEvidenceCatalog, candidateEvidence, priorWeaknesses,
    coverageRule: '先覆盖重要主题；回答缺少关键证据时追问，有充分信息后切换主题。岗位专项优先覆盖 JD 核心职责与用户经历的适配点。' };
}

function buildInterviewProgress(brief, turns = []) {
  const themes = Array.isArray(brief?.generalThemes) ? brief.generalThemes : [];
  const themePatterns = [
    /intro|motivation|career|direction|经历与求职方向|自我介绍|职业方向|求职|动机|离职原因|空档/,
    /contribution|responsibility|实际承担的工作|个人贡献|职责|承担|负责|参与.*工作/,
    /problem_solving|tradeoff|technical|解决问题与取舍|难题|排障|定位|解决问题|取舍|技术/,
    /collaboration|teamwork|communication|协作与沟通|协作|合作|沟通|分歧/,
    /result|reflection|成果与复盘|成果|结果|复盘|量化|改进/
  ];
  const askedQuestions = turns.map(turn => String(turn.question || turn.questionText || '').trim()).filter(Boolean);
  const coveredThemes = themes.filter((theme, index) => turns.some(turn => {
    const focus = String(turn.focus || turn.questionFocus || '').toLowerCase();
    const question = String(turn.question || turn.questionText || '');
    const recognizedFocus = themes.includes(focus) || themePatterns.some(pattern => pattern.test(focus));
    return focus === theme || themePatterns[index]?.test(recognizedFocus ? focus : question);
  }));
  return { askedQuestions, coveredThemes, remainingThemes: themes.filter(theme => !coveredThemes.includes(theme)) };
}

module.exports = {
  buildInterviewBrief,
  buildInterviewProgress,
  normalizeInterviewSettings,
  buildResumeInterviewEvidenceCatalog,
  projectInterviewFacts,
  validateInterviewStep,
  validateInterviewReport,
  validateRetryReview
};

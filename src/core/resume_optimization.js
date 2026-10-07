const MAX_SUGGESTIONS = 12;
const SUPPORTED_OPERATIONS = new Set(["replace", "remove", "insert_after"]);
const SUPPORTED_DECISIONS = new Set(["pending", "accepted", "edited", "ignored"]);
const EDITING_PRINCIPLES = new Set([
  "relevance_order",
  "contribution_clarity",
  "result_visibility",
  "jd_vocabulary",
  "concision",
  "structure"
]);
const STRONG_ROLE_MARKERS = ["主导", "牵头", "独立负责", "全权负责", "从零搭建", "第一负责人"];
const {
  extractHighRiskClaims,
  normalizedMessageText,
  assessMessageDraftQuality
} = require("./message_draft_quality");
const PLACEHOLDER_PATTERNS = Object.freeze([
  /X{3,}/i,
  // Pending workflow states in prose are facts, not unfinished template values.
  /(?:^|\n)[ \t]*(?![^：:\n]{0,38}状态[ \t]*[:：])(?:[^：:\n]{1,40}[:：]\s*)?待(?:填写|补充|确认)\s*(?=\n|$)/,
  /(?:^|\n)\s*待(?:填写|补充|确认)\s*(?:姓名|手机|电话|邮箱|公司|学校|成果)/,
  /[\[【<]\s*待(?:填写|补充|确认)\s*[\]】>]/,
  /TODO/i,
  /(?:手机|电话|邮箱)[:：]?\s*(?:无|未填|示例|待填写|待补充|待确认)/
]);
const EDUCATION_HEADING = /(?:^|\n)\s*(?:教育(?:经历|背景)?|学历(?:信息)?)(?:[:：\s]|$)/;

function cleanText(value, maxLength, label, { required = true } = {}) {
  const text = String(value ?? "").trim();
  if (required && !text) throw new Error(`${label}不能为空`);
  if (text.length > maxLength) throw new Error(`${label}过长`);
  return text;
}

function addEvidence(items, prefix, kind, values, toText) {
  for (const value of Array.isArray(values) ? values : []) {
    const text = cleanText(toText(value), 20_000, "证据文字", { required: false });
    if (!text) continue;
    items.push({
      id: `${prefix}${items.filter((item) => item.kind === kind).length + 1}`,
      kind,
      text
    });
  }
}

function buildResumeEvidenceCatalog(input = {}) {
  const items = [];
  const sourceLines = String(input.sourceText ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  addEvidence(items, "R", "resume", sourceLines, (line) => line);
  addEvidence(items, "J", "job", input.jobs, (job = {}) => [job.title, job.company, job.description || job.jdText].filter(Boolean).join("｜"));
  addEvidence(items, "F", "fact", input.facts, (fact = {}) => [fact.key || fact.factKey, fact.value || fact.factValue].filter(Boolean).join("："));
  addEvidence(items, "A", "answer", input.answerMemories, (memory = {}) => [memory.questionClass, memory.finalText || memory.final_text].filter(Boolean).join("："));
  addEvidence(items, "E", "candidate_evidence", input.candidateEvidence, item => [item.subject, item.text].filter(Boolean).join('：'));
  if (input.diagnosis) {
    addEvidence(items, "D", "diagnosis", [input.diagnosis], (diagnosis = {}) => {
      if (typeof diagnosis === "string") return diagnosis;
      return diagnosis.conclusion || diagnosis.summary || JSON.stringify(diagnosis);
    });
  }
  return items;
}

function exactRange(sourceText, originalText) {
  const start = sourceText.indexOf(originalText);
  if (start < 0) throw new Error(`建议原文不存在：${originalText}`);
  if (sourceText.indexOf(originalText, start + 1) >= 0) {
    throw new Error(`建议原文不唯一：${originalText}`);
  }
  return { start, end: start + originalText.length };
}

// Model input normalizes full-width punctuation. Restore only a unique literal
// Unicode-equivalent anchor; masked identity text and guessed wording cannot map.
function restoreResumeSuggestionAnchors(raw, { sourceText, modelText }) {
  if (!Array.isArray(raw?.suggestions)) return raw;
  let normalizedSource;
  let boundaries;
  return { ...raw, suggestions: raw.suggestions.map(suggestion => {
    const anchor = String(suggestion?.originalText || '').trim();
    if (!anchor || sourceText.includes(anchor)) return suggestion;
    exactRange(modelText, anchor);
    if (!boundaries) {
      boundaries = new Map([[0, 0]]);
      normalizedSource = '';
      for (const { segment, index } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(sourceText)) {
        normalizedSource += segment.normalize('NFKC');
        boundaries.set(normalizedSource.length, index + segment.length);
      }
    }
    const range = exactRange(normalizedSource, anchor);
    if (!boundaries.has(range.start) || !boundaries.has(range.end)) throw new Error('建议原文不能准确映射');
    return { ...suggestion, originalText: sourceText.slice(boundaries.get(range.start), boundaries.get(range.end)) };
  }) };
}

function numericTokens(text) {
  return String(text ?? "").match(/\d+(?:\.\d+)?%?/g) || [];
}

function positiveRoleClaim(text, marker) {
  const literalMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(text || "").split(/[，。；\n]|但是|但|不过/).some(clause =>
    clause.includes(marker) && !new RegExp(`(?:没有|并未|从未|未曾|不是|并非|未|没|非|不)[^，。；\\n]{0,10}${literalMarker}`).test(clause));
}

function validateGrounding(suggestion, evidenceText) {
  const missingNumber = numericTokens(suggestion.proposedText).find((token) => !evidenceText.includes(token));
  if (missingNumber) throw new Error(`建议包含没有证据支持的数字：${missingNumber}`);

  const escalatedMarker = STRONG_ROLE_MARKERS.find(marker => positiveRoleClaim(suggestion.proposedText, marker)
    && !positiveRoleClaim(evidenceText, marker));
  if (escalatedMarker) throw new Error(`建议扩大了候选人的职责边界：${escalatedMarker}`);

  for (const [, object] of String(suggestion.originalText || '').matchAll(/参与([^，。；\n]+)/g)) {
    const responsibility = `负责${object}`;
    if (positiveRoleClaim(suggestion.proposedText, responsibility)
      && !['负责', '完成', '实现', '编写', '设计'].some(action => positiveRoleClaim(evidenceText, `${action}${object}`))) {
      throw new Error(`建议扩大了候选人的职责边界：${responsibility}`);
    }
  }

  const namedSkills = [...String(suggestion.proposedText || '').matchAll(
    /(?:熟悉|熟练|精通|掌握)\s*(?:使用)?([A-Za-z][A-Za-z0-9.+#-]*)/g
  )].map(match => match[1]);
  for (const [, skills] of String(suggestion.proposedText || '').matchAll(
    /(?:^|\n)\s*(?:技术栈|技能|语言|框架|数据库|工具)[:：]([^\n]+)/g
  )) namedSkills.push(...(skills.match(/[A-Za-z][A-Za-z0-9.+#-]*/g) || []));
  const unsupportedSkill = namedSkills.find(skill => {
    const literalSkill = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return !new RegExp(`(?<![A-Za-z0-9])${literalSkill}(?![A-Za-z0-9])`, 'i').test(evidenceText.normalize('NFKC'));
  });
  if (unsupportedSkill) throw new Error(`建议包含没有证据支持的技能：${unsupportedSkill}`);
}

function validateResumeOptimizationDraft(raw, context = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("简历优化结果格式无效");
  const sourceText = cleanText(context.sourceText, 200_000, "源简历");
  const catalog = Array.isArray(context.evidenceCatalog) ? context.evidenceCatalog : [];
  const evidenceById = new Map();
  for (const item of catalog) {
    const id = cleanText(item?.id, 40, "证据 ID");
    if (evidenceById.has(id)) throw new Error(`证据 ID 重复：${id}`);
    evidenceById.set(id, { kind: item?.kind, text: cleanText(item?.text, 20_000, "证据文字") });
  }

  if (!Array.isArray(raw.suggestions) || raw.suggestions.length > MAX_SUGGESTIONS) {
    throw new Error(`修改建议必须为 0-${MAX_SUGGESTIONS} 条`);
  }

  const seenIds = new Set();
  const ranges = [];
  const suggestions = raw.suggestions.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("修改建议格式无效");
    const id = cleanText(value.id || `S${index + 1}`, 40, "建议 ID");
    if (!/^S[1-9]\d*$/.test(id)) throw new Error(`建议 ID 格式无效：${id}`);
    if (seenIds.has(id)) throw new Error(`建议 ID 重复：${id}`);
    seenIds.add(id);

    const operation = cleanText(value.operation, 30, "修改操作");
    if (!SUPPORTED_OPERATIONS.has(operation)) throw new Error(`不支持的修改操作：${operation}`);
    const originalText = cleanText(value.originalText, 10_000, "建议原文");
    const proposedText = cleanText(value.proposedText, 10_000, "建议文字", { required: operation === "remove" ? false : true });
    if (operation === "remove" && proposedText) throw new Error("删除操作不能同时提供替换文字");
    const reason = cleanText(value.reason, 1_000, "修改理由");
    const editingPrinciple = cleanText(value.editingPrinciple, 40, "修改原则");
    if (!EDITING_PRINCIPLES.has(editingPrinciple)) throw new Error(`不支持的修改原则：${editingPrinciple}`);
    if (!Array.isArray(value.evidenceIds) || value.evidenceIds.length < 1 || value.evidenceIds.length > 8) {
      throw new Error("每条建议必须引用 1-8 条证据");
    }
    const evidenceIds = [...new Set(value.evidenceIds.map((item) => cleanText(item, 40, "证据 ID")))];
    const citedText = evidenceIds.map((evidenceId) => {
      if (!evidenceById.has(evidenceId)) throw new Error(`建议引用了不存在的证据：${evidenceId}`);
      return evidenceById.get(evidenceId);
    }).filter(candidateEvidenceItem).map(item => item.text).join("\n");
    const range = exactRange(sourceText, originalText);
    ranges.push({ ...range, id });
    if (operation !== 'insert_after' && EDUCATION_HEADING.test(originalText) && !EDUCATION_HEADING.test(proposedText)) {
      throw new Error('建议不能删除教育分类或将教育信息改为其他经历');
    }
    validateGrounding({ originalText, proposedText }, `${originalText}\n${citedText}`);

    return { id, operation, originalText, proposedText, reason, evidenceIds, editingPrinciple, decision: "accepted", userText: "" };
  });

  ranges.sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].start < ranges[index - 1].end) {
      throw new Error(`修改建议原文重叠：${ranges[index - 1].id} / ${ranges[index].id}`);
    }
  }

  return {
    headline: cleanText(raw.headline, 300, "优化结论", { required: false }),
    suggestions
  };
}

function normalizeResumeSuggestionDecisions(suggestions, decisions = {}) {
  if (!Array.isArray(suggestions)) throw new Error("修改建议格式无效");
  return suggestions.map((suggestion) => {
    const input = decisions[suggestion.id] || {};
    const decision = cleanText(input.decision || suggestion.decision || "pending", 30, "处理结果");
    if (!SUPPORTED_DECISIONS.has(decision)) throw new Error(`不支持的处理结果：${decision}`);
    const userText = decision === "edited"
      ? cleanText(input.userText ?? suggestion.userText, 10_000, "编辑文字")
      : "";
    return { ...suggestion, decision, userText };
  });
}

function removalRange(sourceText, range) {
  const before = range.start > 0 ? sourceText[range.start - 1] : "";
  const after = sourceText[range.end] || "";
  if ((range.start === 0 || before === "\n") && (range.end === sourceText.length || after === "\n")) {
    if (after === "\n") return { start: range.start, end: range.end + 1 };
    if (before === "\n") return { start: range.start - 1, end: range.end };
  }
  return range;
}

function renderOptimizedResume(sourceText, suggestions) {
  let result = cleanText(sourceText, 200_000, "源简历");
  const operations = [];
  for (const suggestion of Array.isArray(suggestions) ? suggestions : []) {
    if (!suggestion || !["accepted", "edited"].includes(suggestion.decision)) continue;
    const range = exactRange(result, cleanText(suggestion.originalText, 10_000, "建议原文"));
    const content = suggestion.decision === "edited" ? suggestion.userText : suggestion.proposedText;
    const targetRange = suggestion.operation === "remove" && suggestion.decision === "accepted"
      ? removalRange(result, range)
      : range;
    const isWholeLineAnchor = (range.start === 0 || result[range.start - 1] === "\n")
      && (range.end === result.length || result[range.end] === "\n");
    const replacement = suggestion.operation === "insert_after"
      ? `${suggestion.originalText}${isWholeLineAnchor ? "\n" : ""}${content}`
      : content;
    const removedTailTerminator = suggestion.operation === "remove" && suggestion.decision === "accepted"
      && (range.end === result.length || result[range.end] === "\n")
      && /[，,；;]/.test(result[range.start - 1] || "")
      ? suggestion.originalText.match(/[。.!！?？]$/)?.[0] : null;
    operations.push({ ...targetRange, replacement, removedTailTerminator });
  }

  for (const operation of operations) {
    if (!operation.removedTailTerminator) continue;
    const adjacent = operations.find(other => other !== operation && other.end === operation.start
      && other.start < operation.start && /[，,；;]$/.test(other.replacement));
    if (adjacent) {
      adjacent.replacement = adjacent.replacement.slice(0, -1) + operation.removedTailTerminator;
      operation.removedTailTerminator = null;
    }
  }
  operations.sort((left, right) => right.start - left.start);
  for (const operation of operations) {
    if (operation.removedTailTerminator) {
      result = result.slice(0, operation.start - 1) + operation.removedTailTerminator + result.slice(operation.start);
    }
    result = `${result.slice(0, operation.start)}${operation.replacement}${result.slice(operation.end)}`;
  }
  return result;
}

function selectRepresentativeResumeJobs(jobs, { targetDirection, limit = 5 } = {}) {
  const direction = String(targetDirection ?? "").trim().toLocaleLowerCase("zh-CN");
  if (!direction) throw new Error("目标投递方向不能为空");
  const tokens = [...new Set(direction.split(/[\s/|、，,;；]+/).map((item) => item.trim()).filter(Boolean))];
  const recommendationRanks = new Map([["primary", 0], ["apply", 1], ["caution", 2]]);
  const ranked = (Array.isArray(jobs) ? jobs : []).map((job) => {
    const analysis = job?.analysis || {};
    const roleText = [
      job?.title,
      job?.keyword,
      analysis.realRoleType,
      analysis.businessScenario,
      analysis.roleSummary,
      analysis.jobUnderstanding?.realRoleType,
      analysis.jobUnderstanding?.businessScenario,
      analysis.jobUnderstanding?.roleSummary
    ].map((value) => String(value || "").toLocaleLowerCase("zh-CN")).join(" ");
    return {
      job,
      directionScore: tokens.filter((token) => roleText.includes(token)).length,
      recommendationRank: recommendationRanks.get(String(analysis.recommendation || "").toLowerCase()) ?? 3,
      lastSeenAt: String(job?.lastSeenAt || ""),
      id: Number(job?.id || 0)
    };
  }).filter((item) => item.directionScore > 0);

  ranked.sort((left, right) => right.directionScore - left.directionScore
    || left.recommendationRank - right.recommendationRank
    || right.lastSeenAt.localeCompare(left.lastSeenAt)
    || right.id - left.id);

  const boundedLimit = Math.max(1, Math.min(5, Number(limit) || 5));
  const selected = [];
  const selectedIds = new Set();
  const companies = new Set();
  for (const item of ranked) {
    const company = String(item.job?.company || "").trim().toLocaleLowerCase("zh-CN");
    if (!company || companies.has(company)) continue;
    selected.push(item.job);
    selectedIds.add(item.id);
    companies.add(company);
    if (selected.length >= boundedLimit) return selected;
  }
  for (const item of ranked) {
    if (selectedIds.has(item.id)) continue;
    selected.push(item.job);
    if (selected.length >= boundedLimit) break;
  }
  return selected;
}

function validateResumeActivationText({
  sourceText = "",
  sourceEvidenceText = sourceText,
  generatedText = "",
  finalText = "",
  candidateName = "",
  facts = [],
  answerMemories = [],
  candidateEvidence = [],
  suggestions = []
} = {}) {
  const source = String(sourceText || "").trim();
  const generated = String(generatedText || "").trim();
  const final = String(finalText || "").trim();
  const errors = [];
  const warnings = [];
  try {
    const expectedGenerated = renderOptimizedResume(source, suggestions);
    if (comparableResumeText(expectedGenerated) !== comparableResumeText(generated)) {
      errors.push(issue("RESUME_GENERATED_BASELINE_CHANGED"));
    }
  } catch {
    errors.push(issue("RESUME_GENERATED_BASELINE_CHANGED"));
  }
  if (normalizedMessageText(final).length < 40) errors.push(issue("RESUME_TEXT_TOO_SHORT"));
  if (PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(final))) {
    errors.push(issue("RESUME_PLACEHOLDER_PRESENT"));
  }
  if (sourceIdentityRemoved(source, final, candidateName)) {
    errors.push(issue("RESUME_CONTACT_REMOVED"));
  }

  const evidenceTexts = [String(sourceEvidenceText || '').trim()]
    .concat(candidateEvidence.filter(item => !item.withdrawnAt).map(item => item.text))
    .concat((Array.isArray(facts) ? facts : []).filter(candidateEvidenceItem).map(factEvidenceText))
    .concat((Array.isArray(answerMemories) ? answerMemories : [])
      .filter(candidateEvidenceItem)
      .map((memory) => String(memory.finalText ?? memory.final_text ?? "").trim()))
    .filter(Boolean);
  const unsupported = assessMessageDraftQuality({ text: final, recentTexts: [], evidenceTexts }).errors;
  if (unsupported.length || hasUnsupportedResumeTokens(final, evidenceTexts)) {
    errors.push(issue("RESUME_FACT_UNSUPPORTED"));
  }
  if (STRONG_ROLE_MARKERS.some(marker => positiveRoleClaim(final, marker)
    && !positiveRoleClaim(evidenceTexts.join("\n"), marker))) {
    errors.push(issue("RESUME_FACT_UNSUPPORTED"));
  }

  const normalizedSource = normalizedMessageText(source);
  const normalizedFinal = normalizedMessageText(final);
  if (normalizedSource && trigramJaccard(normalizedSource, normalizedFinal) >= 0.98) {
    warnings.push(issue("RESUME_NEARLY_UNCHANGED"));
  }
  const sourceLength = source.replace(/\s+/g, "").length;
  const finalLength = final.replace(/\s+/g, "").length;
  if (sourceLength > 0 && finalLength > sourceLength * 1.3) {
    warnings.push(issue("RESUME_LENGTH_INCREASED"));
  }
  if (comparableResumeText(final) !== comparableResumeText(generated)) {
    warnings.push(issue("RESUME_USER_EXTRA_EDIT"));
  }
  return { valid: uniqueIssues(errors).length === 0, errors: uniqueIssues(errors), warnings: uniqueIssues(warnings) };
}

function sourceIdentityRemoved(sourceText, finalText, candidateName) {
  const normalizedFinal = normalizedMessageText(finalText);
  const normalizedName = normalizedMessageText(candidateName);
  if (normalizedName && normalizedMessageText(sourceText).includes(normalizedName)
    && !normalizedFinal.includes(normalizedName)) return true;
  const sourceContacts = extractHighRiskClaims(sourceText)
    .filter((claim) => ["phone", "email", "url"].includes(claim.kind));
  return sourceContacts.some((claim) => !normalizedFinal.includes(normalizedMessageText(claim.value)));
}

function candidateEvidenceItem(item) {
  return !["job", "diagnosis"].includes(String(item?.kind || ""));
}

function factEvidenceText(fact = {}) {
  const key = String(fact.factKey || fact.key || "").trim();
  const value = String(fact.factValue ?? fact.value ?? "").trim();
  if (!value) return "";
  if (["availability", "availability_date"].includes(key)) return `${value}到岗`;
  if (key === "interview_availability") return `${value}可以面试`;
  if (key === "overtime_acceptance") return `${value}加班`;
  if (key === "travel_acceptance") return `${value}出差`;
  if (key === "relocation_acceptance") return `${value}异地搬迁`;
  const label = { expected_salary: "期望薪资", salary: "期望薪资", phone: "手机号", mobile: "手机号", email: "邮箱" }[key] || key;
  return label ? `${label}：${value}` : value;
}

function hasUnsupportedResumeTokens(text, evidenceTexts) {
  const evidence = normalizedMessageText(evidenceTexts.join("\n"));
  return resumeOnlyTokens(text).some((token) => !evidence.includes(normalizedMessageText(token)));
}

function resumeOnlyTokens(text) {
  const source = String(text || "");
  const patterns = [
    /\b(?:19|20)\d{2}[年./-]\d{1,2}(?:[月./-]\d{1,2}日?)?/g,
    /(?<![A-Za-z0-9])\d+(?:\.\d+)?\s*(?:[KkWw]|万|千)元?(?![A-Za-z0-9])/g
  ];
  return [...new Set(patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[0])))];
}

function comparableResumeText(value) {
  return String(value || "").replace(/\r\n?/g, "\n").split("\n")
    .map((line) => line.trim()).filter(Boolean).join("\n");
}

function trigramJaccard(left, right) {
  if (left === right && left) return 1;
  const leftSet = trigrams(left);
  const rightSet = trigrams(right);
  let intersection = 0;
  for (const value of leftSet) if (rightSet.has(value)) intersection += 1;
  const union = leftSet.size + rightSet.size - intersection;
  return union ? intersection / union : 0;
}

function trigrams(text) {
  const values = new Set();
  for (let index = 0; index <= text.length - 3; index += 1) values.add(text.slice(index, index + 3));
  return values;
}

function issue(code) {
  return { code };
}

function uniqueIssues(items) {
  const seen = new Set();
  return items.filter((item) => item?.code && !seen.has(item.code) && seen.add(item.code));
}

module.exports = {
  buildResumeEvidenceCatalog,
  restoreResumeSuggestionAnchors,
  validateResumeOptimizationDraft,
  validateResumeActivationText,
  normalizeResumeSuggestionDecisions,
  renderOptimizedResume,
  selectRepresentativeResumeJobs
};

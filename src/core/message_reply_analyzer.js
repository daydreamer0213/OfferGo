const { validateMessageReply } = require("./message_reply_contract");
const { mergeCandidateFacts, currentCandidateMaterial, currentFactValue, factStatus } = require("./candidate_fact_policy");
const { selectRelevantCandidateMaterial } = require('./candidate_evidence');

function createMessageReplyAnalyzer({ adapter, logger = null } = {}) {
  if (!adapter || typeof adapter.draftMessageGroup !== "function") {
    throw new Error("message reply analyzer requires adapter.draftMessageGroup");
  }
  return async function analyzeMessageGroup(
    { profile, currentResume = null, job, platform = "", requestedActions = [], messages = [], facts = [], factRevisions = [], answerMemories = [], candidateEvidence = [], draftQualityRevision, now } = {},
    { signal = null } = {}
  ) {
    now = now || new Date().toISOString();
    const normalizedFacts = mergeCandidateFacts(facts, candidateEvidence, { job, factRevisions }).map((fact) => ({
      key: String(fact.key || fact.factKey || ""),
      value: fact.value !== undefined ? fact.value : fact.factValue,
      subjectKey: fact.subjectKey || "",
      source: fact.source || "",
      updatedAt: fact.updatedAt || fact.confirmedAt || ""
    }));
    const requestedSubjectKeys = deriveRequestedSubjectKeys(messages, normalizedFacts);
    const scopedFacts = normalizedFacts.filter((fact) => factMatchesRequestedScope(fact, requestedSubjectKeys)
      && factStatus(now, fact).status === 'valid').map(fact => ({...fact,value:currentFactValue(fact,now)}));
    const query = messages.map(message => String(message.text || '')).join('\n');
    const materialPolicy = { now, facts: normalizedFacts, factRevisions };
    const relevantEvidence = selectRelevantCandidateMaterial(currentCandidateMaterial(candidateEvidence, materialPolicy), { query, job, limit: 12, maxChars: 12000 });
    const activeMemories = normalizeAnswerMemories(selectRelevantCandidateMaterial(currentCandidateMaterial((Array.isArray(answerMemories) ? answerMemories : [])
      .filter((memory) => memoryMatchesContext(memory, job, requestedSubjectKeys)), materialPolicy), { query, job, limit: 12, maxChars: 8000 }));
    const input = {
      now,
      profile,
      currentResume: currentResume ? { ...currentResume,
        text: currentCandidateMaterial([{ text: currentResume.text, source: 'active_resume' }], materialPolicy)[0]?.text || ''
      } : null,
      job,
      platform: String(platform || "").toLowerCase(),
      requestedActions: Array.isArray(requestedActions)
        ? requestedActions.filter((item) => item?.kind === "resume_request").map(() => ({ kind: "resume_request" })).slice(0, 1)
        : [],
      messages: messages.map((message) => ({
        messageKey: message.messageKey,
        text: String(message.text || "")
      })),
      facts: scopedFacts,
      answerMemories: activeMemories,
      candidateEvidence: relevantEvidence,
      requestedSubjectKeys,
      ...(draftQualityRevision ? { draftQualityRevision } : {})
    };
    try {
      const result = await adapter.draftMessageGroup(input, { signal });
      const context = {
        facts: input.facts,
        answerMemories: input.answerMemories,
        candidateEvidence: input.candidateEvidence,
        now,
        requestedSubjectKeys: input.requestedSubjectKeys,
        platform: input.platform,
        requestedActions: input.requestedActions,
        sourceMessages: input.messages.map((message) => message.text)
      };
      // An ended job in a resume does not establish today's employment state.
      // Reuse explicit current information; otherwise continue fact confirmation.
      const resumeEmployment = mergeCandidateFacts([], [{ text: input.currentResume?.text || "", updatedAt: now }])
        .some(fact => fact.factKey === "employment_status");
      if (result.messageIntent === "information_request" && result.messages?.length
        && !input.facts.some(fact => fact.key === "employment_status") && !resumeEmployment
        && /(?:在职|离职)(?:了)?[吗？?]|(?:现在|目前|当前|你|您).{0,8}(?:在职|离职).{0,6}[吗？?]|(?:是否|还).{0,4}在职/.test(query)) {
        return validateMessageReply({ ...result, messages: [], usedFactKeys: [], usedMemoryIds: [], usedEvidenceIds: [],
          requiredFactKeys: [...new Set([...(result.requiredFactKeys || []), "employment_status"])],
          missingFact: { key: "employment_status", question: "你目前是在职、离职，还是正在寻找新机会？" },
          coverage: result.coverage.map(item => ({ ...item, covered: false })),
          ...(result.responseStrategy ? { responseStrategy: { concern: result.responseStrategy.concern,
            focus: "先确认当前在职状态，再结合已确认资料回答本轮其他问题。" } } : {})
        }, context);
      }
      return validateMessageReply(result, context);
    } catch (error) {
      if (typeof logger?.warn === "function") {
        logger.warn("message_reply_analyzer_failed", { code: String(error?.code || "MESSAGE_REPLY_FAILED") });
      }
      throw error;
    } finally {
      for (const message of messages || []) message.text = "";
      for (const memory of activeMemories) memory.finalAnswer = "";
    }
  };
}

function normalizeAnswerMemories(value) {
  const memories = [];
  let remaining = 8000;
  for (const item of Array.isArray(value) ? value : []) {
    if (memories.length >= 12 || remaining <= 0) break;
    const id = Number(item?.id);
    const source = String(item?.source || "");
    const withdrawnAt = String(item?.withdrawnAt || "");
    if (!Number.isSafeInteger(id) || id <= 0 || source !== "user_edited_reply" || withdrawnAt) continue;
    const finalAnswer = String(item?.finalAnswer ?? item?.finalText ?? "").trim().slice(0, remaining);
    if (!finalAnswer) continue;
    remaining -= finalAnswer.length;
    memories.push({
      id,
      questionSummary: String(item?.questionSummary || "").replace(/\s+/g, " ").trim().slice(0, 160),
      messageIntent: String(item?.messageIntent || "").slice(0, 80),
      messageCategory: String(item?.messageCategory || "").slice(0, 80),
      finalAnswer,
      scope: normalizeMemoryScope(item?.scope),
      updatedAt: String(item?.updatedAt || "").slice(0, 40)
    });
  }
  return memories;
}

function normalizeMemoryScope(value) {
  const scope = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const kind = ["global", "job", "company", "experience"].includes(scope.kind) ? scope.kind : "global";
  return { kind, key: String(scope.key || "").replace(/\s+/g, " ").trim().slice(0, 160) };
}

function memoryMatchesContext(memory, job = {}, requestedSubjectKeys = []) {
  const scope = memory?.scope || { kind: "global", key: "" };
  if (scope.kind === "global") return true;
  if (scope.kind === "job") {
    return [job?.id, job?.sourceId].map((value) => String(value || "").trim())
      .filter(Boolean).includes(scope.key);
  }
  if (scope.kind === "company") return scopeText(scope.key) === scopeText(job?.company);
  if (scope.kind === "experience") return requestedSubjectKeys.includes(scope.key);
  return false;
}

function deriveRequestedSubjectKeys(messages, facts) {
  const messageText = scopeText((messages || []).map((message) => message?.text).join(" "));
  if (!messageText) return [];
  return [...new Set((facts || []).map((fact) => stableFactSubject(fact)).filter((subject) => {
    const normalizedSubject = scopeText(subject);
    return normalizedSubject && messageText.includes(normalizedSubject);
  }))];
}

function stableFactSubject(fact = {}) {
  const key = String(fact.key || "");
  if (!["gap.", "leaving_reason.", "short_project."].some((prefix) => key.startsWith(prefix))) return "";
  return String(fact.subjectKey || key.split(".").slice(1).join(".")).trim();
}

function factMatchesRequestedScope(fact, requestedSubjectKeys) {
  const subject = stableFactSubject(fact);
  if (!subject) return true;
  return requestedSubjectKeys.includes(subject);
}

function scopeText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

module.exports = {
  createMessageReplyAnalyzer
};

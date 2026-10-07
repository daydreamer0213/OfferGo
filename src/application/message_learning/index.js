const { getMessageReplyDraft, saveMessageReplyDraftEdit, completeMessageReplyDraft,
  listCandidateAnswerMemories, getCandidateAnswerMemory, getCurrentCandidateAnswerMemory,
  findMessageReplyMemoryByText, recordSentMessageReplyDraftWithoutLearning,
  reviseCandidateAnswerMemory, withdrawCandidateAnswerMemory,
  setCandidateAnswerMemoryScope,
  listCandidateFactRevisions, recordCandidateFactValue, deleteCandidateFact, getMessageReplyLearningStatus,
  listPendingMessageReplyLearning, recordMessageReplyLearningStatus,
  applyMessageReplyLearning } = require("../../storage/message_learning_store");
const { listCandidateFacts } = require("../../storage/candidate_store");
const { listCandidateEvidence, saveCandidateEvidence, reviseCandidateEvidence, withdrawCandidateEvidence } = require("../../storage/candidate_evidence_store");
const { mergeCandidateFacts, factStatus, currentCandidateMaterial, applySourceEvidenceUpdates } = require('../../core/candidate_fact_policy');
const {
  replyDraftDigest,
  replyDraftWasEdited,
  deriveUserChangedText,
  validateReplyEditFactExtraction
} = require("../../core/message_reply_learning");

function createMessageReplyLearningService({
  db,
  adapter = null,
  logger = null,
  now = () => new Date().toISOString()
} = {}) {
  if (!db) throw new Error("message reply learning service requires db");
  const inFlight = new Map();

  return {
    saveDraft,
    completeDraft,
    retryLearning,
    retryPendingLearning,
    listCommunicationProfile,
    reviseMemory,
    setMemoryScope,
    withdrawMemory,
    saveFact,
    deleteFact,
    reviseEvidence: input => reviseCandidateEvidence(db, input),
    withdrawEvidence: input => withdrawCandidateEvidence(db, input)
  };

  function saveDraft({ profileId, draftId, text, expectedRevision }) {
    return saveMessageReplyDraftEdit(db, {
      profileId,
      draftId,
      text,
      expectedRevision,
      updatedAt: nowIso(now())
    });
  }

  async function completeDraft({ profileId, draftId, finalText, completionKind, completionKey, afterComplete, expectedRevision, deferLearning = false }) {
    if (completionKind === 'sent' && deferLearning) {
      return completeDraftOnce({ profileId, draftId, finalText, completionKind, completionKey, afterComplete, expectedRevision, deferLearning });
    }
    const flightKey = `${profileId}:${draftId}:${replyDraftDigest(finalText)}`;
    if (inFlight.has(flightKey)) {
      const prior = await inFlight.get(flightKey);
      return completionKind === "sent"
        ? completeDraftOnce({ profileId, draftId, finalText, completionKind, completionKey, afterComplete, expectedRevision, deferLearning }) : prior;
    }
    const task = completeDraftOnce({ profileId, draftId, finalText, completionKind, completionKey, afterComplete, expectedRevision, deferLearning });
    inFlight.set(flightKey, task);
    try { return await task; } finally { inFlight.delete(flightKey); }
  }

  async function completeDraftOnce({ profileId, draftId, finalText, completionKind, completionKey, afterComplete, expectedRevision, deferLearning }) {
    const draft = requiredDraft(profileId, draftId);
    if (completionKind === 'copied' && expectedRevision !== undefined && expectedRevision !== null
      && (!Number.isSafeInteger(Number(expectedRevision)) || Number(expectedRevision) !== draft.revision)) {
      throw serviceError('MESSAGE_REPLY_DRAFT_CONFLICT', '草稿已在另一个页面修改，本页输入已保留，请复制后查看最新草稿。');
    }
    const existing = findMessageReplyMemoryByText(db, { profileId, draftId, finalText });
    if (existing) {
      const current = getCurrentCandidateAnswerMemory(db, { profileId, memoryId: existing.id });
      if (existing.withdrawnAt || !current) {
        const learningSkipped = existing.withdrawnAt ? "withdrawn" : "superseded";
        if (completionKind !== "sent") {
          throw serviceError(existing.withdrawnAt ? "CANDIDATE_ANSWER_MEMORY_WITHDRAWN" : "CANDIDATE_ANSWER_MEMORY_SUPERSEDED",
            "answer memory is no longer available for learning");
        }
        return sentWithoutLearning({ draft, profileId, draftId, finalText, afterComplete,
          completionKey, memoryId: existing.id, reason: learningSkipped });
      }
      const memory = completionKind === "sent" && existing.completionKind !== "sent"
        ? completeMessageReplyDraft(db, { profileId, draftId, finalText, completionKind,
          afterComplete, completedAt: nowIso(now()) }) : existing;
      const status = getMessageReplyLearningStatus(db, { profileId, memoryId: existing.id });
      if (completionKind !== "sent" && status && ["failed", "unavailable"].includes(status.status)) {
        return retryLearning({ profileId, memoryId: existing.id });
      }
      return completionResult(memory, requiredDraft(profileId, draftId), status?.factCount || 0, status?.status || "not_needed");
    }
    if (draft.closedAt) {
      throw serviceError("MESSAGE_REPLY_DRAFT_CLOSED", "message reply draft is already closed");
    }
    const initialCurrent = listCandidateAnswerMemories(db, { profileId, draftId: draft.id, activeOnly: true, limit: 1 })[0];
    const changed = replyDraftWasEdited(draft.originalText, finalText);
    const changedText = changed ? deriveUserChangedText(draft.originalText, finalText) : "";
    // The verified platform result is committed with the draft before any
    // optional model extraction. Existing retryLearning performs the supplement.
    if (completionKind === 'sent' && deferLearning) {
      const status = changed ? 'unavailable' : 'not_needed';
      const memory = completeMessageReplyDraft(db, { profileId, draftId, finalText, changedText,
        completionKind, scope: defaultScope(draft), extractedFacts: [], completedAt: nowIso(now()),
        afterComplete: item => {
          recordMessageReplyLearningStatus(db, { profileId, memoryId:item.id, status, at:nowIso(now()) });
          afterComplete?.(item);
        } });
      return completionResult(memory, requiredDraft(profileId,draftId), 0, status);
    }
    const extraction = changed
      ? await extractFacts({ draft, finalText, changedText })
      : { scope: { kind: "global", key: "" }, facts: [], status: "not_needed" };
    const currentAfterExtraction = listCandidateAnswerMemories(db, { profileId, draftId: draft.id, activeOnly: true, limit: 1 })[0];
    const matchedAfterExtraction = findMessageReplyMemoryByText(db, { profileId, draftId, finalText });
    if (completionKind === "sent" && matchedAfterExtraction?.withdrawnAt) {
      return sentWithoutLearning({ draft, profileId, draftId, finalText, afterComplete,
        completionKey, memoryId: matchedAfterExtraction.id, reason: "withdrawn" });
    }
    if (currentAfterExtraction?.id !== initialCurrent?.id) {
      if (currentAfterExtraction?.finalDigest === replyDraftDigest(finalText)) {
        const memory = completionKind === "sent" && currentAfterExtraction.completionKind !== "sent"
          ? completeMessageReplyDraft(db, { profileId, draftId, finalText, completionKind,
            afterComplete, completedAt: nowIso(now()) }) : currentAfterExtraction;
        const status = getMessageReplyLearningStatus(db, { profileId, memoryId: currentAfterExtraction.id });
        return completionResult(memory, requiredDraft(profileId, draftId),
          status?.factCount || 0, status?.status || "not_needed");
      }
      if (completionKind === "sent") {
        const matched = findMessageReplyMemoryByText(db, { profileId, draftId, finalText });
        return sentWithoutLearning({ draft, profileId, draftId, finalText, afterComplete,
          completionKey, memoryId: matched?.id, reason: matched?.withdrawnAt ? "withdrawn" : "superseded" });
      }
      throw serviceError("CANDIDATE_ANSWER_MEMORY_SUPERSEDED", "answer changed during learning");
    }
    const refreshedDraft = requiredDraft(profileId, draftId);
    if (refreshedDraft.closedAt || (completionKind === "sent" && refreshedDraft.revision !== draft.revision)) {
      if (completionKind === "sent") {
        return sentWithoutLearning({ draft, profileId, draftId, finalText, afterComplete,
          completionKey, memoryId: matchedAfterExtraction?.id, reason: "source_changed" });
      }
      throw serviceError("MESSAGE_REPLY_DRAFT_CLOSED", "message reply draft was closed during learning");
    }
    const memory = completeMessageReplyDraft(db, {
      profileId,
      draftId,
      finalText,
      changedText,
      completionKind,
      expectedRevision,
      afterComplete: memory => {
        saveReplyExperiences(memory, draft, extraction.experiences || []);
        afterComplete?.(memory);
        recordMessageReplyLearningStatus(db, { profileId, memoryId: memory.id,
          status: extraction.status, factCount: extraction.facts.length, at: nowIso(now()) });
      },
      scope: extraction.scope,
      extractedFacts: extraction.facts,
      completedAt: nowIso(now())
    });
    return completionResult(
      memory,
      requiredDraft(profileId, draftId),
      extraction.facts.length,
      extraction.status
    );
  }

  function sentWithoutLearning({ draft, profileId, draftId, finalText, completionKey,
    afterComplete, memoryId, reason }) {
    const sentDraft = recordSentMessageReplyDraftWithoutLearning(db, { profileId, draftId,
      memoryId, expectedRevision: draft.revision, finalText, completionKey,
      afterComplete, completedAt: nowIso(now()) });
    return { memoryId: null, draftId: draft.id, revision: sentDraft.revision,
      changed: replyDraftWasEdited(draft.originalText, finalText), learnedFactCount: 0,
      extractionStatus: "not_needed", learningSkipped: reason };
  }

  async function retryLearning({ profileId, memoryId }) {
    const key = `learning:${profileId}:${memoryId}`;
    if (inFlight.has(key)) return inFlight.get(key);
    const task = retryLearningOnce({ profileId, memoryId });
    inFlight.set(key, task);
    try { return await task; } finally { inFlight.delete(key); }
  }

  async function retryLearningOnce({ profileId, memoryId }) {
    const current = getCurrentCandidateAnswerMemory(db, { profileId, memoryId });
    if (!current || current.source !== "user_edited_reply") {
      throw serviceError("CANDIDATE_ANSWER_MEMORY_NOT_CURRENT", "answer memory is no longer current");
    }
    const status = getMessageReplyLearningStatus(db, { profileId, memoryId: current.id });
    if (!status || !["failed", "unavailable"].includes(status.status)) {
      return completionResult(current, requiredDraft(profileId, current.draftId), status?.factCount || 0, status?.status || "not_needed");
    }
    const draft = requiredDraft(profileId, current.draftId);
    const confirmedExperiences = listCandidateEvidence(db, { profileId }).filter(entry =>
      entry.sourceKind === 'manual' && entry.sourceId === `reply-edit:${current.id}`);
    const currentProjection = listCandidateAnswerMemories(db, { profileId, draftId: current.draftId,
      activeOnly: true, source: 'user_edited_reply', limit: 1 })[0];
    const effectiveText = applySourceEvidenceUpdates(current.finalText, currentProjection?.sourceEvidenceUpdates);
    const extraction = await extractFacts({ draft, finalText: effectiveText,
      changedText: deriveUserChangedText(draft.originalText, effectiveText), confirmedExperiences });
    const stillCurrent = Boolean(getCurrentCandidateAnswerMemory(db, { profileId, memoryId: current.id }));
    if (!stillCurrent || getMessageReplyLearningStatus(db, { profileId, memoryId: current.id })?.status === "succeeded") {
      throw serviceError("CANDIDATE_ANSWER_MEMORY_NOT_CURRENT", "answer memory changed during learning");
    }
    if (extraction.status !== "succeeded") {
      recordMessageReplyLearningStatus(db, { profileId, memoryId: current.id, status: extraction.status, at: nowIso(now()) });
      return completionResult(current, draft, 0, extraction.status);
    }
    const memory = applyMessageReplyLearning(db, { profileId, memoryId: current.id,
      extractedFacts: extraction.facts, at: nowIso(now()),
      afterApply: item => {
        const retained = listCandidateEvidence(db, { profileId }).filter(entry =>
          entry.sourceKind === 'manual' && entry.sourceId === `reply-edit:${current.id}`
          && current.finalText.includes(entry.sourceQuote));
        const withdrawnDuringExtraction = new Set(confirmedExperiences
          .filter(entry => !retained.some(active => active.id === entry.id))
          .map(entry => entry.sourceQuote));
        for (const entry of listCandidateEvidence(db, { profileId, includeWithdrawn: true })) {
          if (entry.sourceKind === 'manual' && entry.sourceId === `reply-edit:${current.id}`
            && entry.withdrawnAt) withdrawnDuringExtraction.add(entry.sourceQuote);
        }
        saveReplyExperiences(item, draft,
          [...retained, ...(extraction.experiences || []).filter(entry =>
            !withdrawnDuringExtraction.has(entry.sourceQuote))].filter((entry, index, entries) =>
            entries.findIndex(other => other.sourceQuote === entry.sourceQuote || other.text === entry.text) === index));
      } });
    if (!memory) throw serviceError("CANDIDATE_ANSWER_MEMORY_NOT_CURRENT", "answer memory changed during learning");
    return completionResult(memory, draft, extraction.facts.length, "succeeded");
  }

  async function retryPendingLearning({ profileId, limit = 1 }) {
    let result = null;
    for (const memoryId of listPendingMessageReplyLearning(db, { profileId, limit })) {
      result = await retryLearning({ profileId, memoryId });
    }
    return result;
  }

  function listCommunicationProfile({ profileId, answerPage = 1, answerQuery = '' }) {
    const evidence = listCandidateEvidence(db, { profileId });
    const revisions = listCandidateFactRevisions(db, { profileId, limit: 2000 });
    const page = Number.isSafeInteger(Number(answerPage)) && Number(answerPage) > 0 ? Number(answerPage) : 1;
    const pageSize = 50;
    const query = String(answerQuery || '').trim().slice(0,160);
    const answers = listCandidateAnswerMemories(db, { profileId, activeOnly: true,
      source: 'user_edited_reply', limit: pageSize + 1, offset: (page - 1) * pageSize, search: query });
    return {
      facts: mergeCandidateFacts(listCandidateFacts(db, profileId), evidence, { factRevisions: revisions })
        .map(fact => ({ ...fact, confirmation: factStatus(nowIso(now()), { ...fact, key: fact.factKey }) })),
      evidence,
      answers: answers.slice(0,pageSize).map(memory => ({ ...memory, learning: getMessageReplyLearningStatus(db, { profileId, memoryId: memory.id }) })),
      answerPage: { page, query, hasPrevious: page > 1, hasNext: answers.length > pageSize },
      revisions
    };
  }

  async function reviseMemory({ profileId, memoryId, finalText }) {
    const selected = getCandidateAnswerMemory(db, { profileId, memoryId });
    if (!selected) throw serviceError("CANDIDATE_ANSWER_MEMORY_NOT_FOUND", "candidate answer memory was not found");
    const current = getCurrentCandidateAnswerMemory(db, { profileId, memoryId });
    if (!current) throw serviceError("CANDIDATE_ANSWER_MEMORY_NOT_CURRENT", "answer memory is no longer current");
    const draft = requiredDraft(profileId, current.draftId);
    const changedText = deriveUserChangedText(current.finalText, finalText) || String(finalText || "").trim();
    const confirmedExperiences = listCandidateEvidence(db, { profileId }).filter(entry =>
      entry.sourceKind === 'manual' && entry.sourceId === `reply-edit:${current.id}`);
    const extraction = await extractFacts({ draft, finalText, changedText, confirmedExperiences });
    if (!getCurrentCandidateAnswerMemory(db, { profileId, memoryId: current.id })) {
      throw serviceError("CANDIDATE_ANSWER_MEMORY_NOT_CURRENT", "answer memory changed during learning");
    }
    const memory = reviseCandidateAnswerMemory(db, {
      profileId,
      memoryId,
      finalText,
      changedText,
      scope: current.scope,
      extractedFacts: extraction.facts,
      afterComplete: memory => {
        const retainedExperiences = listCandidateEvidence(db, { profileId }).filter(entry =>
          entry.sourceKind === 'manual' && entry.sourceId === `reply-edit:${current.id}`
          && String(finalText || '').includes(entry.sourceQuote));
        const withdrawnDuringExtraction = new Set(confirmedExperiences
          .filter(entry => !retainedExperiences.some(active => active.id === entry.id))
          .map(entry => entry.sourceQuote));
        for (const entry of listCandidateEvidence(db, { profileId, includeWithdrawn: true })) {
          if (entry.sourceKind === 'manual' && entry.sourceId === `reply-edit:${current.id}`
            && entry.withdrawnAt) withdrawnDuringExtraction.add(entry.sourceQuote);
        }
        saveReplyExperiences(memory, draft,
          [...retainedExperiences, ...(extraction.experiences || []).filter(entry =>
            !withdrawnDuringExtraction.has(entry.sourceQuote))].filter((entry, index, entries) =>
            entries.findIndex(item => item.sourceQuote === entry.sourceQuote) === index));
        recordMessageReplyLearningStatus(db, { profileId, memoryId: memory.id,
          status: extraction.status, factCount: extraction.facts.length, at: nowIso(now()) });
      },
      completedAt: nowIso(now())
    });
    return completionResult(memory, requiredDraft(profileId, current.draftId), extraction.facts.length, extraction.status);
  }

  function setMemoryScope({ profileId, memoryId, scopeKind }) {
    return setCandidateAnswerMemoryScope(db, {
      profileId, memoryId, scopeKind, updatedAt: nowIso(now())
    });
  }

  function withdrawMemory({ profileId, memoryId }) {
    const selected = getCandidateAnswerMemory(db, { profileId, memoryId });
    if (!selected) throw serviceError("CANDIDATE_ANSWER_MEMORY_NOT_FOUND", "candidate answer memory was not found");
    const memories = [];
    // Read the entire selected answer's history before changing its ordering.
    // The model's global 500-memory retrieval budget remains unchanged.
    for (let offset = 0;; offset += 500) {
      const page = listCandidateAnswerMemories(db, { profileId, draftId: selected.draftId,
        activeOnly: false, limit: 500, offset });
      memories.push(...page);
      if (page.length < 500) break;
    }
    const withdrawnAt = nowIso(now());
    let result = selected;
    for (const memory of memories.filter((item) => item.draftId === selected.draftId && !item.withdrawnAt)) {
      result = withdrawCandidateAnswerMemory(db, {
        profileId,
        memoryId: memory.id,
        withdrawnAt,
        afterWithdraw: () => withdrawReplyExperiences(profileId, new Set([`reply-edit:${memory.id}`]))
      });
    }
    return result;
  }

  function saveFact({ profileId, factKey, factValue }) {
    return recordCandidateFactValue(db, { profileId, factKey, factValue, source: "user_provided",
      reconfirm: true, occurredAt: nowIso(now()) });
  }

  function deleteFact({ profileId, factKey }) {
    const recordIfMissing = listCommunicationProfile({ profileId }).facts.some(fact => fact.factKey === factKey);
    return deleteCandidateFact(db, {
      profileId,
      factKey,
      source: "user_provided",
      recordIfMissing,
      occurredAt: nowIso(now())
    });
  }

  async function extractFacts({ draft, finalText, changedText, confirmedExperiences = [] }) {
    if (!adapter || typeof adapter.extractReplyEditFacts !== "function") {
      return { scope: defaultScope(draft), facts: [], status: "unavailable" };
    }
    try {
      const value = await adapter.extractReplyEditFacts({
        originalText: draft.originalText,
        finalText: String(finalText || "").trim().slice(0, 4000),
        changedText,
        confirmedExperiences: currentCandidateMaterial(confirmedExperiences, { now: nowIso(now()) }),
        questionSummary: draft.questionSummary,
        messageIntent: draft.messageIntent,
        messageCategory: draft.messageCategory,
        scope: defaultScope(draft)
      });
      const validated = validateReplyEditFactExtraction(value, { changedText, finalText, confirmedExperiences, scope: defaultScope(draft) });
      return { ...validated, status: "succeeded" };
    } catch (error) {
      logger?.warn?.("message_reply_fact_extraction_failed", {
        code: String(error?.code || "MESSAGE_REPLY_FACT_EXTRACTION_FAILED")
      });
      return {
        scope: defaultScope(draft),
        facts: [],
        status: error?.code === "MESSAGE_REPLY_FACT_EXTRACTION_UNAVAILABLE" ? "unavailable" : "failed"
      };
    }
  }

  function requiredDraft(profileId, draftId) {
    const draft = getMessageReplyDraft(db, { profileId, draftId });
    if (!draft) throw serviceError("MESSAGE_REPLY_DRAFT_NOT_FOUND", "message reply draft was not found");
    return draft;
  }

  function withdrawReplyExperiences(profileId, sourceIds) {
    for (const entry of listCandidateEvidence(db, { profileId })) {
      if (entry.sourceKind === 'manual' && sourceIds.has(entry.sourceId)) withdrawCandidateEvidence(db, { profileId, id: entry.id });
    }
  }

  function saveReplyExperiences(memory, draft, experiences) {
    const previous = listCandidateAnswerMemories(db, { profileId: memory.profileId, draftId: draft.id, activeOnly: false, limit: 500 });
    withdrawReplyExperiences(memory.profileId, new Set(previous.map(item => `reply-edit:${item.id}`)));
    experiences.forEach((entry, index) => saveCandidateEvidence(db, {
      ...entry, profileId: memory.profileId, sourceKind: 'manual', sourceId: `reply-edit:${memory.id}`,
      sourceItemKey: String(index), scope: { kind: 'global', key: '' },
      confirmedAt: entry.updatedAt || memory.createdAt
    }));
  }
}

function completionResult(memory, draft, learnedFactCount, extractionStatus) {
  return {
    memoryId: memory.id,
    draftId: draft.id,
    revision: draft.revision,
    changed: memory.changed === true || memory.source === "user_edited_reply",
    learnedFactCount,
    extractionStatus
  };
}

function defaultScope(draft) {
  return { kind: draft?.jobId ? "job" : "global", key: draft?.jobId ? String(draft.jobId) : "" };
}

function nowIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("now must return a valid timestamp");
  return date.toISOString();
}

function serviceError(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = {
  createMessageReplyLearningService
};

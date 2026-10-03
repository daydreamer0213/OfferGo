const { getCandidateProfile, listCandidateFacts, saveCandidateFact } = require("../../storage/candidate_store");
const {
  recordMessageReplyDrafts
} = require("../../storage/message_learning_store");
const {
  getMessageInboundContext
} = require("../../storage/message_reply_send_store");
const {
  getDurableMessageDraftContext,
  getMessageGroupClassification,
  updateMessageGroupFactRequest
} = require("../../storage/message_discovery_store");
const { messageReplyProfile } = require("../../core/message_discovery");
const { deriveRequestedActions } = require('../../core/message_requested_actions');
const { candidateReplyMaterial } = require('./materials');
const { generateQualityCheckedDraft, buildMessageDraftQualityContext } = require('../message_draft_quality');

async function answerMissingMessageFact({
  db,
  profileId,
  cardId,
  messageGroupKey,
  factKey,
  factValue,
  classifyMessageGroup,
  now = () => new Date().toISOString(),
  signal = null
} = {}) {
  const profile = Number(profileId);
  const card = Number(cardId);
  const groupKey = String(messageGroupKey || "").trim();
  const key = String(factKey || "").trim();
  const answer = String(factValue || "").trim();
  if (!Number.isSafeInteger(profile) || profile <= 0 || !Number.isSafeInteger(card) || card <= 0
    || !/^sha256:[a-f0-9]{64}$/.test(groupKey) || !key || !answer) {
    throw answerFactError("MESSAGE_DISCOVERY_FACT_INVALID", "missing message fact input is invalid", 400);
  }
  const classification = getMessageGroupClassification(db, {
    profileId: profile,
    cardId: card,
    messageGroupKey: groupKey
  });
  if (!classification || classification.missingFactKey !== key) {
    throw answerFactError("MESSAGE_DISCOVERY_FACT_STALE", "message fact request is no longer current", 409);
  }
  const context = getMessageInboundContext(db, {
    profileId: profile,
    cardId: card,
    messageGroupKey: groupKey
  });
  const jobRow = getDurableMessageDraftContext(db, { profileId: profile, cardId: card });
  const candidate = getCandidateProfile(db, profile);
  if (!context || !jobRow || !candidate) {
    throw answerFactError("MESSAGE_DISCOVERY_CONTEXT_INVALID", "message fact context is unavailable", 409);
  }
  const answeredAt = now();
  saveCandidateFact(db, { profileId: profile, factKey: key, factValue: answer, source: "user_provided" });
  const facts = listCandidateFacts(db, profile, { job: { id: jobRow.job_id, sourceId: jobRow.source_id, company: jobRow.company } })
    .filter((fact) => fact.factKey !== key)
    .concat([{ factKey: key, factValue: answer, source: "user_provided", updatedAt: answeredAt }]);
  const savedFact = listCandidateFacts(db, profile).find(fact => fact.factKey === key);
  const originalMessages = context.inboundMessages
    .filter((message) => message.kind === "text" && String(message.text || "").trim())
    .map((message, index) => ({ messageKey: `${groupKey}:${index}`, text: String(message.text) }));
  const requested = deriveRequestedActions({ platform: context.platform, messages: originalMessages, manualActions: context.manualActions });
  const messages = requested.replyMessages;
  const input = {
    platform: context.platform,
    requestedActions: requested.requestedActions,
    ...candidateReplyMaterial(db, profile),
    profile: messageReplyProfile(candidate.profile),
    job: {
      id: Number(jobRow.job_id),
      source: jobRow.source,
      sourceId: jobRow.source_id,
      title: jobRow.title,
      company: jobRow.company,
      salary: jobRow.salary,
      description: jobRow.description,
      analysis: parseObject(jobRow.analysis_json)
    },
    messages,
    facts,
    now: answeredAt
  };
  const quality = await generateQualityCheckedDraft({
    ...buildMessageDraftQualityContext(db, { profileId: profile, job: input.job, messageTexts: messages.map(message => message.text), now: answeredAt }),
    generate: qualityInput => classifyMessageGroup({
      ...input,
      messages: messages.map(message => ({ ...message })),
      ...qualityInput
    }, { signal }),
    shouldAssess: result => !result?.missingFact
  });
  const currentClassification = getMessageGroupClassification(db, { profileId: profile, cardId: card, messageGroupKey: groupKey });
  const currentContext = getMessageInboundContext(db, { profileId: profile, cardId: card, messageGroupKey: groupKey });
  const currentFact = listCandidateFacts(db, profile).find(fact => fact.factKey === key);
  if (signal?.aborted || JSON.stringify(currentClassification) !== JSON.stringify(classification)
    || JSON.stringify(currentContext) !== JSON.stringify(context)
    || JSON.stringify(currentFact) !== JSON.stringify(savedFact)) {
    throw answerFactError("MESSAGE_DISCOVERY_FACT_STALE", "message fact context changed while generating the reply", 409);
  }
  const result = quality.result;
  if (result?.missingFact?.key && result.missingFact.question) {
    updateMessageGroupFactRequest(db, { profileId: profile, cardId: card, messageGroupKey: groupKey, missingFact: result.missingFact });
    return { drafts: [], missingFact: result.missingFact };
  }
  if (!quality.sendable) {
    throw answerFactError("MESSAGE_DISCOVERY_DRAFT_NOT_GENERATED", "reply draft did not pass quality checks after saving the fact", 409);
  }
  const drafts = result?.missingFact || !Array.isArray(result?.messages) || !result.messages.length
    ? []
    : recordMessageReplyDrafts(db, {
      profileId: profile,
      cardId: card,
      jobId: Number(jobRow.job_id),
      messageGroupKey: groupKey,
      questionSummary: result.messageSummary || classification.messageSummary || classification.missingFactQuestion,
      messageIntent: result.messageIntent || classification.messageIntent,
      messageCategory: result.messageCategory || classification.messageCategory,
      messages: result.messages,
      createdAt: answeredAt
    });
  if (!drafts.length) {
    throw answerFactError("MESSAGE_DISCOVERY_DRAFT_NOT_GENERATED", "reply draft was not generated after saving the fact", 409);
  }
  updateMessageGroupFactRequest(db, { profileId: profile, cardId: card, messageGroupKey: groupKey });
  return { drafts };
}

function parseObject(value) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function answerFactError(code, message, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

module.exports = { answerMissingMessageFact };

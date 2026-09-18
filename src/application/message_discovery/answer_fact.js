const { getCandidateProfile, listCandidateFacts } = require("../../storage/candidate_store");
const {
  recordMessageReplyDrafts,
  listCandidateAnswerMemories
} = require("../../storage/message_learning_store");
const {
  getMessageInboundContext
} = require("../../storage/message_reply_send_store");
const {
  getDurableMessageDraftContext,
  getMessageGroupClassification
} = require("../../storage/message_discovery_store");
const { messageReplyProfile } = require("../../core/message_discovery");

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
  const facts = listCandidateFacts(db, profile)
    .filter((fact) => fact.factKey !== key)
    .concat([{ factKey: key, factValue: answer, source: "user_provided", updatedAt: answeredAt }]);
  const answerMemories = listCandidateAnswerMemories(db, {
    profileId: profile,
    activeOnly: true,
    source: "user_edited_reply",
    limit: 100
  });
  const messages = context.inboundMessages
    .filter((message) => message.kind === "text" && String(message.text || "").trim())
    .map((message, index) => ({ messageKey: `${groupKey}:${index}`, text: String(message.text) }));
  const result = await classifyMessageGroup({
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
    answerMemories,
    now: answeredAt
  }, { signal });
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

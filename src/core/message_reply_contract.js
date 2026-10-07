const { VOLATILE_FACT_MAX_AGE_DAYS, factStatus } = require("./candidate_fact_policy");

const MESSAGE_CATEGORIES = new Set([
  "project_fact",
  "qualification",
  "salary",
  "availability",
  "sensitive",
  "other",
  "identity_uncertain"
]);
const MESSAGE_INTENTS = new Set([
  "interview_invitation",
  "interest_check",
  "information_request",
  "information_update",
  "general_communication",
  "rejection",
  "manual_review"
]);
const MANUAL_ONLY_CATEGORIES = new Set([
  "identity_uncertain"
]);
const STABLE_FACT_PREFIXES = ["gap.", "leaving_reason.", "short_project."];
const MAX_DRAFTS = 2;
const SAFE_INTERVIEW_DRAFT = "您好，感谢邀请，请问面试时间和形式如何安排？";

function validateMessageReply(value, context = {}) {
  const normalized = normalizeReply(value);
  const facts = Array.isArray(context.facts) ? context.facts : [];
  const validFacts = new Map(facts.map((fact) => [String(fact.key || ""), fact]));
  const answerMemories = Array.isArray(context.answerMemories) ? context.answerMemories : [];
  const validMemoryIds = new Set(answerMemories.map((memory) => Number(memory?.id)).filter((id) => Number.isSafeInteger(id) && id > 0));
  const now = String(context.now || new Date().toISOString());
  assertIntentShape(normalized);
  assertKnownFactKeys(normalized, facts, now);
  assertCoverageComplete(normalized);
  assertDraftLimit(normalized.messages, MAX_DRAFTS);
  assertManualOnlyHasNoDraft(normalized);
  assertDraftChannelSafe(normalized.messages, context);
  assertDraftDoesNotDuplicateAction(normalized.messages, context.requestedActions);
  for (const key of normalized.usedFactKeys) {
    const fact = validFacts.get(key);
    if (!fact) {
      throw contractError("MESSAGE_REPLY_FACT_NOT_SUPPLIED", `used fact ${key} is not in the supplied valid fact set`);
    }
    if (isStableFactKey(key)
      && (!stableFactMatchesScope(key, fact) || !requestedSubjectMatches(key, context))) {
      throw contractError("MESSAGE_REPLY_FACT_UNVERIFIED", `used stable fact ${key} is outside the requested subject scope`);
    }
    if (factStatus(now, fact).status !== "valid") {
      throw contractError("MESSAGE_REPLY_FACT_UNVERIFIED", `used fact ${key} is missing, expired, or unverified`);
    }
  }
  const requiredStates = normalized.requiredFactKeys.map((key) => {
    const fact = validFacts.get(key);
    if (!fact) return { key, status: "missing" };
    if (isStableFactKey(key) && !stableFactMatchesScope(key, fact)) {
      return { key, status: "missing" };
    }
    if (isStableFactKey(key) && !requestedSubjectMatches(key, context)) {
      return { key, status: "missing" };
    }
    return { key, status: factStatus(now, fact).status };
  });
  const unverified = requiredStates.filter((item) => item.status !== "valid");
  if (unverified.length && normalized.messages.length) {
    throw contractError("MESSAGE_REPLY_FACT_UNVERIFIED", "cannot draft while a required fact is missing or expired");
  }
  for (const memoryId of normalized.usedMemoryIds) {
    if (!validMemoryIds.has(memoryId)) {
      throw contractError("MESSAGE_REPLY_MEMORY_NOT_SUPPLIED", `used answer memory ${memoryId} is not in the supplied active memory set`);
    }
  }
  const evidenceIds = new Set((context.candidateEvidence || []).filter(item => !item.withdrawnAt).map(item => Number(item.id)));
  for (const evidenceId of normalized.usedEvidenceIds) {
    if (!evidenceIds.has(evidenceId)) throw contractError('MESSAGE_REPLY_EVIDENCE_NOT_SUPPLIED', 'reply cited unavailable candidate evidence');
  }
  const safeStage = safeReplyStage(normalized);
  const messages = MANUAL_ONLY_CATEGORIES.has(normalized.messageCategory)
    || normalized.messageIntent === "manual_review"
    || normalized.messageIntent === "rejection"
    ? []
    : normalized.messageIntent === "interview_invitation" && !normalized.messages.length && !normalized.missingFact
      && !unverified.length && normalized.messageCategory === 'other' && !normalized.responseItems.length
      ? [SAFE_INTERVIEW_DRAFT]
      : normalized.messages;
  return {
    ...normalized,
    messageSummary: safeMessageSummary(normalized, context),
    messages,
    progressUpdate: {
      stage: safeStage,
      nextAction: safeReplyNextAction(safeStage)
    }
  };
}

function normalizeReply(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw contractError("MESSAGE_REPLY_INVALID", "message reply must be an object");
  }
  const messageIntent = String(value.messageIntent || "").trim();
  if (!MESSAGE_INTENTS.has(messageIntent)) {
    throw contractError("MESSAGE_REPLY_INTENT_INVALID", "message intent is invalid");
  }
  const messageCategory = String(value.messageCategory || "").trim();
  if (!MESSAGE_CATEGORIES.has(messageCategory)) {
    throw contractError("MESSAGE_REPLY_CATEGORY_INVALID", "message category is invalid");
  }
  const messageSummary = normalizedMessageSummary(value.messageSummary);
  const requiredFactKeys = stringArray(value.requiredFactKeys, "requiredFactKeys");
  const usedFactKeys = stringArray(value.usedFactKeys, "usedFactKeys");
  const usedMemoryIds = positiveIntegerArray(value.usedMemoryIds);
  const responseItems = arrayValue(value.responseItems, "responseItems").map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw contractError("MESSAGE_REPLY_INVALID", "response item must be an object");
    }
    const id = String(item.id || "").trim();
    const kind = String(item.kind || "").trim();
    if ((!isKnownFactKey(id) && !/^[a-z][a-z0-9_.-]{0,79}$/i.test(id)) || !["question", "statement"].includes(kind)) {
      throw contractError("MESSAGE_REPLY_INVALID", `response item ${index} is invalid`);
    }
    return { id, kind, required: Boolean(item.required) };
  });
  const coverage = arrayValue(value.coverage, "coverage").map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw contractError("MESSAGE_REPLY_INVALID", "coverage item must be an object");
    }
    return {
      responseItemId: String(item.responseItemId || "").trim(),
      covered: Boolean(item.covered)
    };
  });
  const messages = arrayValue(value.messages, "messages").map((item, index) => {
    const text = String(item == null ? "" : item).trim();
    if (!text) throw contractError("MESSAGE_REPLY_INVALID", `message ${index} is empty`);
    return text;
  });
  const missingFact = normalizedMissingFact(value.missingFact);
  if (missingFact && messages.length) {
    throw contractError("MESSAGE_REPLY_INVALID", "missingFact and messages cannot both be present");
  }
  return {
    messageIntent,
    messageCategory,
    messageSummary,
    requiredFactKeys,
    usedFactKeys,
    usedMemoryIds,
    usedEvidenceIds: value.usedEvidenceIds == null ? [] : arrayValue(value.usedEvidenceIds, 'usedEvidenceIds').map(Number),
    ...(value.responseStrategy && typeof value.responseStrategy === 'object' ? { responseStrategy: {
      concern: String(value.responseStrategy.concern || '').trim().slice(0, 300),
      focus: String(value.responseStrategy.focus || '').trim().slice(0, 300)
    } } : {}),
    responseItems,
    coverage,
    missingFact,
    messages
  };
}

function normalizedMissingFact(value) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw contractError("MESSAGE_REPLY_INVALID", "missingFact must be null or an object");
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "key" || keys[1] !== "question"
      || typeof value.key !== "string" || typeof value.question !== "string") {
    throw contractError("MESSAGE_REPLY_INVALID", "missingFact must contain only key and question strings");
  }
  const key = value.key.trim();
  const question = value.question.trim();
  if (!key || !question) {
    throw contractError("MESSAGE_REPLY_INVALID", "missingFact must contain key and question");
  }
  return { key, question };
}

function assertIntentShape(normalized) {
  if (normalized.messageIntent !== "interest_check"
      || MANUAL_ONLY_CATEGORIES.has(normalized.messageCategory)) return;
  if (normalized.missingFact
      || normalized.requiredFactKeys.length
      || normalized.responseItems.length
      || normalized.coverage.length
      || normalized.messages.length === 0) {
    throw contractError("MESSAGE_REPLY_INVALID", "interest check must contain a direct draft without missing facts");
  }
}

function normalizedMessageSummary(value) {
  if (typeof value !== "string") {
    throw contractError("MESSAGE_REPLY_SUMMARY_INVALID", "messageSummary must be a string");
  }
  const summary = value.replace(/\s+/g, " ").trim();
  if (!summary || summary.length > 160) {
    throw contractError("MESSAGE_REPLY_SUMMARY_INVALID", "messageSummary must contain 1 to 160 characters");
  }
  return summary;
}

function assertKnownFactKeys(normalized, facts, now) {
  const userFacts = new Map(facts.filter((fact) => fact.source === "user_provided"
    && factStatus(now, fact).status === "valid").map((fact) => [String(fact.key || ""), fact]));
  const unansweredKey = normalized.missingFact?.key;
  const canAskForUnansweredKey = !normalized.messages.length
    && normalized.requiredFactKeys.includes(unansweredKey)
    && normalized.responseItems.some((item) => item.required && normalized.coverage.some(
      (entry) => entry.responseItemId === item.id && !entry.covered));
  // Response item IDs name HR questions; only fact key fields claim candidate facts.
  const ids = [
    ...normalized.requiredFactKeys,
    ...normalized.usedFactKeys,
    ...(normalized.missingFact ? [normalized.missingFact.key] : [])
  ];
  for (const id of ids) {
    if (!isKnownFactKey(id) && !(/^[a-z][a-z0-9_.-]{0,79}$/i.test(id)
      && (userFacts.has(id) || (unansweredKey === id && canAskForUnansweredKey)))) {
      throw contractError("MESSAGE_REPLY_UNKNOWN_FACT", `unknown fact key ${id}`);
    }
  }
}

function assertCoverageComplete(normalized) {
  const responseIds = new Set(normalized.responseItems.map((item) => item.id));
  for (const entry of normalized.coverage) {
    if (!responseIds.has(entry.responseItemId)) {
      throw contractError("MESSAGE_REPLY_COVERAGE_INVALID", "coverage references an unknown response item");
    }
  }
  for (const item of normalized.responseItems) {
    const entry = normalized.coverage.find((candidate) => candidate.responseItemId === item.id);
    if (!entry) throw contractError("MESSAGE_REPLY_COVERAGE_INVALID", `response item ${item.id} has no coverage`);
    if (item.required && !entry.covered && normalized.messages.length) {
      throw contractError("MESSAGE_REPLY_COVERAGE_INCOMPLETE", "required response item is not covered");
    }
  }
}

function assertDraftLimit(messages, limit) {
  if (messages.length > limit) {
    throw contractError("MESSAGE_REPLY_DRAFT_LIMIT", `at most ${limit} drafts are allowed`);
  }
}

function assertManualOnlyHasNoDraft(normalized) {
  const manualOnly = MANUAL_ONLY_CATEGORIES.has(normalized.messageCategory)
    || normalized.messageIntent === "manual_review";
  if (!manualOnly || !normalized.messages.length) return;
  throw contractError("MESSAGE_REPLY_MANUAL_ONLY", "this message category requires manual handling");
}

function assertDraftChannelSafe(messages, context = {}) {
  const platform = String(context.platform || "").toLowerCase();
  if (!["boss", "zhaopin"].includes(platform)) return;
  const source = (Array.isArray(context.sourceMessages) ? context.sourceMessages : [])
    .map((item) => String(item || "").toLowerCase()).join(" ");
  const channels = [
    { name: "email", pattern: /邮箱|邮件|e-?mail|@[a-z0-9.-]+\.[a-z]{2,}/i },
    { name: "wechat", pattern: /微信|wechat|wx/i },
    { name: "qq", pattern: /(?:^|[^a-z])qq(?:[^a-z]|$)/i }
  ];
  for (const channel of channels) {
    if (channel.pattern.test(source)) continue;
    if (messages.some((message) => {
      const text = String(message || "");
      if (!channel.pattern.test(text)) return false;
      // A channel mentioned in skills or past work is not a request to move this conversation.
      return text.split(/[。！？!?；;\n]/).some((sentence) => channel.pattern.test(sentence) && (
        /@[a-z0-9.-]+\.[a-z]{2,}/i.test(sentence)
        || /(?:请|麻烦|能否|能不能|方便|可以).{0,16}(?:给|提供|告诉|留|发).{0,12}(?:邮箱|邮件|微信|wechat|e-?mail|qq)/i.test(sentence)
        || /(?:邮箱|邮件|微信|wechat|e-?mail|qq).{0,12}(?:给我|发我|发给我|是什么|多少)/i.test(sentence)
        || /(?:加|添加|交换|留个|留一下).{0,8}(?:微信|wechat|qq|邮箱)/i.test(sentence)
        || /(?:邮箱|邮件|微信|wechat|e-?mail|qq).{0,24}(?:发给您|发给你|发您|发你|发送给您|发送给你|给您发|给你发|联系您|联系你|与您沟通|和您沟通|联系吧|沟通吧|联系我)/i.test(sentence)
        || /(?:简历|履历|资料|材料).{0,20}(?:发到|发送到|寄到|发至|发送至).{0,12}(?:邮箱|邮件|微信|wechat|e-?mail|qq)/i.test(sentence)
        || /(?:我会|我将|稍后|接下来).{0,12}(?:邮箱|邮件|微信|wechat|e-?mail|qq).{0,12}(?:发送|发过去|发给|联系您|联系你)/i.test(sentence)
        || /(?:send|sending).{0,20}(?:resume|cv|materials).{0,20}(?:email|wechat|qq)|(?:email|wechat).{0,8}(?:you|me)|(?:add|contact).{0,12}(?:wechat|qq)/i.test(sentence)
      ));
    })) {
      throw contractError("MESSAGE_REPLY_CHANNEL_UNSUPPORTED", `draft invented unsupported ${channel.name} channel`);
    }
  }
}

function assertDraftDoesNotDuplicateAction(messages, requestedActions) {
  const resumeAction = Array.isArray(requestedActions)
    && requestedActions.some((item) => item?.kind === "resume_request");
  if (!resumeAction) return;
  const duplicatesResumeSend = messages.some((message) => {
    const text = String(message || "").replace(/\s+/g, "");
    return /(?:简历|履历)/.test(text) && /(?:发|发送|分享|提供|上传|投递|提交)/.test(text);
  });
  if (duplicatesResumeSend) {
    throw contractError("MESSAGE_REPLY_ACTION_DUPLICATED", "draft duplicated the platform resume action");
  }
}

function safeMessageSummary(normalized, context) {
  const { messageIntent, messageCategory, messageSummary } = normalized;
  if (messageIntent === "rejection") return "招聘方已明确结束本次机会。";
  const sourceMessages = Array.isArray(context.sourceMessages) ? context.sourceMessages : [];
  const repeatsSource = sourceMessages.some((text) => String(text || '').replace(/\s+/g, ' ').trim() === messageSummary);
  if (!repeatsSource) return messageSummary;
  if (messageIntent === "interview_invitation") return "对方正式邀请候选人参加面试。";
  if (messageIntent === "interest_check") return "对方正在询问候选人是否愿意了解或继续沟通该岗位。";
  if (messageIntent === "information_update") return "对方正在补充当前岗位、项目或流程信息。";
  if (messageIntent === "general_communication") return "对方正在进行普通沟通。";
  if (messageIntent === "manual_review") return "这条消息暂时无法可靠判断，需要人工确认。";
  return {
    project_fact: "对方正在确认候选人的项目经历。",
    qualification: "对方正在确认候选人的任职资格。",
    salary: "对方正在沟通薪资信息。",
    availability: "对方正在确认候选人的工作状态、时间或安排。",
    sensitive: "对方正在询问敏感个人信息。",
    identity_uncertain: "当前消息对应的岗位身份仍不明确。",
    other: "对方正在确认候选人的相关信息。"
  }[messageCategory] || "对方正在进行岗位沟通。";
}

function safeReplyStage(normalized) {
  if (normalized.messageIntent === "interview_invitation") return "interview_invited";
  if (normalized.messageIntent === "rejection") return "rejected";
  if (normalized.messageIntent === "manual_review") return "needs_user_action";
  return normalized.messages.length ? "reply_ready" : "needs_user_action";
}

function safeReplyNextAction(stage) {
  if (stage === "rejected") return "";
  return {
    contact_started: "Review communication status",
    waiting_reply: "Wait for recruiter reply",
    needs_user_action: "Provide required information",
    reply_ready: "Review draft before manual send",
    interview_invited: "Review interview invitation",
    interview_scheduled: "Review interview schedule",
    interview_completed: "Wait for interview outcome",
    offer_received: "Review offer details",
    resume_submitted: "Wait for recruiter reply",
    withdrawn: "Opportunity withdrawn",
    rejected: "Opportunity rejected",
    closed: "Opportunity closed"
  }[stage] || "Review next step";
}

function isKnownFactKey(key) {
  return Object.hasOwn(VOLATILE_FACT_MAX_AGE_DAYS, key) || isStableFactKey(key);
}

function isStableFactKey(key) {
  return STABLE_FACT_PREFIXES.some((prefix) => String(key || "").startsWith(prefix));
}

function stableFactMatchesScope(key, fact) {
  const subject = stableSubjectFromKey(key);
  return String(fact.key || "") === key
    || String(fact.subjectKey || "") === subject;
}

function requestedSubjectMatches(key, context) {
  const requestedSubjects = Array.isArray(context.requestedSubjectKeys)
    ? context.requestedSubjectKeys
    : [];
  if (!requestedSubjects.length) return false;
  return requestedSubjects.some((subject) => String(subject) === stableSubjectFromKey(key));
}

function stableSubjectFromKey(key) {
  return String(key || "").split(".").slice(1).join(".");
}

function stringArray(value, name) {
  if (!Array.isArray(value)) throw contractError("MESSAGE_REPLY_INVALID", `${name} must be an array`);
  return value.map((item) => String(item == null ? "" : item).trim()).filter(Boolean);
}

function arrayValue(value, name) {
  if (!Array.isArray(value)) throw contractError("MESSAGE_REPLY_INVALID", `${name} must be an array`);
  return value;
}

function positiveIntegerArray(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw contractError("MESSAGE_REPLY_INVALID", "usedMemoryIds must be an array");
  const result = [];
  const seen = new Set();
  for (const item of value) {
    const id = Number(item);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw contractError("MESSAGE_REPLY_INVALID", "usedMemoryIds must contain positive integers");
    }
    if (!seen.has(id)) result.push(id);
    seen.add(id);
  }
  return result;
}

function contractError(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = {
  MESSAGE_CATEGORIES,
  MESSAGE_INTENTS,
  MANUAL_ONLY_CATEGORIES,
  MAX_DRAFTS,
  isKnownFactKey,
  validateMessageReply
};

const coreDiscovery = require("../../core/message_discovery");
const { candidateReplyMaterial } = require('./materials');
const messageInbox = require("../message_inbox");
const messageTimeline = require("../../storage/message_timeline_store");
const { getJob } = require("../../storage/job_store");
const { getBatch } = require("../../storage/scan_store");
const { hasSentReplyForMessageGroup } = require("../../storage/message_reply_send_store");
const { getProgressCardById } = require("../../core/candidate_progress");
const { isClearlyUnmatchedMessageJob } = require("../../core/message_routing_policy");
const { deriveRequestedActions, RESUME_REQUEST_ACKNOWLEDGEMENT } = require("../../core/message_requested_actions");
const { listMessageInboundContexts } = require("../../storage/message_reply_send_store");
const { listOpenMessageReplyDrafts, replaceUneditedMessageReplyDraft } = require("../../storage/message_learning_store");
const {
  generateQualityCheckedDraft,
  buildMessageDraftQualityContext
} = require("../message_draft_quality");

function isClearlyUnmatchedMessageCard(db, { profileId, cardId, jobId } = {}) {
  if (!Number.isInteger(Number(cardId)) || Number(cardId) <= 0) return false;
  const card = getProgressCardById(db, cardId);
  if (!card || (profileId && card.profileId !== Number(profileId)) || (jobId && card.jobId !== Number(jobId))) return false;
  const job = getJob(db, card.jobId);
  const batch = getBatch(db, job?.batchId);
  if (!batch || batch.profileId !== card.profileId || batch.searchPlanId !== card.planId) return false;
  return isClearlyUnmatchedMessageJob(job);
}

async function runBossMessageDiscovery(options = {}) {
  reconcileResumeInvitationDrafts(options.db, options);
  return coreDiscovery.runBossMessageDiscovery({
    ...options,
    classifyMessageGroup: typeof options.classifyMessageGroup === 'function'
      ? (input, runtime) => options.classifyMessageGroup({ ...input, ...candidateReplyMaterial(options.db, options.profileId) }, runtime)
      : options.classifyMessageGroup,
    messageInbox: options.messageInbox || messageInbox,
    messageTimeline: options.messageTimeline || messageTimeline,
    hasSentReplyForMessageGroup,
    isUnmatchedCard: options.isUnmatchedCard || isClearlyUnmatchedMessageCard,
    qualityCheckDraft: options.qualityCheckDraft || qualityCheckDraft
  });
}

function reconcileResumeInvitationDrafts(db, { profileId, platform = "boss" } = {}) {
  const contexts = listMessageInboundContexts(db, { profileId, limit: 500 })
    .filter(context => context.platform === platform);
  const drafts = listOpenMessageReplyDrafts(db, { profileId, limit: 500 });
  for (const context of contexts) {
    const requested = deriveRequestedActions({ platform, messages: context.inboundMessages
      .filter(message => message.kind === "text"), manualActions: context.manualActions });
    if (!requested.requestedActions.length || requested.replyMessages.length) continue;
    for (const draft of drafts.filter(draft => draft.cardId === context.cardId && draft.messageGroupKey === context.messageGroupKey)) {
      replaceUneditedMessageReplyDraft(db, { profileId, draftId: draft.id, text: RESUME_REQUEST_ACKNOWLEDGEMENT });
    }
  }
}

function qualityCheckDraft({ db, profileId, job, messageTexts, generate, shouldAssess }) {
  return generateQualityCheckedDraft({
    generate,
    shouldAssess,
    ...buildMessageDraftQualityContext(db, { profileId, job, messageTexts })
  });
}

module.exports = {
  ...coreDiscovery,
  runBossMessageDiscovery,
  reconcileResumeInvitationDrafts,
  isClearlyUnmatchedMessageCard
};

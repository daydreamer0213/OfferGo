const coreDiscovery = require("../../core/message_discovery");
const messageInbox = require("../message_inbox");
const messageTimeline = require("../../storage/message_timeline_store");
const { getJob } = require("../../storage/job_store");
const { getBatch } = require("../../storage/scan_store");
const { getProgressCardById } = require("../../core/candidate_progress");
const { isClearlyUnmatchedMessageJob } = require("../../core/message_routing_policy");

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
  return coreDiscovery.runBossMessageDiscovery({
    ...options,
    messageInbox: options.messageInbox || messageInbox,
    messageTimeline: options.messageTimeline || messageTimeline,
    isUnmatchedCard: options.isUnmatchedCard || isClearlyUnmatchedMessageCard
  });
}

module.exports = {
  ...coreDiscovery,
  runBossMessageDiscovery,
  isClearlyUnmatchedMessageCard
};

const { findExactIdentityCandidates, getPersistedCardJobIdentity,
  getLatestInboundContextIdentity, getDurableMessageDraftContext,
  getMessageGroupClassification } = require("../../storage/message_discovery_store");
const { messageReplyDraftExists, messageReplyDraftGroupExists,
  hasOpenMessageReplyDraft } = require("../../storage/message_learning_store");
const { hasBlockingReplySendItemForCard } = require("../../storage/message_reply_send_store");

module.exports = {
  findExactIdentityCandidates,
  getPersistedCardJobIdentity,
  getLatestInboundContextIdentity,
  getDurableMessageDraftContext,
  getMessageGroupClassification,
  messageReplyDraftExists,
  messageReplyDraftGroupExists,
  hasOpenMessageReplyDraft,
  hasBlockingReplySendItemForCard
};

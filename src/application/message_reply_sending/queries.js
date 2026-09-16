const { getActiveMessageReplySendBatch, getLatestMessageReplySendBatch,
  listActiveMessageReplySendBatches, getMessageReplySendBatchOwner } = require("../../storage/message_reply_send_store");

module.exports = {
  getActiveMessageReplySendBatch,
  getLatestMessageReplySendBatch,
  listActiveMessageReplySendBatches,
  getMessageReplySendBatchOwner
};

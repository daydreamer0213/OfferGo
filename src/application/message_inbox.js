const messageInboxStore = require("../storage/message_inbox_store");

module.exports = {
  upsertMessageInboxItem: messageInboxStore.upsertMessageInboxItem,
  getMessageInboxItem: messageInboxStore.getMessageInboxItem,
  listMessageInboxItems: messageInboxStore.listMessageInboxItems,
  markMessageInboxItemDone: messageInboxStore.markMessageInboxItemDone,
  getMessageInboxSyncState: messageInboxStore.getMessageInboxSyncState,
  saveMessageInboxSyncState: messageInboxStore.saveMessageInboxSyncState
};

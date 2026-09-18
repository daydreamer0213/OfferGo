const messageInboxStore = require("../storage/message_inbox_store");
const messageTimelineStore = require("../storage/message_timeline_store");

module.exports = {
  upsertMessageInboxItem: messageInboxStore.upsertMessageInboxItem,
  getMessageInboxItem: messageInboxStore.getMessageInboxItem,
  listMessageInboxItems: messageInboxStore.listMessageInboxItems,
  markMessageInboxItemDone: messageInboxStore.markMessageInboxItemDone,
  deleteMessageInboxItem: messageInboxStore.deleteMessageInboxItem,
  getMessageInboxSyncState: messageInboxStore.getMessageInboxSyncState,
  saveMessageInboxSyncState: messageInboxStore.saveMessageInboxSyncState,
  listMessageEvents: messageTimelineStore.listMessageEvents,
  latestMessageEvent: messageTimelineStore.latestMessageEvent
};

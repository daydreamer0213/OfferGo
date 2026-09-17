const coreDiscovery = require("../../core/message_discovery");
const messageInbox = require("../message_inbox");
const messageTimeline = require("../../storage/message_timeline_store");

async function runBossMessageDiscovery(options = {}) {
  return coreDiscovery.runBossMessageDiscovery({
    ...options,
    messageInbox: options.messageInbox || messageInbox,
    messageTimeline: options.messageTimeline || messageTimeline
  });
}

module.exports = {
  ...coreDiscovery,
  runBossMessageDiscovery
};

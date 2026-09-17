const coreDiscovery = require("../../core/message_discovery");
const messageInbox = require("../message_inbox");

async function runBossMessageDiscovery(options = {}) {
  return coreDiscovery.runBossMessageDiscovery({
    ...options,
    messageInbox: options.messageInbox || messageInbox
  });
}

module.exports = {
  ...coreDiscovery,
  runBossMessageDiscovery
};

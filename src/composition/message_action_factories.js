const { createZhaopinMessageReader } = require("../adapters/sites/zhaopin_message_reader");
const { createZhaopinMessageActionSender } = require("../adapters/sites/zhaopin_message_action_sender");
const { createBossMessageReader } = require("../adapters/sites/boss_message_reader");
const { createBossMessageActionSender } = require("../adapters/sites/boss_message_action_sender");

function createPlatformMessageReader({ browser, platform }) {
  return platform === "boss"
    ? createBossMessageReader({ browser })
    : createZhaopinMessageReader({ browser });
}

function createPlatformMessageActionSender({ browser, reader, platform }) {
  return platform === "boss"
    ? createBossMessageActionSender({ browser, reader })
    : createZhaopinMessageActionSender({ browser, reader });
}

module.exports = { createPlatformMessageReader, createPlatformMessageActionSender };

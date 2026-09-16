const { MockModelAdapter } = require("./mock");
const { OpenAICompatibleAdapter } = require("./openai_compatible");
const { AgentStdioAdapter } = require("./agent_stdio");

let sharedAgentStdioTransport = null;

function createModelAdapter(modelConfig = {}, options = {}) {
  const provider = modelConfig.provider || "mock";
  const providerConfig = modelConfig.providers?.[provider] || {};
  if (provider === "mock") return new MockModelAdapter({ ...providerConfig, logger: options.logger });
  if (provider === "openai_compatible") return new OpenAICompatibleAdapter({ ...providerConfig, logger: options.logger });
  if (provider === "agent_stdio") {
    if (!sharedAgentStdioTransport) {
      const adapter = new AgentStdioAdapter({ ...providerConfig, logger: options.logger });
      sharedAgentStdioTransport = adapter.transport;
      return adapter;
    }
    return new AgentStdioAdapter({ ...providerConfig, transport: sharedAgentStdioTransport, logger: options.logger });
  }
  throw new Error(`未知模型 provider：${provider}`);
}

function closeAgentStdioTransport() {
  sharedAgentStdioTransport?.close?.();
  sharedAgentStdioTransport = null;
}

module.exports = {
  createModelAdapter,
  closeAgentStdioTransport,
  MockModelAdapter,
  OpenAICompatibleAdapter,
  AgentStdioAdapter
};

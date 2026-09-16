const { MockModelAdapter } = require("./mock");
const { OpenAICompatibleAdapter } = require("./openai_compatible");
const { StructuredModelAdapter } = require("./structured");
const { AgentCommandTransport } = require("./agent_command_transport");
const { getAgentRunner } = require("./agent_runner_registry");

function createModelAdapter(modelConfig = {}, options = {}) {
  const provider = modelConfig.provider || "mock";
  const providerConfig = modelConfig.providers?.[provider] || {};
  if (provider === "mock") return new MockModelAdapter({ ...providerConfig, logger: options.logger });
  if (provider === "openai_compatible") return new OpenAICompatibleAdapter({ ...providerConfig, logger: options.logger });
  if (provider === "agent_command") {
    const runner = getAgentRunner(providerConfig.runnerId);
    const commandSpec = runner.commandSpec({
      capabilityFingerprint: providerConfig.capabilityFingerprint,
      runnerVersion: providerConfig.runnerVersion
    });
    const transport = new AgentCommandTransport({
      ...commandSpec,
      ...providerConfig,
      runnerId: runner.id,
      logger: options.logger
    });
    return new StructuredModelAdapter({
      transport,
      provider: "agent_command",
      model: providerConfig.model || runner.id,
      thinkingMode: providerConfig.thinkingMode,
      reasoningEffort: providerConfig.reasoningEffort,
      logger: options.logger
    });
  }
  throw new Error(`未知模型 provider：${provider}`);
}

module.exports = { createModelAdapter, MockModelAdapter, OpenAICompatibleAdapter, StructuredModelAdapter };

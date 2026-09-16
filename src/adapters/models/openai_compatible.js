const { StructuredModelAdapter } = require("./structured");
const { OpenAICompatibleTransport, extractContent, parseJsonContent } = require("./openai_transport");

class OpenAICompatibleAdapter extends StructuredModelAdapter {
  constructor(config = {}) {
    const transport = new OpenAICompatibleTransport(config);
    super({
      transport,
      provider: transport.provider,
      model: transport.model,
      thinkingMode: transport.thinkingMode,
      reasoningEffort: transport.reasoningEffort,
      logger: transport.logger
    });
    const defaultRequestJson = transport.requestHttpJson.bind(transport);
    this.requestJson = defaultRequestJson;
    transport.requestHttpJson = (request) => this.requestJson(request);
    for (const key of [
      "baseUrl", "apiKey", "apiKeyEnv", "timeoutMs", "maxRetries", "jsonMode",
      "temperature", "maxTokens", "thinkingMode", "reasoningEffort"
    ]) {
      delete this[key];
      Object.defineProperty(this, key, {
        configurable: true,
        enumerable: true,
        get: () => transport[key],
        set: (value) => { transport[key] = value; }
      });
    }
  }
}

module.exports = { OpenAICompatibleAdapter, extractContent, parseJsonContent };

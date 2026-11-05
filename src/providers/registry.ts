import type { SutraConfig } from "../config/schema.js";
import { DeepSeekProvider } from "./deepseek/provider.js";
import type { ModelProvider } from "./types.js";

/**
 * Provider plugin interface. A factory receives the resolved config and
 * returns a ModelProvider. New providers (OpenAI-compatible, Anthropic,
 * Ollama, ...) register here without touching the agent runtime.
 */
export type ProviderFactory = (config: SutraConfig) => ModelProvider;

const factories = new Map<string, ProviderFactory>();

export function registerProvider(id: string, factory: ProviderFactory): void {
  factories.set(id, factory);
}

export function listProviders(): string[] {
  return [...factories.keys()];
}

export function createProvider(config: SutraConfig): ModelProvider {
  const factory = factories.get(config.provider);
  if (!factory) throw new Error(`Unknown provider "${config.provider}". Available: ${listProviders().join(", ")}`);
  return factory(config);
}

registerProvider("deepseek", (config) => {
  const ds = config.providers.deepseek;
  return new DeepSeekProvider({
    apiKey: ds.apiKey ?? "",
    baseUrl: ds.baseUrl,
    timeoutMs: ds.timeoutMs,
    models: ds.models,
  });
});

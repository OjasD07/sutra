import type { SutraConfig } from "../config/schema.js";
import { DeepSeekProvider } from "./deepseek/provider.js";
import { OpenAICompatibleProvider } from "./openai-compatible/provider.js";
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

registerProvider("openai-compatible", (config) => {
  const o = config.providers.openai;
  return new OpenAICompatibleProvider({
    id: "openai-compatible",
    displayName: "OpenAI-compatible",
    ...(o.apiKey ? { apiKey: o.apiKey } : {}),
    baseUrl: o.baseUrl,
    dialect: "openai",
    freeOfCharge: o.freeOfCharge,
    defaultContextWindow: o.contextWindow,
    models: o.models,
    ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
  });
});

registerProvider("ollama", (config) => {
  const o = config.providers.ollama;
  return new OpenAICompatibleProvider({
    id: "ollama",
    displayName: "Ollama",
    baseUrl: o.baseUrl,
    dialect: "openai",
    freeOfCharge: true,
    defaultContextWindow: o.contextWindow,
    models: o.models,
    // Local models can take a while to load on first use.
    timeoutMs: o.timeoutMs ?? 30 * 60_000,
    idleTimeoutMs: 10 * 60_000,
  });
});

/** Whether the configured provider needs an API key before it can start. */
export function providerNeedsKey(config: SutraConfig): { needed: boolean; envVar?: string } {
  if (config.provider === "deepseek") return { needed: !config.providers.deepseek.apiKey, envVar: "DEEPSEEK_API_KEY" };
  if (config.provider === "openai-compatible") {
    const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/)/.test(config.providers.openai.baseUrl);
    return { needed: !local && !config.providers.openai.apiKey, envVar: "OPENAI_API_KEY" };
  }
  return { needed: false };
}

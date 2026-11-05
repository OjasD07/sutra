import type { SutraConfig } from "../config/schema.js";
import { DeepSeekProvider } from "./deepseek/provider.js";
import { OpenAICompatibleProvider } from "./openai-compatible/provider.js";
import type { ModelProvider } from "./types.js";
import { PROVIDERS, findPreset, isLocalUrl, presetConfigKey, type ProviderPreset } from "./catalog.js";
import type { EndpointConfig } from "../config/schema.js";

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

/** The settings section for a catalog provider, with the catalog's defaults filled in. */
export function endpointFor(config: SutraConfig, preset: ProviderPreset): EndpointConfig & { baseUrl: string } {
  const section = ((config.providers as Record<string, unknown>)[presetConfigKey(preset)] ?? {}) as EndpointConfig;
  return { ...section, models: section.models ?? {}, baseUrl: section.baseUrl ?? preset.baseUrl };
}

// Every other catalog provider is an OpenAI-compatible endpoint with its own defaults.
for (const preset of PROVIDERS) {
  if (factories.has(preset.id)) continue;
  registerProvider(preset.id, (config) => {
    const e = endpointFor(config, preset);
    if (!e.baseUrl) throw new Error(`No URL configured for ${preset.name}. Run \`sutra init\`, or set providers.${presetConfigKey(preset)}.baseUrl in ~/.sutra/config.json.`);
    const local = preset.local || isLocalUrl(e.baseUrl);
    return new OpenAICompatibleProvider({
      id: preset.id,
      displayName: preset.name,
      baseUrl: e.baseUrl,
      dialect: "openai",
      ...(e.apiKey ? { apiKey: e.apiKey } : {}),
      freeOfCharge: e.freeOfCharge ?? local,
      models: e.models,
      ...(e.contextWindow ?? preset.contextWindow ? { defaultContextWindow: e.contextWindow ?? preset.contextWindow } : {}),
      ...(preset.headers || e.headers ? { headers: { ...(preset.headers ?? {}), ...(e.headers ?? {}) } } : {}),
      // Local models can take a while to load on first use.
      ...(e.timeoutMs ? { timeoutMs: e.timeoutMs } : local ? { timeoutMs: 30 * 60_000, idleTimeoutMs: 10 * 60_000 } : {}),
    });
  });
}

/** Whether the configured provider needs an API key before it can start. */
export function providerNeedsKey(config: SutraConfig): { needed: boolean; envVar?: string } {
  if (config.provider === "deepseek") return { needed: !config.providers.deepseek.apiKey, envVar: "DEEPSEEK_API_KEY" };
  if (config.provider === "openai-compatible") return { needed: !isLocalUrl(config.providers.openai.baseUrl) && !config.providers.openai.apiKey, envVar: "OPENAI_API_KEY" };
  if (config.provider === "ollama") return { needed: false };
  const preset = findPreset(config.provider);
  if (!preset) return { needed: false };
  const e = endpointFor(config, preset);
  const local = preset.local || isLocalUrl(e.baseUrl);
  return { needed: !local && !e.apiKey && preset.id !== "custom", ...(preset.keyEnv ? { envVar: preset.keyEnv } : {}) };
}

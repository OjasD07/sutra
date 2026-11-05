import type { ModelInfo } from "../types.js";

/**
 * Known DeepSeek models, taken from https://api-docs.deepseek.com/quick_start/pricing
 * and GET /models on 2026-11-05. This is a default, not a source of truth:
 * entries can be overridden or added via `providers.deepseek.models` in the
 * user config, and `sutra init` checks GET /models for the live list.
 */
export const DEEPSEEK_MODELS_AS_OF = "2026-11-05";

export const DEEPSEEK_MODELS: Record<string, ModelInfo> = {
  "deepseek-flash": {
    id: "deepseek-flash",
    contextWindow: 1_048_576,
    maxOutputTokens: 393_216,
    defaultOutputTokens: 32_768,
    supportsTools: true,
    supportsThinking: true,
    thinkingSupportsTools: true,
    supportsVision: true,
  },
  "deepseek-v4-pro": {
    id: "deepseek-v4-pro",
    contextWindow: 1_048_576,
    maxOutputTokens: 393_216,
    defaultOutputTokens: 32_768,
    supportsTools: true,
    supportsThinking: true,
    thinkingSupportsTools: true,
    supportsVision: false,
  },
};

export const DEFAULT_DEEPSEEK_MODEL = "deepseek-flash";

/** Conservative defaults for a model id Sutra has no metadata for. */
export function fallbackModelInfo(id: string): ModelInfo {
  return {
    id,
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    defaultOutputTokens: 8_192,
    supportsTools: true,
    supportsThinking: false,
    thinkingSupportsTools: false,
    supportsVision: false,
  };
}

import { ProviderError } from "../errors.js";
import { OpenAICompatibleProvider } from "../openai-compatible/provider.js";
import type { ModelInfo } from "../types.js";
import { DEEPSEEK_MODELS } from "./models.js";

export interface DeepSeekOptions {
  apiKey: string;
  baseUrl?: string;
  /** Per-request timeout covering connection and the whole stream. */
  timeoutMs?: number;
  /** Max silence between stream chunks before the request is treated as stalled. */
  idleTimeoutMs?: number;
  models?: Record<string, Partial<ModelInfo>>;
  fetch?: typeof fetch;
}

/**
 * DeepSeek: the OpenAI-compatible adapter in its "deepseek" dialect, which adds
 * `thinking` / `reasoning_effort` and passes `reasoning_content` back on every
 * assistant message when tools are present (api-docs.deepseek.com/guides/thinking_mode).
 */
export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor(opts: DeepSeekOptions) {
    if (!opts.apiKey) throw new ProviderError("authentication", "DEEPSEEK_API_KEY is not set");
    super({
      id: "deepseek",
      displayName: "DeepSeek",
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl ?? "https://api.deepseek.com",
      dialect: "deepseek",
      knownModels: DEEPSEEK_MODELS,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.idleTimeoutMs } : {}),
      ...(opts.models ? { models: opts.models } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  }
}

/**
 * Every model provider Sutra can talk to out of the box. All of them speak
 * OpenAI-style Chat Completions with tool calls; DeepSeek additionally gets
 * its own dialect (thinking mode, reasoning echo, cache-hit accounting).
 *
 * `id` is what goes in config (`"provider": "openrouter"`) and on the
 * command line (`--provider openrouter`). Settings for each live under
 * `providers.<configKey>` in config.json, and keys under `apiKeys.<id>` in
 * credentials.json (or in the environment variable `keyEnv`).
 */

export type ProviderGroup = "recommended" | "cloud" | "gateway" | "local" | "custom";

export interface ProviderPreset {
  id: string;
  name: string;
  group: ProviderGroup;
  /** One short line shown in the picker. */
  blurb: string;
  /** OpenAI-compatible base URL (what `/chat/completions` and `/models` hang off). */
  baseUrl: string;
  /** Environment variable that holds the key. */
  keyEnv?: string;
  /** Where to create a key. */
  keyUrl?: string;
  /** Runs on this machine: no key, no cost. */
  local?: boolean;
  /** Section under `providers` in config.json (defaults to `id`). */
  configKey?: string;
  /** Models to suggest first, when the server offers them. */
  suggested?: string[];
  /** Extra request headers (for example OpenRouter's app attribution). */
  headers?: Record<string, string>;
  /** Context window to assume for models the server gives no metadata for. */
  contextWindow?: number;
  /** Shown after the provider is chosen. */
  note?: string;
}

export const PROVIDERS: ProviderPreset[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    group: "recommended",
    blurb: "Fast, cheap and strong at code; Sutra's tuned default",
    baseUrl: "https://api.deepseek.com",
    keyEnv: "DEEPSEEK_API_KEY",
    keyUrl: "https://platform.deepseek.com/api_keys",
    suggested: ["deepseek-flash", "deepseek-v4-pro"],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    group: "recommended",
    blurb: "Hundreds of models from every lab behind one key",
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    keyUrl: "https://openrouter.ai/settings/keys",
    headers: { "HTTP-Referer": "https://github.com/cneuralnetwork/sutra", "X-Title": "Sutra" },
    suggested: ["deepseek/deepseek-chat", "anthropic/claude-sonnet-4.5", "openai/gpt-5", "google/gemini-2.5-pro", "qwen/qwen3-coder", "moonshotai/kimi-k2", "z-ai/glm-4.6"],
  },
  {
    id: "openai-compatible",
    name: "OpenAI",
    group: "cloud",
    blurb: "GPT models on the OpenAI platform",
    baseUrl: "https://api.openai.com/v1",
    keyEnv: "OPENAI_API_KEY",
    keyUrl: "https://platform.openai.com/api-keys",
    configKey: "openai",
    suggested: ["gpt-5", "gpt-5-mini", "gpt-4.1"],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    group: "cloud",
    blurb: "Claude models, through Anthropic's OpenAI-compatible endpoint",
    baseUrl: "https://api.anthropic.com/v1",
    keyEnv: "ANTHROPIC_API_KEY",
    keyUrl: "https://console.anthropic.com/settings/keys",
    contextWindow: 200_000,
    note: "Anthropic's OpenAI compatibility layer does not support prompt caching or extended thinking.",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    group: "cloud",
    blurb: "Gemini models through Google's OpenAI-compatible endpoint",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyEnv: "GEMINI_API_KEY",
    keyUrl: "https://aistudio.google.com/apikey",
    contextWindow: 1_000_000,
  },
  {
    id: "xai",
    name: "xAI",
    group: "cloud",
    blurb: "Grok models",
    baseUrl: "https://api.x.ai/v1",
    keyEnv: "XAI_API_KEY",
    keyUrl: "https://console.x.ai",
  },
  {
    id: "mistral",
    name: "Mistral",
    group: "cloud",
    blurb: "Mistral and Codestral / Devstral models",
    baseUrl: "https://api.mistral.ai/v1",
    keyEnv: "MISTRAL_API_KEY",
    keyUrl: "https://console.mistral.ai/api-keys",
  },
  {
    id: "groq",
    name: "Groq",
    group: "cloud",
    blurb: "Open models on very fast inference hardware",
    baseUrl: "https://api.groq.com/openai/v1",
    keyEnv: "GROQ_API_KEY",
    keyUrl: "https://console.groq.com/keys",
  },
  {
    id: "cerebras",
    name: "Cerebras",
    group: "cloud",
    blurb: "Open models at thousands of tokens per second",
    baseUrl: "https://api.cerebras.ai/v1",
    keyEnv: "CEREBRAS_API_KEY",
    keyUrl: "https://cloud.cerebras.ai",
  },
  {
    id: "together",
    name: "Together AI",
    group: "cloud",
    blurb: "Hosted open models (Qwen, Llama, DeepSeek, Kimi, GLM)",
    baseUrl: "https://api.together.xyz/v1",
    keyEnv: "TOGETHER_API_KEY",
    keyUrl: "https://api.together.ai/settings/api-keys",
  },
  {
    id: "fireworks",
    name: "Fireworks AI",
    group: "cloud",
    blurb: "Hosted open models with fast tool calling",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    keyEnv: "FIREWORKS_API_KEY",
    keyUrl: "https://fireworks.ai/account/api-keys",
  },
  {
    id: "deepinfra",
    name: "DeepInfra",
    group: "cloud",
    blurb: "Low-cost hosted open models",
    baseUrl: "https://api.deepinfra.com/v1/openai",
    keyEnv: "DEEPINFRA_API_KEY",
    keyUrl: "https://deepinfra.com/dash/api_keys",
  },
  {
    id: "moonshot",
    name: "Moonshot (Kimi)",
    group: "cloud",
    blurb: "Kimi models",
    baseUrl: "https://api.moonshot.ai/v1",
    keyEnv: "MOONSHOT_API_KEY",
    keyUrl: "https://platform.moonshot.ai/console/api-keys",
  },
  {
    id: "zai",
    name: "Z.ai (GLM)",
    group: "cloud",
    blurb: "GLM models",
    baseUrl: "https://api.z.ai/api/paas/v4",
    keyEnv: "ZAI_API_KEY",
    keyUrl: "https://z.ai/manage-apikey/apikey-list",
  },
  {
    id: "qwen",
    name: "Qwen (Alibaba Cloud)",
    group: "cloud",
    blurb: "Qwen and Qwen-Coder models on DashScope (international)",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    keyEnv: "DASHSCOPE_API_KEY",
    keyUrl: "https://modelstudio.console.alibabacloud.com",
  },
  {
    id: "sambanova",
    name: "SambaNova",
    group: "cloud",
    blurb: "Fast hosted open models",
    baseUrl: "https://api.sambanova.ai/v1",
    keyEnv: "SAMBANOVA_API_KEY",
    keyUrl: "https://cloud.sambanova.ai/apis",
  },
  {
    id: "huggingface",
    name: "Hugging Face",
    group: "gateway",
    blurb: "Inference Providers router: open models across many hosts",
    baseUrl: "https://router.huggingface.co/v1",
    keyEnv: "HF_TOKEN",
    keyUrl: "https://huggingface.co/settings/tokens",
  },
  {
    id: "vercel",
    name: "Vercel AI Gateway",
    group: "gateway",
    blurb: "One key for models from many providers, with fallbacks",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    keyEnv: "AI_GATEWAY_API_KEY",
    keyUrl: "https://vercel.com/docs/ai-gateway",
  },
  {
    id: "ollama",
    name: "Ollama",
    group: "local",
    blurb: "Local models, private and free",
    baseUrl: "http://localhost:11434/v1",
    local: true,
    contextWindow: 32_768,
    suggested: ["qwen3-coder", "gpt-oss:20b", "devstral", "qwen2.5-coder"],
    note: "Ollama's default context is small. Set OLLAMA_CONTEXT_LENGTH=32768 (or more) on the server and providers.ollama.contextWindow to match.",
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    group: "local",
    blurb: "Local models from the LM Studio app",
    baseUrl: "http://localhost:1234/v1",
    local: true,
    contextWindow: 32_768,
    note: "Load a model in LM Studio and start its local server (Developer tab). Set the context length there to 32k or more.",
  },
  {
    id: "llamacpp",
    name: "llama.cpp",
    group: "local",
    blurb: "llama-server on this machine",
    baseUrl: "http://localhost:8080/v1",
    local: true,
    contextWindow: 32_768,
    note: "Start it with `llama-server -m <model.gguf> --jinja -c 32768` so tool calls work.",
  },
  {
    id: "vllm",
    name: "vLLM",
    group: "local",
    blurb: "vLLM's OpenAI-compatible server",
    baseUrl: "http://localhost:8000/v1",
    local: true,
    contextWindow: 32_768,
    note: "Start it with `vllm serve <model> --enable-auto-tool-choice --tool-call-parser <parser>` so tool calls work.",
  },
  {
    id: "jan",
    name: "Jan",
    group: "local",
    blurb: "Local models from the Jan app",
    baseUrl: "http://localhost:1337/v1",
    local: true,
    contextWindow: 32_768,
  },
  {
    id: "custom",
    name: "Custom endpoint",
    group: "custom",
    blurb: "Any other OpenAI-compatible server or proxy",
    baseUrl: "",
    keyEnv: "SUTRA_CUSTOM_API_KEY",
  },
];

export const GROUP_LABELS: Record<ProviderGroup, string> = {
  recommended: "Recommended",
  cloud: "Cloud providers",
  gateway: "Gateways",
  local: "On this machine (no key, private)",
  custom: "Other",
};

export function findPreset(id: string): ProviderPreset | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function presetConfigKey(p: ProviderPreset): string {
  return p.configKey ?? p.id;
}

export function isLocalUrl(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/.test(url);
}

export function providerIds(): string[] {
  return PROVIDERS.map((p) => p.id);
}

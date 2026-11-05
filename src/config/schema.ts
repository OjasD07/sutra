import { z } from "zod";

export const PermissionProfileSchema = z.enum(["inspect", "confirm", "flow"]);
export type PermissionProfile = z.infer<typeof PermissionProfileSchema>;

/** Price per 1M tokens, in USD. */
export const ModelPriceSchema = z.object({
  inputCacheMiss: z.number().nonnegative(),
  inputCacheHit: z.number().nonnegative(),
  output: z.number().nonnegative(),
  /**
   * Optional off-peak pricing. When present, `peakWindowsUtc` decides which
   * requests use the base (peak) price; all other times use `offPeak`.
   */
  offPeak: z
    .object({ inputCacheMiss: z.number(), inputCacheHit: z.number(), output: z.number() })
    .optional(),
  /** e.g. [{ days: [1,2,3,4,5], start: "01:00", end: "04:00" }] (days: 0=Sun). */
  peakWindowsUtc: z
    .array(z.object({ days: z.array(z.number().int().min(0).max(6)), start: z.string(), end: z.string() }))
    .optional(),
  currency: z.literal("USD").default("USD"),
  source: z.string().optional(),
  asOf: z.string().optional(),
});
export type ModelPrice = z.infer<typeof ModelPriceSchema>;

const ModelInfoOverride = z.object({
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  defaultOutputTokens: z.number().int().positive().optional(),
  supportsTools: z.boolean().optional(),
  supportsThinking: z.boolean().optional(),
  thinkingSupportsTools: z.boolean().optional(),
});

export const ConfigSchema = z.object({
  provider: z.string().default("deepseek"),
  model: z.string().optional(),
  thinking: z.enum(["enabled", "disabled"]).default("enabled"),
  reasoningEffort: z.enum(["low", "high", "max"]).default("high"),
  maxOutputTokens: z.number().int().positive().optional(),
  permissions: z
    .object({
      profile: PermissionProfileSchema.default("confirm"),
      /** Command prefixes auto-approved in `flow` (still blocked if destructive/network). */
      allowCommands: z.array(z.string()).default([]),
      /** Extra glob-ish path patterns treated as sensitive. */
      sensitivePaths: z.array(z.string()).default([]),
      /** Paths (relative to workspace) the agent may never write. */
      protectedPaths: z.array(z.string()).default([]),
    })
    .prefault({}),
  providers: z
    .object({
      deepseek: z
        .object({
          apiKey: z.string().optional(),
          baseUrl: z.string().url().default("https://api.deepseek.com"),
          timeoutMs: z.number().int().positive().optional(),
          models: z.record(z.string(), ModelInfoOverride).default({}),
        })
        .prefault({}),
      /** Any OpenAI-compatible endpoint: OpenAI, vLLM, LM Studio, llama.cpp, OpenRouter, ... */
      openai: z
        .object({
          apiKey: z.string().optional(),
          baseUrl: z.string().url().default("https://api.openai.com/v1"),
          timeoutMs: z.number().int().positive().optional(),
          models: z.record(z.string(), ModelInfoOverride).default({}),
          /** Treat requests as free (self-hosted inference). */
          freeOfCharge: z.boolean().default(false),
          /** Context window assumed for models with no metadata. */
          contextWindow: z.number().int().positive().default(128_000),
        })
        .prefault({}),
      /** Local Ollama server (OpenAI-compatible endpoint). */
      ollama: z
        .object({
          baseUrl: z.string().url().default("http://localhost:11434/v1"),
          timeoutMs: z.number().int().positive().optional(),
          models: z.record(z.string(), ModelInfoOverride).default({}),
          /**
           * Must match the server's context length (OLLAMA_CONTEXT_LENGTH or the
           * model's num_ctx). Ollama silently truncates longer prompts.
           */
          contextWindow: z.number().int().positive().default(32_768),
        })
        .prefault({}),
    })
    .prefault({}),
  sandbox: z
    .object({
      /**
       * OS-level isolation for shell commands and tests.
       * auto: use it when the platform supports it; required: refuse to run
       * commands without it; off: approval gate only.
       */
      mode: z.enum(["auto", "required", "off"]).default("auto"),
      /** Extra directories commands may write to (besides the workspace and temp dirs). */
      allowWrite: z.array(z.string()).default([]),
      /** Allow network for every command, not only for approved network commands. */
      network: z.boolean().default(false),
    })
    .prefault({}),
  pricing: z.record(z.string(), ModelPriceSchema).default({}),
  budget: z
    .object({
      /** Hard per-session spend limit in USD. Inference pauses when reached. */
      maxSessionCostUsd: z.number().positive().optional(),
      warnAtFraction: z.number().min(0).max(1).default(0.8),
      maxIterationsPerTurn: z.number().int().positive().default(60),
      maxToolCallsPerTurn: z.number().int().positive().default(200),
    })
    .prefault({}),
  context: z
    .object({
      /** Fraction of the model context window that triggers compaction. */
      compactThreshold: z.number().min(0.1).max(0.95).default(0.75),
      /**
       * Cap below the model window. DeepSeek models accept 1M tokens, but
       * every request re-sends the context, so a lower cap keeps spend
       * predictable. Raise it in config if you need more.
       */
      maxContextTokens: z.number().int().positive().default(200_000),
      keepRecentTurns: z.number().int().min(1).default(2),
    })
    .prefault({}),
  quality: z
    .object({
      /**
       * fast: evidence labels only, no extra model calls. balanced: evidence
       * packet, task contract, finish gate, alignment review, one
       * counterexample round. deep: adds a second round and competing patches.
       */
      mode: z.enum(["fast", "balanced", "deep"]).default("balanced"),
    })
    .prefault({}),
  index: z
    .object({
      /** Build a repository index (symbols, reference graph, ranked search) at session start. */
      enabled: z.boolean().default(true),
      /** Token budget for the repository map placed in the system prompt (0 = no map in the prompt). */
      mapTokens: z.number().int().min(0).max(16_000).default(2000),
      maxFiles: z.number().int().positive().default(5000),
      /** Optional embeddings for code_search (any OpenAI-compatible /embeddings endpoint). */
      embeddings: z
        .object({
          baseUrl: z.string().url(),
          model: z.string().min(1),
          /** Name of an environment variable holding the key (keys are never stored in config). */
          apiKeyEnv: z.string().optional(),
          maxChunks: z.number().int().positive().optional(),
        })
        .optional(),
    })
    .prefault({}),
  tools: z
    .object({
      commandTimeoutMs: z.number().int().positive().default(120_000),
      maxOutputChars: z.number().int().positive().default(30_000),
      retainFullLogs: z.boolean().default(true),
      testCommand: z.string().optional(),
      scrubEnv: z.boolean().default(true),
    })
    .prefault({}),
  ui: z
    .object({
      theme: z.enum(["auto", "dark", "light"]).default("auto"),
      language: z.enum(["en", "hi"]).default("en"),
    })
    .prefault({}),
});

export type SutraConfig = z.infer<typeof ConfigSchema>;

/**
 * Keys a repository's `.sutra/config.json` may set. Project config is lower
 * trust than user config: it can never loosen permissions, change the API
 * endpoint, or touch credentials.
 */
export const ProjectConfigSchema = z
  .object({
    model: z.string().optional(),
    tools: z.object({ testCommand: z.string().optional() }).optional(),
    permissions: z
      .object({
        protectedPaths: z.array(z.string()).optional(),
        sensitivePaths: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .strip();
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

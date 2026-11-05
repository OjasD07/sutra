import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_DEEPSEEK_MODEL } from "../providers/deepseek/models.js";
import { findPreset, presetConfigKey, providerIds } from "../providers/catalog.js";
import { paths } from "./paths.js";
import { DEFAULT_PRICING } from "./pricing.js";
import { ConfigSchema, ProjectConfigSchema, type PermissionProfile, type SutraConfig } from "./schema.js";


export interface CliOverrides {
  provider?: string;
  model?: string;
  profile?: PermissionProfile;
  thinking?: "enabled" | "disabled";
}

export interface LoadedConfig {
  config: SutraConfig;
  /** Where the API key came from — never the key itself. */
  apiKeySource: "env" | "credentials" | "config" | "none";
  warnings: string[];
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Invalid JSON in ${path}: ${(err as Error).message}`);
  }
}

function deepMerge<T>(base: T, over: unknown): T {
  if (over === undefined || over === null) return base;
  if (typeof base !== "object" || base === null || Array.isArray(base) || typeof over !== "object" || Array.isArray(over))
    return over as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

export interface Credentials {
  deepseekApiKey?: string;
  openaiApiKey?: string;
  /** Keys for every other provider, by provider id. */
  apiKeys?: Record<string, string>;
}

export function readCredentials(): Credentials {
  const raw = readJson(paths.credentials()) as Credentials | undefined;
  return raw ?? {};
}

/** Store credentials outside any repository, readable only by the user. */
export function writeCredentials(update: Credentials): string {
  const file = paths.credentials();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const current = readCredentials();
  const next = { ...current, ...update, ...(update.apiKeys || current.apiKeys ? { apiKeys: { ...(current.apiKeys ?? {}), ...(update.apiKeys ?? {}) } } : {}) };
  writeFileSync(file, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

export function writeUserConfig(update: Record<string, unknown>): string {
  const file = paths.userConfig();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const current = (readJson(file) as Record<string, unknown> | undefined) ?? {};
  writeFileSync(file, JSON.stringify(deepMerge(current, update), null, 2) + "\n", { mode: 0o600 });
  return file;
}

/**
 * Precedence (highest first): CLI flags > environment > user config >
 * project config (restricted keys only) > defaults.
 */
export function loadConfig(workspace: string, cli: CliOverrides = {}, env = process.env): LoadedConfig {
  const warnings: string[] = [];
  const user = (readJson(paths.userConfig()) ?? {}) as Record<string, unknown>;

  const projectRaw = readJson(join(workspace, ".sutra", "config.json"));
  const projectParsed = ProjectConfigSchema.safeParse(projectRaw ?? {});
  if (!projectParsed.success) warnings.push("Ignored invalid .sutra/config.json");
  const project = projectParsed.success ? projectParsed.data : {};
  if (projectRaw && typeof projectRaw === "object") {
    const allowed = new Set(["model", "tools", "permissions"]);
    const dropped = Object.keys(projectRaw).filter((k) => !allowed.has(k));
    if (dropped.length) warnings.push(`Project config keys ignored for safety: ${dropped.join(", ")}`);
  }

  // Project config is merged *under* user config, and its permission lists can
  // only add restrictions (they are concatenated, never replaced).
  let merged: Record<string, unknown> = deepMerge({ model: project.model, tools: project.tools ?? {} }, user);
  const userPerms = (user.permissions ?? {}) as Record<string, unknown>;
  merged = deepMerge(merged, {
    permissions: {
      ...userPerms,
      protectedPaths: [...((userPerms.protectedPaths as string[]) ?? []), ...(project.permissions?.protectedPaths ?? [])],
      sensitivePaths: [...((userPerms.sensitivePaths as string[]) ?? []), ...(project.permissions?.sensitivePaths ?? [])],
    },
  });

  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) throw new Error(`Invalid configuration: ${parsed.error.message}`);
  const config = parsed.data;

  // Environment
  if (env.SUTRA_PROVIDER) config.provider = env.SUTRA_PROVIDER;
  if (cli.provider) config.provider = cli.provider;
  if (env.DEEPSEEK_BASE_URL) config.providers.deepseek.baseUrl = env.DEEPSEEK_BASE_URL;
  if (env.OPENAI_BASE_URL) config.providers.openai.baseUrl = env.OPENAI_BASE_URL;
  if (env.OLLAMA_HOST) config.providers.ollama.baseUrl = ollamaUrl(env.OLLAMA_HOST);
  if (env.DEEPSEEK_MODEL && config.provider === "deepseek") config.model = env.DEEPSEEK_MODEL;
  if (env.SUTRA_MODEL) config.model = env.SUTRA_MODEL;
  if (env.SUTRA_QUALITY === "fast" || env.SUTRA_QUALITY === "balanced" || env.SUTRA_QUALITY === "deep") config.quality.mode = env.SUTRA_QUALITY;
  if (env.SUTRA_PROFILE && ["inspect", "confirm", "flow"].includes(env.SUTRA_PROFILE))
    config.permissions.profile = env.SUTRA_PROFILE as PermissionProfile;

  // API key: env > credentials file > config file (discouraged).
  let apiKeySource: LoadedConfig["apiKeySource"] = "none";
  if (config.providers.deepseek.apiKey) {
    apiKeySource = "config";
    warnings.push("API key found in config.json; prefer DEEPSEEK_API_KEY or `sutra init` (credentials.json, mode 600).");
  }
  const creds = readCredentials();
  if (creds.deepseekApiKey) {
    config.providers.deepseek.apiKey = creds.deepseekApiKey;
    apiKeySource = "credentials";
  }
  if (env.DEEPSEEK_API_KEY) {
    config.providers.deepseek.apiKey = env.DEEPSEEK_API_KEY;
    apiKeySource = "env";
  }
  if (creds.openaiApiKey) config.providers.openai.apiKey = creds.openaiApiKey;
  if (env.OPENAI_API_KEY) config.providers.openai.apiKey = env.OPENAI_API_KEY;
  if (config.provider === "openai-compatible") apiKeySource = config.providers.openai.apiKey ? (env.OPENAI_API_KEY ? "env" : "credentials") : "none";
  else if (config.provider !== "deepseek") apiKeySource = "none";

  // Every other catalog provider: env > credentials (apiKeys.<id>) > config.
  const preset = findPreset(config.provider);
  if (preset && !["deepseek", "openai-compatible", "ollama"].includes(preset.id)) {
    const key = presetConfigKey(preset);
    const section = ((config.providers as Record<string, unknown>)[key] ?? { models: {} }) as { apiKey?: string; models: Record<string, unknown> };
    if (section.apiKey) {
      apiKeySource = "config";
      warnings.push(`API key found in config.json for ${preset.name}; prefer ${preset.keyEnv ?? "the environment"} or \`sutra init\` (credentials.json, mode 600).`);
    }
    if (creds.apiKeys?.[preset.id]) {
      section.apiKey = creds.apiKeys[preset.id];
      apiKeySource = "credentials";
    }
    if (preset.keyEnv && env[preset.keyEnv]) {
      section.apiKey = env[preset.keyEnv];
      apiKeySource = "env";
    }
    (config.providers as Record<string, unknown>)[key] = section;
  }

  // CLI
  if (cli.model) config.model = cli.model;
  if (cli.profile) config.permissions.profile = cli.profile;
  if (cli.thinking) config.thinking = cli.thinking;

  if (!providerIds().includes(config.provider))
    throw new Error(`Unknown provider "${config.provider}". Use one of: ${providerIds().join(", ")}`);
  // Other providers have no universal default; Sutra asks the server for its models at startup.
  if (config.provider === "deepseek") config.model ??= DEFAULT_DEEPSEEK_MODEL;
  config.pricing = { ...DEFAULT_PRICING, ...config.pricing };
  return { config, apiKeySource, warnings };
}

/** OLLAMA_HOST is "host:port" or a URL; Sutra needs the OpenAI-compatible /v1 base. */
export function ollamaUrl(host: string): string {
  const withScheme = /^https?:\/\//.test(host) ? host : `http://${host}`;
  return withScheme.replace(/\/+$/, "").replace(/\/v1$/, "") + "/v1";
}

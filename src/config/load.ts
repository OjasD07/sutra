import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_DEEPSEEK_MODEL } from "../providers/deepseek/models.js";
import { paths } from "./paths.js";
import { DEFAULT_PRICING } from "./pricing.js";
import { ConfigSchema, ProjectConfigSchema, type PermissionProfile, type SutraConfig } from "./schema.js";

export interface CliOverrides {
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

export function readCredentials(): { deepseekApiKey?: string } {
  const raw = readJson(paths.credentials()) as { deepseekApiKey?: string } | undefined;
  return raw ?? {};
}

/** Store credentials outside any repository, readable only by the user. */
export function writeCredentials(update: { deepseekApiKey?: string }): string {
  const file = paths.credentials();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const next = { ...readCredentials(), ...update };
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
  if (env.DEEPSEEK_BASE_URL) config.providers.deepseek.baseUrl = env.DEEPSEEK_BASE_URL;
  if (env.DEEPSEEK_MODEL) config.model = env.DEEPSEEK_MODEL;
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

  // CLI
  if (cli.model) config.model = cli.model;
  if (cli.profile) config.permissions.profile = cli.profile;
  if (cli.thinking) config.thinking = cli.thinking;

  config.model ??= DEFAULT_DEEPSEEK_MODEL;
  config.pricing = { ...DEFAULT_PRICING, ...config.pricing };
  return { config, apiKeySource, warnings };
}

// How to run each harness headless against DeepSeek through the metering proxy.
//
// Every run gets a fresh, empty HOME (and tool-specific config dirs inside it),
// so no harness picks up your personal settings, memory, plugins, MCP servers
// or instructions. The API key is passed only through environment variables.
//
// `flags` lists the options each command relies on; `sources` says where they
// were checked. `node bench.mjs check` greps each installed CLI's --help for
// them and warns about any that are missing, because these CLIs change often.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SUTRA_ROOT = resolve(import.meta.dirname, "..", "..");

export const ADAPTERS = {
  sutra: {
    name: "Sutra (balanced)",
    bin: "node",
    install: "already here (this repository)",
    flags: ["-p", "--profile", "--quality", "--sandbox"],
    sources: "this repository",
    helpArgs: [join(SUTRA_ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(SUTRA_ROOT, "src", "index.ts"), "--help"],
    prepare: (c) => sutra(c, "balanced"),
  },
  "sutra-fast": {
    name: "Sutra (fast)",
    bin: "node",
    install: "already here (this repository)",
    flags: ["-p", "--profile", "--quality", "--sandbox"],
    sources: "this repository",
    helpArgs: [join(SUTRA_ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(SUTRA_ROOT, "src", "index.ts"), "--help"],
    prepare: (c) => sutra(c, "fast"),
  },

  "claude-code": {
    name: "Claude Code",
    bin: "claude",
    install: "npm install -g @anthropic-ai/claude-code",
    flags: ["--print", "--dangerously-skip-permissions", "--output-format", "--model", "--no-session-persistence", "--strict-mcp-config"],
    sources: "DeepSeek's Claude Code guide (env vars); flags checked against `claude --help` 2.1.309",
    prepare: (c) => ({
      args: ["--print", "--dangerously-skip-permissions", "--output-format", "json", "--model", c.anthropicModel, "--no-session-persistence", "--strict-mcp-config", c.prompt],
      env: {
        CLAUDE_CONFIG_DIR: join(c.home, ".claude"),
        ANTHROPIC_BASE_URL: `${c.proxyUrl}/anthropic`,
        ANTHROPIC_AUTH_TOKEN: c.key,
        ANTHROPIC_MODEL: c.anthropicModel,
        ANTHROPIC_DEFAULT_OPUS_MODEL: c.anthropicModel,
        ANTHROPIC_DEFAULT_SONNET_MODEL: c.anthropicModel,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: c.anthropicModel,
        CLAUDE_CODE_SUBAGENT_MODEL: c.anthropicModel,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_AUTOUPDATER: "1",
      },
    }),
  },

  codex: {
    name: "Codex CLI",
    bin: "codex",
    install: "npm install -g @openai/codex",
    flags: ["exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox"],
    sources: "UNVERIFIED: flags and model_providers keys from memory of Codex's docs; run `check`. Recent Codex versions may only speak the Responses API, which DeepSeek does not offer; if so every request fails and the run is reported as an error",
    prepare: (c) => {
      const codexHome = join(c.home, ".codex");
      mkdirSync(codexHome, { recursive: true });
      writeFileSync(
        join(codexHome, "config.toml"),
        [
          `model = "${c.model}"`,
          `model_provider = "deepseek_meter"`,
          `[model_providers.deepseek_meter]`,
          `name = "DeepSeek (metered)"`,
          `base_url = "${c.proxyUrl}/v1"`,
          `env_key = "DEEPSEEK_API_KEY"`,
          `wire_api = "chat"`,
          "",
        ].join("\n"),
      );
      return { args: ["exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", c.prompt], env: { CODEX_HOME: codexHome, DEEPSEEK_API_KEY: c.key } };
    },
  },

  aider: {
    name: "Aider",
    bin: "aider",
    install: "python -m pip install aider-install && aider-install",
    flags: ["--message", "--yes", "--no-auto-commits", "--model", "--no-check-update", "--no-show-model-warnings", "--analytics-disable"],
    sources: "aider.chat scripting and OpenAI-compatible pages (--message, --yes, --no-auto-commits, OPENAI_API_BASE); --no-check-update, --no-show-model-warnings and --analytics-disable unverified",
    prepare: (c) => ({
      args: ["--message", c.prompt, "--yes", "--no-auto-commits", "--no-check-update", "--no-show-model-warnings", "--analytics-disable", "--model", `openai/${c.model}`],
      env: { OPENAI_API_BASE: `${c.proxyUrl}/v1`, OPENAI_API_KEY: c.key },
    }),
  },

  opencode: {
    name: "OpenCode",
    bin: "opencode",
    install: "npm install -g opencode-ai",
    flags: ["run", "--model", "--format"],
    sources: "opencode.ai CLI, providers and config pages (opencode run, --model, --format json, custom @ai-sdk/openai-compatible provider, OPENCODE_CONFIG_CONTENT, permission); the \"allow\" value is not shown verbatim there",
    prepare: (c) => ({
      args: ["run", "--model", `deepseek_meter/${c.model}`, "--format", "json", c.prompt],
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          autoupdate: false,
          share: "disabled",
          permission: { edit: "allow", bash: "allow", webfetch: "allow" },
          provider: {
            deepseek_meter: {
              npm: "@ai-sdk/openai-compatible",
              name: "DeepSeek (metered)",
              options: { baseURL: `${c.proxyUrl}/v1`, apiKey: "{env:DEEPSEEK_API_KEY}" },
              models: { [c.model]: { name: c.model } },
            },
          },
        }),
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        DEEPSEEK_API_KEY: c.key,
      },
    }),
  },

  goose: {
    name: "Goose",
    bin: "goose",
    install: "curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | CONFIGURE=false bash",
    flags: ["run", "--no-session", "-t"],
    sources: "UNVERIFIED: Goose's docs pages returned 404 when checked; flags and env vars (GOOSE_PROVIDER, OPENAI_HOST, GOOSE_MODE) from memory. Run `check`",
    prepare: (c) => ({
      args: ["run", "--no-session", "-t", c.prompt],
      env: {
        GOOSE_PROVIDER: "openai",
        GOOSE_MODEL: c.model,
        OPENAI_HOST: c.proxyUrl,
        OPENAI_BASE_PATH: "v1/chat/completions",
        OPENAI_API_KEY: c.key,
        GOOSE_MODE: "auto",
        GOOSE_DISABLE_KEYRING: "1",
        GOOSE_CLI_MIN_PRIORITY: "0.2",
      },
    }),
  },

  "qwen-code": {
    name: "Qwen Code",
    bin: "qwen",
    install: "npm install -g @qwen-code/qwen-code@latest",
    flags: ["-p", "--yolo"],
    sources: "qwen-code README (-p headless mode); --yolo, OPENAI_* env vars and the auth setting are UNVERIFIED (not on the README); run `check`",
    prepare: (c) => {
      const dir = join(c.home, ".qwen");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ selectedAuthType: "openai", security: { auth: { selectedType: "openai" } }, usageStatisticsEnabled: false }, null, 2));
      return { args: ["-p", c.prompt, "--yolo"], env: { OPENAI_API_KEY: c.key, OPENAI_BASE_URL: `${c.proxyUrl}/v1`, OPENAI_MODEL: c.model } };
    },
  },
};

function sutra(c, quality) {
  return {
    bin: process.execPath,
    args: [join(SUTRA_ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(SUTRA_ROOT, "src", "index.ts"), "-p", "--profile", "flow", "--quality", quality, "--sandbox", c.sandboxSutra ? "auto" : "off", c.prompt],
    env: { SUTRA_HOME: join(c.home, ".sutra"), DEEPSEEK_API_KEY: c.key, DEEPSEEK_BASE_URL: c.proxyUrl, DEEPSEEK_MODEL: c.model, SUTRA_MODEL: c.model },
  };
}

/** Test-only adapter: a shell script standing in for a harness (used by `selftest`). */
export const SELFTEST_ADAPTER = {
  name: "self-test script",
  bin: "sh",
  flags: [],
  sources: "selftest",
  prepare: (c) => ({
    args: ["-c", `curl -s -X POST "$PROXY/chat/completions" -H "authorization: Bearer $KEY" -H "content-type: application/json" -d '{"model":"m","stream":true,"messages":[]}' >/dev/null; ${c.selftestFix ?? "true"}`],
    env: { PROXY: c.proxyUrl, KEY: c.key },
  }),
};

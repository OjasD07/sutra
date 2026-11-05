import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Chalk } from "chalk";
import { paths } from "../config/paths.js";
import { loadConfig, readCredentials, writeCredentials, writeUserConfig } from "../config/load.js";
import { AGENTS_TEMPLATE } from "../context/instructions.js";
import { DeepSeekProvider } from "../providers/deepseek/provider.js";
import { OpenAICompatibleProvider } from "../providers/openai-compatible/provider.js";
import { DEEPSEEK_MODELS } from "../providers/deepseek/models.js";
import { listProviders } from "../providers/registry.js";
import { estimateCost, formatUsd } from "../telemetry/cost.js";
import { darkTheme, type Theme } from "../tui/theme.js";

/** Read a line without echoing it (for API keys). */
async function readSecret(prompt: string, nextLine?: () => Promise<string>): Promise<string> {
  const stdin = process.stdin;
  process.stdout.write(prompt);
  if (!stdin.isTTY) {
    const line = nextLine ? await nextLine() : "";
    process.stdout.write("\n");
    return line.trim();
  }
  return new Promise((resolve) => {
    let buf = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(buf.trim());
          return;
        }
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
        else if (ch >= " ") buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}

export async function runInit(opts: { color: boolean; theme?: Theme }): Promise<number> {
  const theme = opts.theme ?? darkTheme;
  const c = opts.color ? new Chalk() : new Chalk({ level: 0 });
  const accent = c.hex(theme.accent);
  const muted = c.hex(theme.muted);
  const ok = (s: string) => console.log(`  ${c.hex(theme.success)("✓")} ${s}`);
  const bad = (s: string) => console.log(`  ${c.hex(theme.error)("✗")} ${s}`);
  // With piped input, readline's question() loses lines that arrive before it
  // is called, so non-interactive runs read from one buffered line iterator.
  const piped = !process.stdin.isTTY;
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: !piped });
  const lines = piped ? rl[Symbol.asyncIterator]() : null;
  const nextLine = async () => {
    const r = await lines!.next();
    return r.done ? "" : r.value;
  };
  const ask = async (q: string, def?: string) => {
    const prompt = `  ${q}${def ? muted(` [${def}]`) : ""} `;
    let a: string;
    if (lines) {
      process.stdout.write(prompt);
      a = (await nextLine()).trim();
      process.stdout.write(`${a}\n`);
    } else a = (await rl.question(prompt)).trim();
    return a || def || "";
  };
  const yes = async (q: string, def = false) => {
    const a = await ask(`${q} ${def ? "[Y/n]" : "[y/N]"}`);
    return a ? /^y(es)?$/i.test(a) : def;
  };

  console.log(`\n  ${accent.bold("सूत्र  Sutra setup")}\n`);
  console.log(muted("  1. Configuration"));
  console.log(`  Sutra keeps user-level state in ${paths.home()}:`);
  console.log(`    config.json       settings (model, permissions, budgets, pricing overrides)`);
  console.log(`    credentials.json  API keys, file mode 600 — never inside a repository`);
  console.log(`    sutra.db          local session history (SQLite, mode 600)`);
  console.log(`  Repositories can add .sutra/AGENTS.md (instructions) and .sutra/config.json (limited, cannot loosen permissions).\n`);

  // 2. Provider
  console.log(muted("  2. Model provider"));
  console.log(`  deepseek            DeepSeek API (cloud; needs an API key)`);
  console.log(`  ollama              Local models via Ollama (free, private; no key)`);
  console.log(`  openai-compatible   Any OpenAI-compatible server: OpenAI, vLLM, LM Studio, llama.cpp, OpenRouter`);
  const provider = await ask("Provider:", loadConfig(process.cwd()).config.provider ?? "deepseek");
  if (!listProviders().includes(provider)) {
    bad(`Unknown provider "${provider}". Choose one of: ${listProviders().join(", ")}`);
    rl.close();
    return 1;
  }
  const current = loadConfig(process.cwd(), { provider }).config;

  // Endpoint
  let baseUrl =
    provider === "deepseek" ? (process.env.DEEPSEEK_BASE_URL ?? current.providers.deepseek.baseUrl) : provider === "ollama" ? current.providers.ollama.baseUrl : current.providers.openai.baseUrl;
  if (provider !== "deepseek") baseUrl = await ask("Server URL (OpenAI-compatible base, ending in /v1):", baseUrl);
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/)/.test(baseUrl);

  // 3. Authentication
  console.log(muted("\n  3. Authentication"));
  const envVar = provider === "deepseek" ? "DEEPSEEK_API_KEY" : "OPENAI_API_KEY";
  const credKey = provider === "deepseek" ? "deepseekApiKey" : "openaiApiKey";
  let key = "";
  let keySource = "none";
  if (provider === "ollama") ok("Ollama needs no API key.");
  else {
    if (process.env[envVar]) {
      console.log(`  ${envVar} is set in your environment.`);
      if (await yes("Use the environment variable (nothing is written to disk)?", true)) {
        key = process.env[envVar]!;
        keySource = "env";
      }
    }
    const stored = readCredentials()[credKey];
    if (!key && stored && (await yes(`A key is already stored in ${paths.credentials()}. Keep it?`, true))) {
      key = stored;
      keySource = "credentials";
    }
    if (!key) {
      if (provider === "deepseek") console.log(`  Create a key at https://platform.deepseek.com/api_keys. Input is hidden.`);
      else console.log(`  Input is hidden.${local ? " Local servers usually need none: press Enter to skip." : ""}`);
      if (!piped) rl.pause();
      key = await readSecret(`  ${provider === "deepseek" ? "DeepSeek" : "API"} key: `, piped ? nextLine : undefined);
      if (!piped) rl.resume();
      if (key) {
        const file = writeCredentials({ [credKey]: key });
        keySource = "credentials";
        ok(`Key stored in ${file} (mode 600). It is never printed or written to the repository.`);
      } else if (provider === "deepseek" || !local) {
        bad("No key entered.");
        rl.close();
        return 1;
      }
    }
  }

  // 4. Validate and pick a model from what the server actually offers
  console.log(muted("\n  4. Validating provider"));
  const client =
    provider === "deepseek"
      ? new DeepSeekProvider({ apiKey: key, baseUrl, timeoutMs: 20_000 })
      : new OpenAICompatibleProvider({ id: provider, displayName: provider, baseUrl, dialect: "openai", ...(key ? { apiKey: key } : {}), timeoutMs: 20_000 });
  let ids: string[] = [];
  let reachable = false;
  try {
    ids = await client.listModels(AbortSignal.timeout(20_000));
    reachable = true;
    ok(`Reached ${baseUrl}; ${ids.length} model(s) available${ids.length ? `: ${ids.slice(0, 8).join(", ")}${ids.length > 8 ? ", …" : ""}` : ""}`);
  } catch (err) {
    bad(`Could not reach ${baseUrl}: ${(err as Error).message}`);
    if (provider === "ollama") console.log(`  Start it with \`ollama serve\` and pull a model, e.g. \`ollama pull qwen3-coder\`.`);
  }
  const suggested = current.model && (ids.length === 0 || ids.includes(current.model)) ? current.model : provider === "deepseek" ? "deepseek-flash" : ids[0];
  if (provider === "deepseek") console.log(`  Models: ${Object.keys(DEEPSEEK_MODELS).join(", ")} ${muted("(see https://api-docs.deepseek.com/quick_start/pricing)")}`);
  const model = await ask("Default model:", suggested);
  if (!model) {
    bad("No model chosen.");
    rl.close();
    return 1;
  }
  if (reachable && ids.length && !ids.includes(model)) console.log(`  ${accent("!")} ${model} is not in the server's list; check the id.`);
  const providerSettings =
    provider === "deepseek" ? {} : provider === "ollama" ? { providers: { ollama: { baseUrl } } } : { providers: { openai: { baseUrl, ...(local ? { freeOfCharge: true } : {}) } } };
  writeUserConfig({ provider, model, ...providerSettings });
  ok(`Saved provider, model and endpoint to ${paths.userConfig()}`);
  if (provider === "ollama") console.log(`  ${accent("!")} Ollama's default context is small. Set OLLAMA_CONTEXT_LENGTH=32768 (or more) on the server and providers.ollama.contextWindow to match.`);

  // 5. Project instructions
  console.log(muted("\n  5. Project instructions"));
  const agentsPath = join(process.cwd(), ".sutra", "AGENTS.md");
  if (existsSync(agentsPath)) ok(".sutra/AGENTS.md already exists.");
  else if (await yes(`Create .sutra/AGENTS.md in ${process.cwd()}?`, false)) {
    mkdirSync(join(process.cwd(), ".sutra"), { recursive: true });
    writeFileSync(agentsPath, AGENTS_TEMPLATE);
    ok("Created .sutra/AGENTS.md — edit it to describe your project's commands and conventions.");
  }

  // 6. Smoke test
  let inferenceOk: boolean | null = null;
  if (reachable) {
    console.log(muted("\n  6. Inference smoke test"));
    const prompt = provider === "deepseek" || (provider === "openai-compatible" && !local) ? "Send one tiny request (a few tokens, billed to your account)?" : "Send one tiny request to the local model?";
    if (await yes(prompt, provider === "ollama")) {
      try {
        let text = "";
        let usage = null;
        for await (const ev of client.generate({ model, messages: [{ role: "user", content: "Reply with the single word: ready" }], thinking: "disabled", maxOutputTokens: 16 }, AbortSignal.timeout(180_000))) {
          if (ev.type === "message_complete") {
            text = ev.message.content;
            usage = ev.usage;
          }
        }
        inferenceOk = true;
        const cfg = loadConfig(process.cwd()).config;
        const price = cfg.pricing[model];
        const cost = usage ? (price ? estimateCost(usage, price) : provider === "ollama" || local ? 0 : null) : null;
        ok(`Model replied: "${text.trim().slice(0, 40)}" (${usage?.inputTokens ?? "?"} in / ${usage?.outputTokens ?? "?"} out tokens, ~${cost === null ? "unknown cost" : formatUsd(cost)})`);
      } catch (err) {
        inferenceOk = false;
        bad(`Inference failed: ${(err as Error).message}`);
      }
    }
  }

  // 7. Report
  console.log(muted("\n  Summary"));
  console.log(`  Provider     ${provider} (${baseUrl})`);
  console.log(`  Model        ${model}`);
  console.log(`  API key      ${keySource === "env" ? `from ${envVar}` : keySource === "credentials" ? `stored in ${paths.credentials()}` : "none"}`);
  console.log(`  Reachable    ${reachable ? "yes" : "no"}`);
  console.log(`  Inference    ${inferenceOk === null ? "not tested" : inferenceOk ? "ok" : "failed"}`);
  const success = reachable && inferenceOk !== false;
  console.log(`\n  ${success ? c.hex(theme.success)("Setup complete.") + " Run `sutra` in a project directory." : c.hex(theme.error)("Setup incomplete.") + " Fix the issues above and run `sutra init` again."}\n`);
  rl.close();
  return success ? 0 : 1;
}

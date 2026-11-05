import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Chalk } from "chalk";
import { paths } from "../config/paths.js";
import { loadConfig, readCredentials, writeCredentials, writeUserConfig } from "../config/load.js";
import { AGENTS_TEMPLATE } from "../context/instructions.js";
import { DeepSeekProvider } from "../providers/deepseek/provider.js";
import { DEEPSEEK_MODELS } from "../providers/deepseek/models.js";
import { listProviders } from "../providers/registry.js";
import { estimateCost, formatUsd } from "../telemetry/cost.js";
import { darkTheme, type Theme } from "../tui/theme.js";

/** Read a line without echoing it (for API keys). */
async function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  process.stdout.write(prompt);
  if (!stdin.isTTY) {
    const rl = createInterface({ input: stdin });
    for await (const line of rl) {
      rl.close();
      return line.trim();
    }
    return "";
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
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string, def?: string) => {
    const a = (await rl.question(`  ${q}${def ? muted(` [${def}]`) : ""} `)).trim();
    return a || def || "";
  };
  const yes = async (q: string, def = false) => /^y(es)?$/i.test(await ask(`${q} ${def ? "[Y/n]" : "[y/N]"}`, def ? "y" : "n"));

  console.log(`\n  ${accent.bold("सूत्र  Sutra setup")}\n`);
  console.log(muted("  1. Configuration"));
  console.log(`  Sutra keeps user-level state in ${paths.home()}:`);
  console.log(`    config.json       settings (model, permissions, budgets, pricing overrides)`);
  console.log(`    credentials.json  API keys, file mode 600 — never inside a repository`);
  console.log(`    sutra.db          local session history (SQLite, mode 600)`);
  console.log(`  Repositories can add .sutra/AGENTS.md (instructions) and .sutra/config.json (limited, cannot loosen permissions).\n`);

  // 2. Provider
  console.log(muted("  2. Model provider"));
  const providers = listProviders();
  console.log(`  Available: ${providers.join(", ")}`);
  const provider = await ask("Provider:", "deepseek");
  if (provider !== "deepseek") {
    bad(`Provider "${provider}" is not available in this version.`);
    rl.close();
    return 1;
  }

  // 3. Authentication
  console.log(muted("\n  3. Authentication"));
  let key = "";
  let keySource = "";
  if (process.env.DEEPSEEK_API_KEY) {
    console.log("  DEEPSEEK_API_KEY is set in your environment.");
    if (await yes("Use the environment variable (nothing is written to disk)?", true)) {
      key = process.env.DEEPSEEK_API_KEY;
      keySource = "env";
    }
  }
  if (!key && readCredentials().deepseekApiKey) {
    if (await yes(`A key is already stored in ${paths.credentials()}. Keep it?`, true)) {
      key = readCredentials().deepseekApiKey!;
      keySource = "credentials";
    }
  }
  if (!key) {
    console.log(`  Create a key at https://platform.deepseek.com/api_keys. Input is hidden.`);
    rl.pause();
    key = await readSecret("  DeepSeek API key: ");
    rl.resume();
    if (!key) {
      bad("No key entered.");
      rl.close();
      return 1;
    }
    const file = writeCredentials({ deepseekApiKey: key });
    keySource = "credentials";
    ok(`Key stored in ${file} (mode 600). It is never printed or written to the repository.`);
  }

  // Model
  const models = Object.keys(DEEPSEEK_MODELS);
  console.log(`\n  Models: ${models.join(", ")} ${muted("(see https://api-docs.deepseek.com/quick_start/pricing)")}`);
  const model = await ask("Default model:", loadConfig(process.cwd()).config.model ?? "deepseek-flash");
  writeUserConfig({ provider: "deepseek", model });
  ok(`Saved provider and model to ${paths.userConfig()}`);

  // 4. Project instructions
  console.log(muted("\n  4. Project instructions"));
  const agentsPath = join(process.cwd(), ".sutra", "AGENTS.md");
  if (existsSync(agentsPath)) ok(".sutra/AGENTS.md already exists.");
  else if (await yes(`Create .sutra/AGENTS.md in ${process.cwd()}?`, false)) {
    mkdirSync(join(process.cwd(), ".sutra"), { recursive: true });
    writeFileSync(agentsPath, AGENTS_TEMPLATE);
    ok("Created .sutra/AGENTS.md — edit it to describe your project's commands and conventions.");
  }

  // 5. Reachability
  console.log(muted("\n  5. Validating provider"));
  const baseUrl = process.env.DEEPSEEK_BASE_URL ?? loadConfig(process.cwd()).config.providers.deepseek.baseUrl;
  const ds = new DeepSeekProvider({ apiKey: key, baseUrl, timeoutMs: 20_000 });
  let reachable = false;
  try {
    const ids = await ds.listModels(AbortSignal.timeout(20_000));
    reachable = true;
    ok(`Reached ${baseUrl}; account can list ${ids.length} model(s): ${ids.join(", ") || "(none)"}`);
    if (!ids.includes(model)) console.log(`  ${accent("!")} ${model} is not in the provider's list; check the model id.`);
  } catch (err) {
    bad(`Could not reach the provider: ${(err as Error).message}`);
  }

  // 6. Smoke test
  let inferenceOk: boolean | null = null;
  if (reachable) {
    console.log(muted("\n  6. Inference smoke test"));
    if (await yes("Send one tiny request (a few tokens, billed to your account)?", false)) {
      try {
        let text = "";
        let usage = null;
        for await (const ev of ds.generate({ model, messages: [{ role: "user", content: "Reply with the single word: ready" }], thinking: "disabled", maxOutputTokens: 16 }, AbortSignal.timeout(60_000))) {
          if (ev.type === "message_complete") {
            text = ev.message.content;
            usage = ev.usage;
          }
        }
        inferenceOk = true;
        const cfg = loadConfig(process.cwd()).config;
        const cost = usage ? estimateCost(usage, cfg.pricing[model]) : null;
        ok(`Model replied: "${text.trim().slice(0, 40)}" (${usage?.inputTokens ?? "?"} in / ${usage?.outputTokens ?? "?"} out tokens, ~${cost === null ? "unknown" : formatUsd(cost)})`);
      } catch (err) {
        inferenceOk = false;
        bad(`Inference failed: ${(err as Error).message}`);
      }
    }
  }

  // 7. Report
  console.log(muted("\n  Summary"));
  console.log(`  Provider     deepseek (${baseUrl})`);
  console.log(`  Model        ${model}`);
  console.log(`  API key      ${keySource === "env" ? "from DEEPSEEK_API_KEY" : `stored in ${paths.credentials()}`}`);
  console.log(`  Reachable    ${reachable ? "yes" : "no"}`);
  console.log(`  Inference    ${inferenceOk === null ? "not tested" : inferenceOk ? "ok" : "failed"}`);
  const success = reachable && inferenceOk !== false;
  console.log(`\n  ${success ? c.hex(theme.success)("Setup complete.") + " Run `sutra` in a project directory." : c.hex(theme.error)("Setup incomplete.") + " Fix the issues above and run `sutra init` again."}\n`);
  rl.close();
  return success ? 0 : 1;
}

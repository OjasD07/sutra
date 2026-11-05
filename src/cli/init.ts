import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { paths } from "../config/paths.js";
import { loadConfig, readCredentials, writeCredentials, writeUserConfig, type Credentials } from "../config/load.js";
import { AGENTS_TEMPLATE } from "../context/instructions.js";
import { GROUP_LABELS, PROVIDERS, isLocalUrl, presetConfigKey, type ProviderPreset } from "../providers/catalog.js";
import { DeepSeekProvider } from "../providers/deepseek/provider.js";
import { DEEPSEEK_MODELS } from "../providers/deepseek/models.js";
import { ProviderError } from "../providers/errors.js";
import { OpenAICompatibleProvider, type ModelDetails } from "../providers/openai-compatible/provider.js";
import type { TokenUsage } from "../providers/types.js";
import { estimateCost, formatUsd } from "../telemetry/cost.js";
import { darkTheme, type Theme } from "../tui/theme.js";
import { BACK, Prompter, type Choice } from "./prompts.js";

const tilde = (p: string) => (p.startsWith(homedir()) ? "~" + p.slice(homedir().length) : p);

interface Detected {
  envKey: boolean;
  storedKey: string | undefined;
  /** Local servers: models found, or null when nothing answered. */
  running: number | null;
}

function storedKeyFor(p: ProviderPreset, creds: Credentials): string | undefined {
  if (p.id === "deepseek") return creds.deepseekApiKey;
  if (p.id === "openai-compatible") return creds.openaiApiKey;
  return creds.apiKeys?.[p.id];
}

function credentialsUpdate(p: ProviderPreset, key: string): Credentials {
  if (p.id === "deepseek") return { deepseekApiKey: key };
  if (p.id === "openai-compatible") return { openaiApiKey: key };
  return { apiKeys: { [p.id]: key } };
}

function clientFor(p: ProviderPreset, baseUrl: string, key: string | undefined) {
  if (p.id === "deepseek") return new DeepSeekProvider({ apiKey: key ?? "", baseUrl, timeoutMs: 30_000 });
  return new OpenAICompatibleProvider({
    id: p.id,
    displayName: p.name,
    baseUrl,
    dialect: "openai",
    ...(key ? { apiKey: key } : {}),
    ...(p.headers ? { headers: p.headers } : {}),
    timeoutMs: p.local ? 180_000 : 60_000,
  });
}

/** Turn "localhost:1234" or "api.example.com/v1" into a full URL. */
function normaliseUrl(raw: string): string {
  const v = raw.trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(v)) return v;
  return `${/^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(v) ? "http" : "https"}://${v}`;
}

function urlError(raw: string): string | null {
  try {
    const u = new URL(normaliseUrl(raw));
    if (!/^https?:$/.test(u.protocol)) return "Use an http:// or https:// address.";
    if (!u.hostname || (!u.hostname.includes(".") && !["localhost"].includes(u.hostname) && !u.hostname.startsWith("["))) return `"${raw}" doesn't look like a server address. Example: http://localhost:8000/v1`;
    return null;
  } catch {
    return `"${raw}" isn't a valid address. Example: http://localhost:8000/v1`;
  }
}

function explain(err: unknown, p: ProviderPreset, baseUrl: string): { message: string; badKey: boolean } {
  const e = err as ProviderError;
  const status = e instanceof ProviderError ? e.status : undefined;
  if (status === 401 || status === 403) return { message: `${p.name} rejected the key (${status}).`, badKey: true };
  if (status === 404) return { message: `${baseUrl} answered, but has no OpenAI-style /models endpoint there (404). Check the URL; it usually ends in /v1.`, badKey: false };
  const msg = (e?.message ?? String(err)).replace(/\s+/g, " ");
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|EAI_AGAIN|timed out/i.test(msg)) return { message: `Nothing answered at ${baseUrl}.`, badKey: false };
  return { message: msg.slice(0, 200), badKey: false };
}

async function probe(baseUrl: string): Promise<number | null> {
  try {
    const res = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(700) });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: unknown[] };
    return Array.isArray(body.data) ? body.data.length : 0;
  } catch {
    return null;
  }
}

const compact = (n: number) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 0 }).format(n);
const money = (n: number) => (n < 0.1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);
const priceLine = (input: number, output: number, unit = "/1M") => (input === 0 && output === 0 ? "free" : `${money(input)} in · ${money(output)} out ${unit}`);

export async function runInit(opts: { color: boolean; theme?: Theme }): Promise<number> {
  const ui = new Prompter(opts.theme ?? darkTheme, opts.color);
  try {
    return await wizard(ui);
  } catch (err) {
    ui.fail((err as Error).message);
    return 1;
  } finally {
    ui.close();
  }
}

async function wizard(ui: Prompter): Promise<number> {
  const current = loadConfig(process.cwd()).config;
  const creds = readCredentials();

  ui.write();
  ui.write(`  ${ui.accent(ui.bold("सूत्र"))}  ${ui.bold("Sutra setup")}`);
  ui.write(`  ${ui.muted("Choose where your model runs, add a key, pick a model. Settings go to")} ${ui.muted(tilde(paths.userConfig()))}${ui.muted(".")}`);
  ui.write();

  // What's already available: keys in the environment or saved, servers running here.
  const detected = new Map<string, Detected>();
  await ui.spin("Looking for API keys and local model servers", async () => {
    await Promise.all(
      PROVIDERS.map(async (p) => {
        detected.set(p.id, {
          envKey: !!(p.keyEnv && process.env[p.keyEnv]),
          storedKey: storedKeyFor(p, creds),
          running: p.local ? await probe(p.id === "ollama" ? current.providers.ollama.baseUrl : p.baseUrl) : null,
        });
      }),
    );
  });
  const found = [...detected.entries()].filter(([, d]) => d.envKey || d.storedKey || d.running !== null);
  if (found.length) ui.ok(`Found ${found.map(([id, d]) => `${PROVIDERS.find((p) => p.id === id)!.name}${d.running !== null ? " (running)" : ""}`).join(", ")}`);

  const choices: Choice<string>[] = PROVIDERS.map((p) => {
    const d = detected.get(p.id)!;
    const badge = p.local
      ? d.running !== null
        ? `● running · ${d.running} model${d.running === 1 ? "" : "s"}`
        : "not running"
      : d.envKey
        ? `key in $${p.keyEnv}`
        : d.storedKey
          ? "key saved"
          : p.id === current.provider
            ? "current"
            : "";
    return {
      value: p.id,
      label: p.name,
      hint: p.blurb,
      badge,
      badgeTone: d.running !== null || d.envKey || d.storedKey ? "ok" : "muted",
      group: GROUP_LABELS[p.group],
      keywords: `${p.id} ${p.keyEnv ?? ""}`,
    };
  });
  const firstReady = PROVIDERS.find((p) => {
    const d = detected.get(p.id)!;
    return d.envKey || d.storedKey || d.running;
  });

  let preset: ProviderPreset = PROVIDERS.find((p) => p.id === current.provider) ?? firstReady ?? PROVIDERS[0]!;
  let baseUrl = "";
  let key: string | undefined;
  let keySource: "env" | "saved" | "new" | "none" = "none";
  let details: ModelDetails[] = [];
  let listed = false;
  let model = "";

  type Step = "provider" | "endpoint" | "key" | "model" | "test";
  let step: Step = "provider";
  let tested: { ok: boolean; tools: boolean; ms: number; usage: TokenUsage | null } | null = null;
  // Set when a server without a key turned out to want one.
  let askKey = false;
  let attempts = 0;

  while (step !== "test") {
    if (step === "provider") {
      ui.write();
      const pick = await ui.select({ message: "Model provider", choices, initial: preset.id, pageSize: 14 });
      if (pick === BACK) continue;
      preset = PROVIDERS.find((p) => p.id === pick)!;
      askKey = false;
      attempts = 0;
      const section = (current.providers as Record<string, { baseUrl?: string } | undefined>)[presetConfigKey(preset)];
      baseUrl = preset.id === "deepseek" ? (process.env.DEEPSEEK_BASE_URL ?? current.providers.deepseek.baseUrl) : (section?.baseUrl ?? preset.baseUrl);
      if (preset.id === "openai-compatible" && !process.env.OPENAI_BASE_URL && isLocalUrl(baseUrl)) baseUrl = preset.baseUrl;
      if (preset.note) ui.info(preset.note);
      step = preset.id === "custom" || (preset.local && detected.get(preset.id)!.running === null) ? "endpoint" : "key";
      continue;
    }

    if (step === "endpoint") {
      if (preset.local) {
        ui.warn(`${preset.name} isn't answering at ${baseUrl}.`);
        const what = await ui.select({
          message: "What now?",
          filter: false,
          back: true,
          choices: [
            { value: "retry", label: "Check again", hint: `after starting ${preset.name}` },
            { value: "url", label: "Use a different address", hint: "it runs on another port or machine" },
            { value: "other", label: "Choose another provider" },
          ],
        });
        if (what === BACK || what === "other") {
          step = "provider";
          continue;
        }
        if (what === "retry") {
          const n = await ui.spin(`Checking ${baseUrl}`, () => probe(baseUrl));
          if (n !== null) {
            ui.ok(`${preset.name} is running with ${n} model${n === 1 ? "" : "s"}.`);
            detected.set(preset.id, { ...detected.get(preset.id)!, running: n });
            step = "key";
          }
          continue;
        }
      }
      const url = await ui.text({
        message: preset.local ? `${preset.name} address` : "Server address",
        ...(preset.local ? { initial: baseUrl } : { placeholder: "http://localhost:8000/v1" }),
        hint: "the OpenAI-compatible base URL, usually ending in /v1",
        back: true,
        validate: urlError,
      });
      if (url === BACK) {
        step = "provider";
        continue;
      }
      baseUrl = normaliseUrl(url);
      step = "key";
      continue;
    }

    if (step === "key") {
      if (++attempts > 6) throw new Error("Stopped after several failed attempts. Run `sutra init` again when the server and key are ready.");
      const d = detected.get(preset.id)!;
      // A local address usually needs no key; a custom one may still want one.
      const local = (preset.local || isLocalUrl(baseUrl)) && !askKey;
      const optionalKey = preset.id === "custom" || preset.local === true;
      key = undefined;
      keySource = "none";
      if (!local) {
        if (d.envKey && (await ui.confirm({ message: `Use the key in $${preset.keyEnv}? (nothing is saved to disk)`, initial: true }))) {
          key = process.env[preset.keyEnv!];
          keySource = "env";
        } else if (d.storedKey && (await ui.confirm({ message: `Use the ${preset.name} key you saved earlier?`, initial: true }))) {
          key = d.storedKey;
          keySource = "saved";
        }
      }
      if (!key && (!local || preset.id === "custom")) {
        if (preset.keyUrl) ui.info(`Get a key at ${preset.keyUrl}`);
        const entered = await ui.text({ message: `${preset.name} API key`, secret: true, back: true, optional: optionalKey && !askKey, hint: optionalKey && !askKey ? "leave empty if the server needs none" : "input is hidden; paste works" });
        if (entered === BACK) {
          step = "provider";
          continue;
        }
        key = entered || undefined;
        keySource = key ? "new" : "none";
      }

      // Validate by asking for the model list; that also gives us something to pick from.
      const client = clientFor(preset, baseUrl, key);
      try {
        details = await ui.spin(`Connecting to ${preset.name}`, () => client.listModelDetails(AbortSignal.timeout(local ? 30_000 : 20_000)));
        listed = true;
        ui.ok(`Connected to ${preset.name}${details.length ? ` · ${details.length} model${details.length === 1 ? "" : "s"} available` : ""}`);
      } catch (err) {
        const why = explain(err, preset, baseUrl);
        // Some providers (Anthropic's compatibility layer) don't list models with a Bearer key; a real request decides.
        if (!why.badKey && preset.id === "anthropic") {
          details = [];
          listed = false;
        } else {
          ui.fail(why.message);
          if (why.badKey) ui.info(`Check the key${preset.keyUrl ? ` at ${preset.keyUrl}` : ""} and paste it again.`);
          step = why.badKey && keySource !== "env" ? "key" : preset.local || preset.id === "custom" ? "endpoint" : "provider";
          if (why.badKey && keySource === "env") ui.info(`The key comes from $${preset.keyEnv}; fix or unset it, or choose "No" to paste another.`);
          if (why.badKey) {
            detected.set(preset.id, { ...d, envKey: false, storedKey: keySource === "saved" ? undefined : d.storedKey });
            askKey = true;
          }
          continue;
        }
      }
      if (keySource === "new" && key) {
        const file = writeCredentials(credentialsUpdate(preset, key));
        ui.ok(`Key saved to ${tilde(file)} (only you can read it)`);
      }
      step = "model";
      continue;
    }

    if (step === "model") {
      // OpenRouter and friends say which models take tools; Sutra needs tool calls.
      const withTools = details.filter((m) => m.tools !== false);
      const hidden = details.length - withTools.length;
      const pool = preset.id === "deepseek" ? Object.keys(DEEPSEEK_MODELS).map((id) => details.find((m) => m.id === id) ?? { id }) : withTools;
      const suggested = (preset.suggested ?? []).filter((id) => pool.some((m) => m.id === id));
      const ordered = [...suggested.map((id) => pool.find((m) => m.id === id)!), ...pool.filter((m) => !suggested.includes(m.id)).sort((a, b) => a.id.localeCompare(b.id))];
      const priceOf = (m: ModelDetails) => {
        if (m.pricePerM) return priceLine(m.pricePerM.input, m.pricePerM.output);
        const p = current.pricing[m.id];
        return p ? priceLine(p.inputCacheMiss, p.output) : "";
      };
      if (!ordered.length) {
        if (listed) ui.warn(`${preset.name} reported no models${hidden ? ` that support tool calls (${hidden} without)` : ""}.${preset.local ? ` Download one in ${preset.name} first.` : ""}`);
        const typed = await ui.text({ message: "Model id", ...(preset.suggested?.[0] ? { initial: preset.suggested[0] } : {}), back: true });
        if (typed === BACK) {
          step = "provider";
          continue;
        }
        model = typed;
      } else {
        const initial = ordered.find((m) => m.id === current.model)?.id ?? ordered[0]!.id;
        const pick = await ui.select({
          message: "Model",
          back: true,
          initial,
          pageSize: 12,
          ...(hidden ? { footer: `${hidden} without tool support hidden` } : {}),
          choices: ordered.map((m) => ({
            value: m.id,
            label: m.id,
            hint: [m.contextWindow ? `${compact(m.contextWindow)} context` : "", priceOf(m)].filter(Boolean).join(" · "),
            ...(suggested.includes(m.id) ? { badge: "suggested", badgeTone: "ok" as const, group: "Suggested" } : { group: suggested.length ? "All models" : undefined }),
            keywords: m.name ?? "",
          })) as Choice<string>[],
        });
        if (pick === BACK) {
          step = "key";
          continue;
        }
        model = pick;
      }
      step = "test";
    }
  }

  // Check that the model answers and can call a tool, which every Sutra turn needs.
  const local = preset.local || isLocalUrl(baseUrl);
  const chosen = details.find((m) => m.id === model);
  const runTest = local || (await ui.confirm({ message: "Send a short test request to check the model can call tools? (a few hundred tokens)", initial: true }));
  if (runTest) {
    const client = clientFor(preset, baseUrl, key);
    const started = Date.now();
    try {
      tested = await ui.spin(`Asking ${model} to call a test tool${preset.local ? " (a local model may take a while to load)" : ""}`, async () => {
        let usage: TokenUsage | null = null;
        let tools = false;
        for await (const ev of client.generate(
          {
            model,
            messages: [
              { role: "system", content: "You are testing tool use. Call the tool you are given; do not answer in text." },
              { role: "user", content: "Call sutra_ping with message \"ready\"." },
            ],
            tools: [{ name: "sutra_ping", description: "Confirms the connection works.", parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } }],
            maxOutputTokens: 400,
            ...(preset.id === "deepseek" ? { thinking: "disabled" as const } : {}),
          },
          AbortSignal.timeout(local ? 300_000 : 60_000),
        )) {
          if (ev.type === "message_complete") {
            usage = ev.usage;
            tools = !!ev.message.toolCalls?.some((c) => c.name === "sutra_ping");
          }
        }
        return { ok: true, tools, ms: Date.now() - started, usage };
      });
      if (tested.tools) ui.ok(`${model} called the test tool in ${(tested.ms / 1000).toFixed(1)} s`);
      else ui.warn(`${model} answered but didn't call the tool. Sutra works through tool calls, so pick a model that supports them (run \`sutra init\` again).`);
    } catch (err) {
      tested = { ok: false, tools: false, ms: Date.now() - started, usage: null };
      ui.fail(`The test request failed: ${explain(err, preset, baseUrl).message}`);
    }
  }

  // Save.
  const cfgKey = presetConfigKey(preset);
  const section: Record<string, unknown> = {};
  if (preset.id !== "deepseek" && (baseUrl !== preset.baseUrl || preset.id === "custom" || preset.id === "openai-compatible" || preset.id === "ollama")) section.baseUrl = baseUrl;
  if (preset.id === "openai-compatible" && local) section.freeOfCharge = true;
  if (chosen?.contextWindow && preset.id !== "deepseek") section.models = { [model]: { contextWindow: chosen.contextWindow } };
  const update: Record<string, unknown> = { provider: preset.id, model };
  if (Object.keys(section).length) update.providers = { [cfgKey]: section };
  if (chosen?.pricePerM && !current.pricing[model])
    update.pricing = { [model]: { inputCacheMiss: chosen.pricePerM.input, inputCacheHit: chosen.pricePerM.cachedInput, output: chosen.pricePerM.output, currency: "USD", source: `${preset.name} /models`, asOf: new Date().toISOString().slice(0, 10) } };
  writeUserConfig(update);

  // Project instructions, only inside a project.
  const agentsPath = join(process.cwd(), ".sutra", "AGENTS.md");
  const inProject = ["package.json", ".git", "pyproject.toml", "Cargo.toml", "go.mod"].some((f) => existsSync(join(process.cwd(), f)));
  let agents = existsSync(agentsPath) ? "exists" : "no";
  if (agents === "no" && inProject && (await ui.confirm({ message: `Add .sutra/AGENTS.md to this project for its commands and conventions?`, initial: false }))) {
    mkdirSync(join(process.cwd(), ".sutra"), { recursive: true });
    writeFileSync(agentsPath, AGENTS_TEMPLATE);
    agents = "created";
  }

  // Summary.
  const price = (() => {
    if (chosen?.pricePerM) return priceLine(chosen.pricePerM.input, chosen.pricePerM.output, "per 1M tokens");
    const p = current.pricing[model];
    if (p) return priceLine(p.inputCacheMiss, p.output, "per 1M tokens");
    return local ? "free (runs on this machine)" : "not known; /cost will show tokens only";
  })();
  const costOfTest = tested?.usage ? (() => {
    const p = current.pricing[model] ?? (chosen?.pricePerM ? { inputCacheMiss: chosen.pricePerM.input, inputCacheHit: chosen.pricePerM.cachedInput, output: chosen.pricePerM.output, currency: "USD" as const } : undefined);
    const usd = p ? estimateCost(tested.usage!, p) : null;
    return usd === null || usd === 0 ? "" : ` · cost ${formatUsd(usd)}`;
  })() : "";
  const good = !tested || (tested.ok && tested.tools);
  ui.write();
  ui.box(good ? "Sutra is ready" : "Saved, with a warning", [
    ["Provider", `${preset.name}${preset.id === "custom" || baseUrl !== preset.baseUrl ? ui.muted(`  ${baseUrl}`) : ""}`],
    ["Model", model],
    ["Price", price],
    ["Key", keySource === "env" ? `from $${preset.keyEnv} (not saved)` : keySource === "saved" || keySource === "new" ? `saved in ${tilde(paths.credentials())}` : local ? "not needed" : "none"],
    ["Test", !tested ? "skipped" : !tested.ok ? ui.errc("request failed") : tested.tools ? ui.okc(`tool call works · ${(tested.ms / 1000).toFixed(1)} s${costOfTest}`) : ui.accent("no tool call; pick another model")],
    ...(agents === "created" ? ([["Project", ".sutra/AGENTS.md created; describe your commands there"]] as [string, string][]) : []),
  ], good ? "ok" : "warn");
  ui.write();
  ui.write(`  ${ui.muted("Start:")} ${ui.bold("sutra")}  ${ui.muted("in any project ·")} ${ui.bold("sutra -p \"…\"")} ${ui.muted("for one-off tasks · switch models with")} ${ui.bold("/model")}`);
  ui.write();
  return tested && !tested.ok ? 1 : 0;
}

import { paths } from "../config/paths.js";
import { loadConfig } from "../config/load.js";
import { openSession } from "../core/session.js";
import { setLanguage, t } from "../i18n/index.js";
import { SessionStore } from "../memory/store.js";
import { canonicalize } from "../permissions/paths.js";
import { createProvider } from "../providers/registry.js";
import { initLogger, log } from "../telemetry/logger.js";
import { colorEnabled, detectTheme } from "../tui/theme.js";
import { version } from "../version.js";
import { HELP, parseCli } from "./args.js";
import { runHeadless } from "./headless.js";
import { runInit } from "./init.js";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

export async function main(argv: string[]): Promise<number> {
  let args;
  try {
    args = parseCli(argv);
  } catch (err) {
    process.stderr.write(`sutra: ${(err as Error).message}\n\n${HELP}\n`);
    return 2;
  }
  if (args.command === "help") {
    process.stdout.write(HELP + "\n");
    return 0;
  }
  if (args.command === "version") {
    process.stdout.write(`sutra ${version()}\n`);
    return 0;
  }

  const color = args.color && colorEnabled();
  const workspaceRoot = canonicalize(process.cwd());
  initLogger({ debug: args.debug });

  let loaded;
  try {
    loaded = loadConfig(workspaceRoot, {
      ...(args.model ? { model: args.model } : {}),
      ...(args.profile ? { profile: args.profile } : {}),
      ...(args.thinking ? { thinking: args.thinking } : {}),
    });
  } catch (err) {
    process.stderr.write(`sutra: ${(err as Error).message}\n`);
    return 1;
  }
  const { config, warnings } = loaded;
  setLanguage((args.lang ?? process.env.SUTRA_LANG ?? config.ui.language) === "hi" ? "hi" : "en");
  const theme = detectTheme(args.theme ?? config.ui.theme);

  if (args.command === "init") return runInit({ color, theme });

  if (!config.providers.deepseek.apiKey && config.provider === "deepseek") {
    process.stderr.write(`${t("noApiKey")}\n`);
    return 1;
  }

  const provider = createProvider(config);
  const store = new SessionStore(paths.database());

  let resumeId: string | undefined = args.session;
  if (args.resume && !resumeId) {
    const latest = store.latestSession(workspaceRoot);
    if (!latest) {
      process.stderr.write("No previous session in this directory.\n");
      store.close();
      return 1;
    }
    resumeId = latest.id;
  }

  const interactive = !args.print && process.stdin.isTTY === true && process.stdout.isTTY === true;
  log().info({ workspace: workspaceRoot, model: config.model, profile: config.permissions.profile, interactive, resume: !!resumeId }, "start");

  try {
    if (!interactive) {
      const prompt = [args.prompt, await readStdin()].filter(Boolean).join("\n\n");
      if (!prompt) {
        process.stderr.write("No prompt given. Usage: sutra -p \"your task\"  (or pipe text on stdin)\n");
        return 2;
      }
      for (const w of warnings) process.stderr.write(`[warn] ${w}\n`);
      const session = openSession({ config, provider, store, workspaceRoot, approve: async () => "deny", ...(resumeId ? { resumeId } : {}) });
      if (session.repairedToolCalls) process.stderr.write(`[info] repaired ${session.repairedToolCalls} interrupted tool call(s) from the previous run\n`);
      const result = await runHeadless(session, prompt, { theme, color, json: args.json });
      return result.status === "completed" ? 0 : result.status === "cancelled" ? 130 : 1;
    }

    const [{ render }, React, { App, ApprovalBridge }] = await Promise.all([import("ink"), import("react"), import("../tui/App.js")]);
    const bridge = new ApprovalBridge();
    const make = (id?: string) => openSession({ config, provider, store, workspaceRoot, approve: bridge.request, ...(id ? { resumeId: id } : {}) });
    const session = make(resumeId);
    const notices = [...warnings];
    if (session.repairedToolCalls) notices.push(`Repaired ${session.repairedToolCalls} tool call(s) interrupted in the previous run.`);
    if (session.instructions.length) notices.push(`Instructions: ${session.instructions.map((i) => i.path).join(", ")}`);
    const instance = render(
      React.createElement(App, {
        ui: { theme, color },
        config,
        store,
        provider,
        bridge,
        initialSession: session,
        newSession: () => make(),
        notices,
        ...(args.prompt ? { initialPrompt: args.prompt } : {}),
      }),
      { exitOnCtrlC: false, patchConsole: true },
    );
    await instance.waitUntilExit();
    process.stdout.write(`\nSession ${session.record.id.slice(0, 8)} saved. Resume with: sutra --resume\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`sutra: ${(err as Error).message}\n`);
    log().error({ err: (err as Error).message }, "fatal");
    return 1;
  } finally {
    store.close();
  }
}


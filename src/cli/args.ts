import { parseArgs } from "node:util";
import type { PermissionProfile } from "../config/schema.js";

export interface CliArgs {
  command: "run" | "init" | "help" | "version";
  prompt?: string;
  resume: boolean;
  session?: string;
  model?: string;
  profile?: PermissionProfile;
  debug: boolean;
  color: boolean;
  print: boolean;
  json: boolean;
  theme?: "auto" | "dark" | "light";
  lang?: "en" | "hi";
  thinking?: "enabled" | "disabled";
}

export const HELP = `Sutra (सूत्र) — the thread that connects intelligence to action.

Usage
  sutra [options] [prompt]       Start an interactive session (optionally with a first prompt)
  sutra init                     Guided setup: provider, API key, project instructions
  sutra -p "prompt"              Run one task non-interactively and exit

Options
  --resume                       Resume the most recent session in this directory
  --session <id>                 Resume a specific session (id or unique prefix)
  --model <id>                   Model to use (e.g. deepseek-flash, deepseek-v4-pro)
  --readonly                     Inspect profile: read-only tools, no edits or commands
  --profile <inspect|confirm|flow>
                                 Permission profile (default: confirm)
  --no-thinking                  Disable the model's thinking mode
  -p, --print                    Non-interactive: print the answer to stdout, activity to stderr
  --json                         With --print: emit runtime events as JSON lines
  --no-color                     Disable colour (NO_COLOR is also honoured)
  --theme <auto|dark|light>      Colour theme for the terminal background
  --lang <en|hi>                 Interface language
  --debug                        Verbose structured log at ~/.sutra/logs/sutra.log
  -h, --help                     Show this help
  -v, --version                  Show version

Environment
  DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL, DEEPSEEK_MODEL, SUTRA_HOME, SUTRA_PROFILE, NO_COLOR

Docs: README.md, docs/configuration.md, docs/security.md`;

export function parseCli(argv: string[]): CliArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      resume: { type: "boolean", default: false },
      session: { type: "string" },
      model: { type: "string" },
      readonly: { type: "boolean", default: false },
      profile: { type: "string" },
      debug: { type: "boolean", default: false },
      "no-color": { type: "boolean", default: false },
      print: { type: "boolean", short: "p", default: false },
      json: { type: "boolean", default: false },
      theme: { type: "string" },
      lang: { type: "string" },
      "no-thinking": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });

  if (values.profile && !["inspect", "confirm", "flow"].includes(values.profile)) throw new Error(`--profile must be inspect, confirm or flow`);
  if (values.theme && !["auto", "dark", "light"].includes(values.theme)) throw new Error(`--theme must be auto, dark or light`);
  if (values.lang && !["en", "hi"].includes(values.lang)) throw new Error(`--lang must be en or hi`);
  if (values.readonly && values.profile && values.profile !== "inspect") throw new Error("--readonly conflicts with --profile " + values.profile);

  const command = values.help ? "help" : values.version ? "version" : positionals[0] === "init" && positionals.length === 1 ? "init" : "run";
  const prompt = command === "run" && positionals.length ? positionals.join(" ") : undefined;
  return {
    command,
    ...(prompt ? { prompt } : {}),
    resume: values.resume,
    ...(values.session ? { session: values.session } : {}),
    ...(values.model ? { model: values.model } : {}),
    ...(values.readonly ? { profile: "inspect" as const } : values.profile ? { profile: values.profile as PermissionProfile } : {}),
    debug: values.debug,
    color: !values["no-color"],
    print: values.print,
    json: values.json,
    ...(values.theme ? { theme: values.theme as CliArgs["theme"] } : {}),
    ...(values.lang ? { lang: values.lang as "en" | "hi" } : {}),
    ...(values["no-thinking"] ? { thinking: "disabled" as const } : {}),
  };
}

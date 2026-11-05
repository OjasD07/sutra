import { parseArgs } from "node:util";
import type { PermissionProfile } from "../config/schema.js";

export type Command = "run" | "init" | "help" | "version" | "bench" | "replay" | "export";

export interface CliArgs {
  command: Command;
  prompt?: string;
  /** Session id for replay/export (default: latest in this directory). */
  target?: string;
  resume: boolean;
  session?: string;
  provider?: string;
  model?: string;
  profile?: PermissionProfile;
  sandbox?: "auto" | "required" | "off";
  /** --no-index: skip the repository index (map, find_symbol, code_search). */
  index: boolean;
  quality?: "fast" | "balanced" | "deep";
  debug: boolean;
  color: boolean;
  print: boolean;
  json: boolean;
  theme?: "auto" | "dark" | "light";
  lang?: "en" | "hi";
  thinking?: "enabled" | "disabled";
  /** export: md | json */
  format?: "md" | "json";
  /** export/bench: output file */
  out?: string;
  /** bench: directory of tasks, and an optional comma-separated task filter */
  tasks?: string;
  only?: string[];
  /** bench: per-task spend limit in USD */
  maxCost?: number;
}

export const HELP = `Sutra (सूत्र) — the thread that connects intelligence to action.

Usage
  sutra [options] [prompt]       Start an interactive session (optionally with a first prompt)
  sutra -p "prompt"              Run one task non-interactively and exit
  sutra init                     Guided setup: provider, API key, project instructions
  sutra replay [id]              Show a saved session as a timeline (default: latest here)
  sutra export [id]              Write an audit report of a session (--format md|json, --out file)
  sutra bench                    Run the benchmark tasks and report pass rate, cost and time

Options
  --resume                       Resume the most recent session in this directory
  --session <id>                 Resume a specific session (id or unique prefix)
  --provider <id>                deepseek (default) | ollama | openai-compatible
  --model <id>                   Model to use (e.g. deepseek-flash, qwen3-coder)
  --readonly                     Inspect profile: read-only tools, no edits or commands
  --profile <inspect|confirm|flow>
                                 Permission profile (default: confirm)
  --sandbox <auto|required|off>  OS sandbox for commands (default: auto)
  --no-index                     Skip the repository index (map, find_symbol, code_search)
  --quality <fast|balanced|deep> How much verification to spend per turn (default: balanced)
  --no-thinking                  Disable the model's thinking mode
  -p, --print                    Non-interactive: print the answer to stdout, activity to stderr
  --json                         With --print: emit runtime events as JSON lines
  --no-color                     Disable colour (NO_COLOR is also honoured)
  --theme <auto|dark|light>      Colour theme for the terminal background
  --lang <en|hi>                 Interface language
  --debug                        Verbose structured log at ~/.sutra/logs/sutra.log
  -h, --help                     Show this help
  -v, --version                  Show version

Bench options
  --tasks <dir>                  Task directory (default: the bundled benchmarks/tasks)
  --only <a,b>                   Run only these tasks
  --max-cost <usd>               Spend limit per task (default 0.50)
  --out <file>                   Also write the JSON results here

Environment
  DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL, DEEPSEEK_MODEL, OPENAI_API_KEY, OPENAI_BASE_URL,
  OLLAMA_HOST, SUTRA_PROVIDER, SUTRA_MODEL, SUTRA_PROFILE, SUTRA_HOME, NO_COLOR

Docs: README.md, docs/configuration.md, docs/security.md`;

const SUBCOMMANDS = new Set(["init", "bench", "replay", "export"]);
const SESSION_ID = /^[0-9a-f][0-9a-f-]{3,}$/i;

export function parseCli(argv: string[]): CliArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      resume: { type: "boolean", default: false },
      session: { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      readonly: { type: "boolean", default: false },
      profile: { type: "string" },
      sandbox: { type: "string" },
      "no-index": { type: "boolean", default: false },
      quality: { type: "string" },
      debug: { type: "boolean", default: false },
      "no-color": { type: "boolean", default: false },
      print: { type: "boolean", short: "p", default: false },
      json: { type: "boolean", default: false },
      theme: { type: "string" },
      lang: { type: "string" },
      "no-thinking": { type: "boolean", default: false },
      format: { type: "string" },
      out: { type: "string" },
      tasks: { type: "string" },
      only: { type: "string" },
      "max-cost": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });

  if (values.profile && !["inspect", "confirm", "flow"].includes(values.profile)) throw new Error(`--profile must be inspect, confirm or flow`);
  if (values.theme && !["auto", "dark", "light"].includes(values.theme)) throw new Error(`--theme must be auto, dark or light`);
  if (values.lang && !["en", "hi"].includes(values.lang)) throw new Error(`--lang must be en or hi`);
  if (values.sandbox && !["auto", "required", "off"].includes(values.sandbox)) throw new Error(`--sandbox must be auto, required or off`);
  if (values.format && !["md", "json"].includes(values.format)) throw new Error(`--format must be md or json`);
  if (values.quality && !["fast", "balanced", "deep"].includes(values.quality)) throw new Error(`--quality must be fast, balanced or deep`);
  if (values.readonly && values.profile && values.profile !== "inspect") throw new Error("--readonly conflicts with --profile " + values.profile);
  const maxCost = values["max-cost"] !== undefined ? Number(values["max-cost"]) : undefined;
  if (maxCost !== undefined && !(maxCost > 0)) throw new Error("--max-cost must be a positive number of USD");

  // A subcommand is recognised only in its exact shape, so a prompt that merely
  // starts with the word ("replay the last request") still runs as a prompt.
  let command: Command = "run";
  let target: string | undefined;
  const [first, second, ...rest] = positionals;
  if (values.help) command = "help";
  else if (values.version) command = "version";
  else if (first && SUBCOMMANDS.has(first) && rest.length === 0) {
    if (first === "init" || first === "bench") {
      if (second === undefined) command = first;
    } else if (second === undefined || SESSION_ID.test(second)) {
      command = first as Command;
      target = second;
    }
  }
  const prompt = command === "run" && positionals.length ? positionals.join(" ") : undefined;
  return {
    command,
    ...(prompt ? { prompt } : {}),
    ...(target ? { target } : {}),
    resume: values.resume,
    ...(values.session ? { session: values.session } : {}),
    ...(values.provider ? { provider: values.provider } : {}),
    ...(values.model ? { model: values.model } : {}),
    ...(values.readonly ? { profile: "inspect" as const } : values.profile ? { profile: values.profile as PermissionProfile } : {}),
    ...(values.sandbox ? { sandbox: values.sandbox as CliArgs["sandbox"] } : {}),
    index: !values["no-index"],
    ...(values.quality ? { quality: values.quality as CliArgs["quality"] } : {}),
    debug: values.debug,
    color: !values["no-color"],
    print: values.print,
    json: values.json,
    ...(values.theme ? { theme: values.theme as CliArgs["theme"] } : {}),
    ...(values.lang ? { lang: values.lang as "en" | "hi" } : {}),
    ...(values["no-thinking"] ? { thinking: "disabled" as const } : {}),
    ...(values.format ? { format: values.format as "md" | "json" } : {}),
    ...(values.out ? { out: values.out } : {}),
    ...(values.tasks ? { tasks: values.tasks } : {}),
    ...(values.only ? { only: values.only.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
    ...(maxCost !== undefined ? { maxCost } : {}),
  };
}

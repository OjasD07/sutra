import { homedir } from "node:os";
import type { PermissionProfile, SutraConfig } from "../config/schema.js";
import type { SessionHandle } from "../core/session.js";
import type { SessionStore } from "../memory/store.js";
import type { ModelProvider } from "../providers/types.js";
import { formatUsd, type UsageTotals } from "../telemetry/cost.js";
import { sandboxSummary } from "../sandbox/sandbox.js";
import { exportAudit } from "./audit-command.js";

export interface CommandContext {
  session: SessionHandle;
  config: SutraConfig;
  store: SessionStore;
  provider: ModelProvider;
  signal?: AbortSignal;
}

export interface CommandResult {
  output: string;
  action?: "exit" | "clear" | "resume";
  /** For action "resume": the session to switch to. */
  sessionId?: string;
}

export const COMMANDS: { name: string; args?: string; help: string }[] = [
  { name: "help", help: "Show commands and keys" },
  { name: "model", args: "[id]", help: "Show or switch the model" },
  { name: "status", help: "Session, model, context and permission status" },
  { name: "cost", help: "Token usage and estimated spend" },
  { name: "budget", args: "[usd|off]", help: "Show or set the session spend limit" },
  { name: "plan", help: "Show the current plan" },
  { name: "compact", help: "Summarise older context now" },
  { name: "clear", help: "Start a fresh session (history stays on disk)" },
  { name: "permissions", args: "[inspect|confirm|flow]", help: "Show or change the permission profile" },
  { name: "sessions", args: "[id]", help: "Browse recent sessions in this workspace and resume one" },
  { name: "resume", args: "<id>", help: "Switch to a saved session" },
  { name: "export", args: "[md|json]", help: "Write an audit report of this session (~/.sutra/exports)" },
  { name: "exit", help: "Exit Sutra" },
];

const n = (v: number) => v.toLocaleString("en-US");

export function tildify(p: string): string {
  const home = homedir();
  return p === home ? "~" : p.startsWith(home + "/") ? "~" + p.slice(home.length) : p;
}

export function formatCost(t: UsageTotals): string {
  return t.costIncomplete ? `${formatUsd(t.costUsd)} (incomplete: some requests had no configured price)` : formatUsd(t.costUsd);
}

export function costReport(t: UsageTotals, config: SutraConfig, model: string): string {
  const price = config.pricing[model];
  const rows: [string, string][] = [
    ["Input tokens", n(t.inputTokens)],
    ["  cached (hit)", n(t.cachedInputTokens)],
    ["Output tokens", n(t.outputTokens)],
    ["  reasoning", n(t.reasoningTokens)],
    ["API requests", n(t.requests)],
    ["Tool calls", n(t.toolCalls)],
    ["Model latency", `${(t.modelLatencyMs / 1000).toFixed(1)}s`],
    ["Tool latency", `${(t.toolLatencyMs / 1000).toFixed(1)}s`],
    ["", ""],
    ["Estimated cost", formatCost(t)],
  ];
  const limit = config.budget.maxSessionCostUsd;
  if (limit) rows.push(["Budget", `${formatUsd(limit)} (${Math.min(100, (t.costUsd / limit) * 100).toFixed(0)}% used)`]);
  const body = rows.map(([k, v]) => (k ? `${k.padEnd(18)}${v}` : "")).join("\n");
  const note = price
    ? `Pricing for ${model}${price.asOf ? ` as of ${price.asOf}` : ""}${price.source ? ` (${price.source})` : ""}; override in ~/.sutra/config.json.`
    : `No price configured for ${model}; add pricing.${model} to ~/.sutra/config.json.`;
  return `Session usage\n\n${body}\n\n${note}`;
}

export async function runSlashCommand(input: string, ctx: CommandContext): Promise<CommandResult> {
  const [rawName, ...rest] = input.slice(1).trim().split(/\s+/);
  const name = (rawName ?? "").toLowerCase();
  const arg = rest.join(" ").trim();
  const { session, config, store, provider } = ctx;
  const rt = session.runtime;

  switch (name) {
    case "help":
    case "?": {
      const cmds = COMMANDS.map((c) => `  /${(c.name + (c.args ? " " + c.args : "")).padEnd(32)}${c.help}`).join("\n");
      return {
        output: `Commands  (type / to browse; ▾ commands open a list of choices)\n${cmds}\n\nKeys\n  Enter        send\n  Esc          cancel the running turn\n  Ctrl+C       cancel, or exit when idle (twice)\n  Up / Down    input history\n\nApproval prompts: y = yes once, a = allow for this session, n / Enter = no.`,
      };
    }
    case "model": {
      if (!arg) {
        const models = provider.getCapabilities().models.map((m) => `  ${m.id === rt.model ? "●" : " "} ${m.id}  (context ${n(m.contextWindow)})`);
        return { output: `Current model: ${rt.model}\n\nKnown ${provider.displayName} models:\n${models.join("\n")}\n\nSwitch with /model <id>.` };
      }
      const known = provider.getCapabilities().models.some((m) => m.id === arg);
      rt.setModel(arg);
      config.model = arg;
      return { output: `Model set to ${arg}.${known ? "" : " (not in Sutra's model list; using conservative defaults for limits)"}` };
    }
    case "status": {
      const info = provider.getModelInfo(rt.model);
      const est = rt.contextTokens();
      const lines = [
        `Session      ${session.record.id}${session.resumed ? " (resumed)" : ""}`,
        `Workspace    ${tildify(session.workspace.root)}`,
        `Provider     ${provider.displayName}`,
        `Model        ${rt.model} (context ${n(info.contextWindow)}, budget ${n(session.context.budget.limit)})`,
        `Thinking     ${info.supportsThinking ? `${config.thinking} (effort ${config.reasoningEffort})` : "not supported"}`,
        `Permission   ${session.permissions.policy.profile}`,
        `Sandbox      ${sandboxSummary(session.sandbox)}`,
        `Context      ~${n(est)} tokens per request; compacts at ${(session.context.budget.threshold * 100).toFixed(0)}%`,
        `Instructions ${session.instructions.length ? session.instructions.map((i) => i.path).join(", ") : "none"}`,
        `Spend        ${formatCost(session.usage.totals)}`,
      ];
      return { output: lines.join("\n") };
    }
    case "cost":
      return { output: costReport(session.usage.totals, config, rt.model) };
    case "budget": {
      if (!arg) {
        const l = config.budget.maxSessionCostUsd;
        return { output: l ? `Session budget: ${formatUsd(l)} (spent ${formatCost(session.usage.totals)}).` : "No session budget set. Use /budget <usd>." };
      }
      if (arg === "off") {
        delete config.budget.maxSessionCostUsd;
        return { output: "Session budget removed." };
      }
      const v = Number(arg.replace(/^\$/, ""));
      if (!Number.isFinite(v) || v <= 0) return { output: "Usage: /budget <usd>  e.g. /budget 0.50" };
      config.budget.maxSessionCostUsd = v;
      return { output: `Session budget set to ${formatUsd(v)}.` };
    }
    case "plan":
      return { output: session.plan.render() };
    case "compact": {
      if (rt.isRunning) return { output: "Wait for the current turn to finish (or cancel it) before compacting." };
      const did = await rt.compact(true, ctx.signal);
      return { output: did ? "" : "Nothing to compact yet." };
    }
    case "clear":
      return { output: "Starting a fresh session.", action: "clear" };
    case "permissions": {
      if (!arg) {
        const grants = session.permissions.listGrants();
        return {
          output: `Permission profile: ${session.permissions.policy.profile}\n\n  inspect  read-only; no edits, no commands\n  confirm  reads automatic; edits and commands need approval (default)\n  flow     routine edits/commands automatic; risky actions still need approval\n\nSession grants: ${grants.length ? grants.join(", ") : "none"}\nApprovals are an application-level gate, not an OS sandbox. See docs/security.md.`,
        };
      }
      if (!["inspect", "confirm", "flow"].includes(arg)) return { output: "Usage: /permissions inspect|confirm|flow" };
      if (arg === "inspect" || session.permissions.policy.profile === "inspect")
        return { output: "Switching to or from inspect changes the available tool set; restart with --readonly or without it." };
      session.permissions.setProfile(arg as PermissionProfile);
      store.updateSession(session.record.id, { profile: arg });
      return { output: `Permission profile set to ${arg}. Session grants cleared.` };
    }
    case "sessions": {
      if (arg) return runSlashCommand(`/resume ${arg}`, ctx);
      const list = store.listSessions(session.workspace.root, 15);
      if (!list.length) return { output: "No sessions for this workspace." };
      const rows = list.map((s) => `  ${s.id.slice(0, 8)}  ${s.updatedAt.slice(0, 16).replace("T", " ")}  ${s.status.padEnd(15)} ${s.title ?? "(untitled)"}${s.id === session.record.id ? "  ← current" : ""}`);
      return { output: `Recent sessions\n${rows.join("\n")}\n\nResume one with /resume <id>, or type /sessions and pick from the list.` };
    }
    case "export": {
      const format = (arg || "md").toLowerCase();
      if (format !== "md" && format !== "json") return { output: "Usage: /export [md|json]" };
      const file = exportAudit(store, session.record.id, format);
      return { output: `Wrote a ${format === "md" ? "Markdown" : "JSON"} audit of this session to ${tildify(file)}\nReplay it any time with: sutra replay ${session.record.id.slice(0, 8)}` };
    }
    case "resume": {
      if (!arg) return { output: "Usage: /resume <session id>  (or pick one with /sessions)" };
      if (rt.isRunning) return { output: "Wait for the current turn to finish (or cancel it) before switching sessions." };
      const target = store.getSession(arg);
      if (!target) return { output: `No session matching "${arg}".` };
      if (target.id === session.record.id) return { output: "That is the current session." };
      if (target.workspace !== session.workspace.root) return { output: `Session ${target.id.slice(0, 8)} belongs to ${tildify(target.workspace)}; run Sutra there to resume it.` };
      return { output: "", action: "resume", sessionId: target.id };
    }
    case "exit":
    case "quit":
      return { output: "", action: "exit" };
    default:
      return { output: `Unknown command /${name}. Type /help.` };
  }
}

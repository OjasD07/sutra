import { Chalk } from "chalk";
import type { Theme } from "../tui/theme.js";
import { formatUsd } from "../telemetry/cost.js";
import { oneLine, truncateMiddle } from "../utils/text.js";
import type { AuditTool, SessionAudit } from "./audit.js";

const n = (v: number) => v.toLocaleString("en-US");
const time = (iso: string) => iso.slice(11, 19);
const secs = (ms: number | null | undefined) => (ms === null || ms === undefined ? "" : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

/** Short description of a tool call's target, from its arguments. */
export function toolTarget(t: AuditTool): string {
  const a = (t.arguments && typeof t.arguments === "object" ? t.arguments : {}) as Record<string, unknown>;
  const v = a.path ?? a.command ?? a.pattern ?? a.query ?? (t.data?.command as string | undefined) ?? (Array.isArray(a.steps) ? `${a.steps.length} steps` : undefined);
  return typeof v === "string" ? v : v === undefined ? "" : String(v);
}

function toolResult(t: AuditTool): string {
  const d = t.data ?? {};
  if (t.status === "denied") return "denied";
  if (t.status === "cancelled") return "cancelled";
  if (t.status === "unrecorded") return "interrupted";
  if (t.status === "error") return oneLine(t.output.replace(/^Error \([^)]*\): /, ""), 80);
  if ("exitCode" in d) return `exit ${d.exitCode}`;
  if (typeof d.added === "number") return `+${d.added} −${d.removed}`;
  if (typeof d.lines === "number") return `${d.lines} lines`;
  if (typeof d.matches === "number") return `${d.matches} matches`;
  return "ok";
}

const glyph = (t: AuditTool) => (t.status === "ok" ? "✓" : t.status === "error" ? "✗" : t.status === "denied" ? "⊘" : "–");

/** Terminal timeline for `sutra replay`. */
export function renderReplay(a: SessionAudit, opts: { theme: Theme; color: boolean; width?: number }): string {
  const c = opts.color ? new Chalk() : new Chalk({ level: 0 });
  const th = opts.theme;
  const accent = c.hex(th.accent);
  const muted = c.hex(th.muted);
  const width = Math.min(opts.width ?? 100, 120);
  const out: string[] = [];
  const s = a.session;
  out.push(`${accent.bold("Sutra")} ${muted("/")} replay ${s.id.slice(0, 8)}  ${muted(s.title ?? "")}`);
  out.push(muted(`${s.createdAt.slice(0, 16).replace("T", " ")} → ${s.updatedAt.slice(0, 16).replace("T", " ")} · ${s.provider} · ${s.model} · ${s.profile} · ${s.status}`));
  for (const turn of a.turns) {
    out.push("");
    out.push(`${muted(time(turn.at))}  ${accent.bold("›")} ${c.bold(oneLine(turn.prompt, width - 14))}`);
    for (const step of turn.steps) {
      const u = step.usage;
      if (step.text.trim()) {
        const lines = step.text.trim().split("\n").filter((l) => l.trim());
        for (const l of lines.slice(0, 3)) out.push(`${muted(time(step.at))}  ${accent("│")} ${oneLine(l, width - 14)}`);
        if (lines.length > 3) out.push(`          ${accent("│")} ${muted(`… ${lines.length - 3} more lines (sutra export for the full text)`)}`);
      }
      for (const t of step.tools) {
        const gl = t.status === "ok" ? c.hex(th.success)(glyph(t)) : t.status === "error" ? c.hex(th.error)(glyph(t)) : muted(glyph(t));
        const left = `${muted(t.startedAt ? time(t.startedAt) : "        ")}  ${accent("├─")} ${gl} ${c.hex(th.info)(t.name.padEnd(16))}${oneLine(toolTarget(t), width - 60)}`;
        out.push(`${left}  ${muted(`${toolResult(t)}${t.durationMs ? ` · ${secs(t.durationMs)}` : ""}`)}`);
      }
      if (u)
        out.push(
          `          ${accent("│")} ${muted(`${u.model} · ${n(u.inputTokens)} in${u.cachedInputTokens ? ` (${n(u.cachedInputTokens)} cached)` : ""} · ${n(u.outputTokens)} out · ${u.costUsd === null ? "cost unknown" : formatUsd(u.costUsd)} · ${secs(u.latencyMs)}`)}`,
        );
    }
    for (const note of turn.notes) out.push(`          ${muted(`note: ${oneLine(note, width - 20)}`)}`);
  }
  for (const comp of a.compactions) out.push("", muted(`${time(comp.createdAt)}  context compacted: ~${n(comp.tokensBefore)} → ~${n(comp.tokensAfter)} tokens`));
  const t = a.totals;
  out.push("");
  out.push(
    `${accent.bold("●")} ${a.turns.length} turn(s) · ${n(t.requests)} requests · ${n(t.toolCalls)} tool calls · ${n(t.inputTokens)} in / ${n(t.outputTokens)} out · ${t.costIncomplete ? `${formatUsd(t.costUsd)}+ (some prices unknown)` : formatUsd(t.costUsd)}`,
  );
  if (a.filesChanged.length) out.push(muted(`  files changed: ${a.filesChanged.join(", ")}`));
  return out.join("\n") + "\n";
}

function fence(text: string, lang = ""): string {
  const ticks = text.includes("```") ? "````" : "```";
  return `${ticks}${lang}\n${text}\n${ticks}`;
}

/** Markdown audit report for `sutra export --format md`. */
export function renderMarkdown(a: SessionAudit): string {
  const s = a.session;
  const t = a.totals;
  const md: string[] = [];
  md.push(`# Sutra session audit — ${s.title ?? s.id.slice(0, 8)}`, "");
  md.push(`> ${a.privacy}`, "");
  md.push("## Summary", "");
  md.push("| | |", "| --- | --- |");
  const rows: [string, string][] = [
    ["Session", `\`${s.id}\``],
    ["Workspace", `\`${s.workspace}\``],
    ["Started / last activity", `${s.createdAt} / ${s.updatedAt}`],
    ["Provider / model", `${s.provider} / ${s.model}`],
    ["Permission profile", s.profile],
    ["Final status", s.status],
    ["Turns", String(a.turns.length)],
    ["Model requests", n(t.requests)],
    ["Tool calls", n(t.toolCalls)],
    ["Input tokens", `${n(t.inputTokens)} (${n(t.cachedInputTokens)} cached)`],
    ["Output tokens", `${n(t.outputTokens)} (${n(t.reasoningTokens)} reasoning)`],
    ["Model time / tool time", `${secs(t.modelLatencyMs)} / ${secs(t.toolLatencyMs)}`],
    ["Estimated cost", t.costIncomplete ? `${formatUsd(t.costUsd)} (incomplete: some requests had no price)` : formatUsd(t.costUsd)],
    ["Files changed", a.filesChanged.length ? a.filesChanged.map((f) => `\`${f}\``).join(", ") : "none"],
  ];
  for (const [k, v] of rows) md.push(`| ${k} | ${v} |`);
  md.push("");
  if (a.commands.length) {
    md.push("## Commands run", "", "| Command | Exit | Duration | Sandbox |", "| --- | --- | --- | --- |");
    for (const cmd of a.commands) md.push(`| \`${cmd.command.replace(/\|/g, "\\|")}\` | ${cmd.exitCode ?? "—"} | ${secs(cmd.durationMs)} | ${cmd.sandbox ?? "—"} |`);
    md.push("");
  }
  md.push("## Timeline", "");
  for (const turn of a.turns) {
    md.push(`### Turn ${turn.index} — ${turn.at}`, "", "**Prompt**", "", fence(turn.prompt), "");
    turn.steps.forEach((step, i) => {
      const u = step.usage;
      md.push(`#### Step ${i + 1} — ${step.at}${u ? ` · ${u.model} · ${n(u.inputTokens)} in / ${n(u.outputTokens)} out · ${u.costUsd === null ? "cost unknown" : formatUsd(u.costUsd)} · ${secs(u.latencyMs)}` : ""}`, "");
      if (step.text.trim()) md.push(step.text.trim(), "");
      for (const tool of step.tools) {
        md.push(`- **${tool.name}** \`${toolTarget(tool).replace(/`/g, "'")}\` — ${tool.status}${tool.durationMs !== undefined ? ` · ${secs(tool.durationMs)}` : ""}`);
        md.push("", "  <details><summary>arguments and result</summary>", "");
        md.push(fence(JSON.stringify(tool.arguments, null, 2), "json").replace(/^/gm, "  "), "");
        md.push(fence(truncateMiddle(tool.output, 4000).text).replace(/^/gm, "  "), "");
        md.push("  </details>", "");
      }
    });
    for (const note of turn.notes) md.push(`_Harness note: ${note}_`, "");
  }
  if (a.compactions.length) {
    md.push("## Context compactions", "");
    for (const c of a.compactions) md.push(`- ${c.createdAt}: ~${n(c.tokensBefore)} → ~${n(c.tokensAfter)} tokens (messages up to #${c.boundarySeq} summarised)`);
    md.push("");
  }
  if (a.unpairedUsage.length) {
    md.push("## Requests without a recorded response", "");
    for (const u of a.unpairedUsage) md.push(`- ${u.createdAt}: ${u.model} · ${n(u.inputTokens)} in / ${n(u.outputTokens)} out · ${u.costUsd === null ? "cost unknown" : formatUsd(u.costUsd)}`);
    md.push("");
  }
  md.push(`<sub>Generated by Sutra at ${a.generatedAt} (${a.schema}).</sub>`, "");
  return md.join("\n");
}

export function renderJson(a: SessionAudit): string {
  return JSON.stringify(a, null, 2) + "\n";
}

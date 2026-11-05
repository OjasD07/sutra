import { Chalk } from "chalk";
import { formatUsd } from "../telemetry/cost.js";
import type { Theme } from "../tui/theme.js";
import type { BenchReport, BenchResult } from "./bench.js";

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const n = (v: number) => v.toLocaleString("en-US");

export function renderBenchRow(r: BenchResult, theme: Theme, color: boolean): string {
  const c = color ? new Chalk() : new Chalk({ level: 0 });
  const mark = r.passed ? c.hex(theme.success)("✓ pass") : c.hex(theme.error)("✗ fail");
  const cost = r.costComplete ? formatUsd(r.costUsd) : `${formatUsd(r.costUsd)}+`;
  return `  ${mark}  ${r.task.padEnd(18)} ${cost.padStart(9)}  ${secs(r.durationMs).padStart(7)}  ${String(r.requests).padStart(3)} req  ${String(r.toolCalls).padStart(3)} tools  ${c.hex(theme.muted)(`${r.agentStatus}${r.evidence ? ` · gate: ${r.evidence}` : ""} · ${r.sessionId.slice(0, 8)}`)}`;
}

export function renderBenchSummary(report: BenchReport, theme: Theme, color: boolean): string {
  const c = color ? new Chalk() : new Chalk({ level: 0 });
  const s = report.summary;
  const pct = Math.round(s.passRate * 100);
  const lines = [
    "",
    `${c.hex(theme.accent).bold("Sutra")} ${c.hex(theme.muted)("/")} bench  ${report.provider} · ${report.model} · sandbox ${report.sandbox}`,
    `  Passed          ${s.passed}/${s.total} (${pct}%)`,
    `  Total cost      ${s.costComplete ? formatUsd(s.totalCostUsd) : `${formatUsd(s.totalCostUsd)} (incomplete: some prices unknown)`}`,
    `  Cost per pass   ${s.meanCostPerPassUsd === null ? "—" : formatUsd(s.meanCostPerPassUsd)}`,
    `  Total time      ${secs(s.totalDurationMs)}`,
    `  Tokens          ${n(report.results.reduce((a, r) => a + r.inputTokens, 0))} in · ${n(report.results.reduce((a, r) => a + r.outputTokens, 0))} out`,
    "",
    c.hex(theme.muted)("  Each run is a saved session: `sutra replay <session>` shows exactly what the agent did."),
  ];
  return lines.join("\n");
}

/** Markdown table, ready to paste into an issue or the README. */
export function benchMarkdown(report: BenchReport): string {
  const rows = report.results.map(
    (r) => `| ${r.task} | ${r.passed ? "✅ pass" : "❌ fail"} | ${r.costComplete ? formatUsd(r.costUsd) : formatUsd(r.costUsd) + "+"} | ${secs(r.durationMs)} | ${r.requests} | ${r.toolCalls} | ${r.agentStatus} |`,
  );
  const s = report.summary;
  return [
    `**Sutra ${report.sutraVersion} · ${report.provider} / ${report.model} · ${report.startedAt.slice(0, 10)}** — ${s.passed}/${s.total} passed, ${formatUsd(s.totalCostUsd)} total`,
    "",
    "| Task | Result | Cost | Time | Requests | Tool calls | Agent status |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

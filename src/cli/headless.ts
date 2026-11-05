import { Chalk } from "chalk";
import type { AgentEvent, TurnResult } from "../core/events/types.js";
import type { SessionHandle } from "../core/session.js";
import { formatUsd } from "../telemetry/cost.js";
import type { Theme } from "../tui/theme.js";
import { oneLine } from "../utils/text.js";

/**
 * Non-interactive mode: the final assistant text goes to stdout, activity
 * goes to stderr, so `sutra -p "..." > answer.md` works. Anything that would
 * need approval is denied (use --profile flow, or run interactively).
 */
export async function runHeadless(session: SessionHandle, prompt: string, opts: { theme: Theme; color: boolean; json: boolean }): Promise<TurnResult> {
  const c = opts.color ? new Chalk() : new Chalk({ level: 0 });
  const err = (s: string) => process.stderr.write(s + "\n");
  const ac = new AbortController();
  const onSig = () => ac.abort();
  process.once("SIGINT", onSig);
  process.once("SIGTERM", onSig);

  let streamed = false;
  session.runtime.on((e: AgentEvent) => {
    if (opts.json) {
      if (e.type !== "text_delta" && e.type !== "tool_progress" && e.type !== "reasoning_progress") process.stdout.write(JSON.stringify(e) + "\n");
      return;
    }
    switch (e.type) {
      case "text_delta":
        process.stdout.write(e.text);
        streamed = true;
        break;
      case "assistant_message":
        if (streamed && !e.content.endsWith("\n")) process.stdout.write("\n");
        streamed = false;
        break;
      case "stream_reset":
        err(c.hex(opts.theme.accent)(`[stream interrupted: ${e.reason}; retrying]`));
        break;
      case "inference_retry":
        err(c.hex(opts.theme.accent)(`[retry ${e.attempt} in ${(e.delayMs / 1000).toFixed(1)}s: ${oneLine(e.reason, 100)}]`));
        break;
      case "tool_end": {
        const mark = e.outcome === "ok" ? " " : e.outcome === "error" ? "✗" : e.outcome === "denied" ? "⊘" : "–";
        const extra = e.outcome !== "ok" ? `  ${oneLine(e.result.error?.message ?? "", 140)}` : "";
        err(`  ${c.hex(opts.theme.error)(mark)}${c.hex(opts.theme.info)(e.name.padEnd(16))}${oneLine(e.summary, 100)}${c.hex(opts.theme.muted)(extra)}`);
        break;
      }
      case "compaction":
        err(c.hex(opts.theme.info)(`[context compacted: ~${e.tokensBefore} → ~${e.tokensAfter} tokens]`));
        break;
      case "notice":
        err(`[${e.level}] ${e.message}`);
        break;
      case "quality":
        err(c.hex(opts.theme.info)(`[quality · ${e.stage}] ${e.message}`));
        break;
      case "budget_warning":
        err(c.hex(opts.theme.accent)(`[budget: ${formatUsd(e.spentUsd)} of ${formatUsd(e.limitUsd)} used]`));
        break;
    }
  });

  try {
    const result = await session.runtime.runTurn(prompt, ac.signal);
    if (!opts.json) {
      const label = { completed: c.hex(opts.theme.success)("complete"), failed: c.hex(opts.theme.error)("failed"), cancelled: "cancelled", budget_exceeded: c.hex(opts.theme.accent)("paused (budget)") }[result.status];
      err("");
      err(`${c.bold.hex(opts.theme.accent)("Sutra")} / ${label}${result.reason ? ` — ${result.reason}` : ""}`);
      if (result.filesChanged.length) err(`  Files changed   ${result.filesChanged.join(", ")}`);
      for (const tr of result.testsRun) err(`  Tests           ${tr.passed ? "passed" : "failed"} (${tr.command})`);
      err(`  Estimated cost  ${formatUsd(result.costUsd)}   session ${session.record.id.slice(0, 8)}`);
      const v = result.verification;
      if (v) {
        const checks = new Map(v.checks.map((x) => [x.id, x]));
        err(`  Evidence        ${v.overall} (${v.mode} mode${v.treeHash ? `, version ${v.treeHash.slice(0, 7)}` : ""}${v.bounces ? `, sent back ${v.bounces}x` : ""})`);
        for (const cr of v.criteria) {
          const mark = cr.status === "passed" ? "✓" : cr.status === "failed" ? "✗" : "?";
          const ev = cr.evidence.map((id) => checks.get(id)?.summary).filter(Boolean).join("; ");
          err(`    ${mark} ${cr.text} — ${ev || cr.note || cr.status}`);
        }
        if (v.review) err(`  Review          ${v.review.verdict}${v.review.inferred ? `: ${oneLine(v.review.inferred, 120)}` : ""}`);
        if (v.counterexamples.length) err(`  Probes          ${v.counterexamples.length} provisional, ${v.counterexamples.filter((x) => x.failing).length} still failing`);
        if (v.candidates.length) err(`  Patches         ${v.candidates.map((x) => `${x.label}${x.selected ? " (selected)" : ""}: ${x.reason}`).join(" · ")}`);
      }
    }
    return result;
  } finally {
    process.off("SIGINT", onSig);
    process.off("SIGTERM", onSig);
  }
}

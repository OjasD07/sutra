import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Chalk } from "chalk";
import { defaultTasksDir, loadTasks, runBench } from "../bench/bench.js";
import { benchMarkdown, renderBenchRow, renderBenchSummary } from "../bench/render.js";
import { paths } from "../config/paths.js";
import type { SutraConfig } from "../config/schema.js";
import type { SessionStore } from "../memory/store.js";
import type { ModelProvider } from "../providers/types.js";
import type { Theme } from "../tui/theme.js";
import type { CliArgs } from "./args.js";

export async function runBenchCommand(o: { args: CliArgs; config: SutraConfig; provider: ModelProvider; store: SessionStore; theme: Theme; color: boolean }): Promise<number> {
  const { args, config, provider, store, theme, color } = o;
  const c = color ? new Chalk() : new Chalk({ level: 0 });
  const err = (s: string) => process.stderr.write(s + "\n");
  let tasks;
  try {
    tasks = loadTasks(args.tasks ? resolve(args.tasks) : defaultTasksDir(), args.only);
  } catch (e) {
    err(`sutra: ${(e as Error).message}`);
    return 1;
  }
  if (!tasks.length) {
    err("sutra: no tasks found.");
    return 1;
  }
  const maxCost = args.maxCost ?? 0.5;
  err(`${c.hex(theme.accent).bold("Sutra")} ${c.hex(theme.muted)("/")} bench  ${tasks.length} task(s) · ${provider.displayName} · ${config.model} · up to ${maxCost.toFixed(2)} USD per task`);
  err(c.hex(theme.muted)("  Each task runs in a fresh copy with the flow profile; anything needing approval is denied. Results are judged by the task's own test command."));
  err("");

  const ac = new AbortController();
  const onSig = () => ac.abort();
  process.once("SIGINT", onSig);
  try {
    const report = await runBench({
      tasks,
      config,
      provider,
      store,
      maxCostPerTaskUsd: maxCost,
      signal: ac.signal,
      onTaskStart: (t, i) => err(c.hex(theme.muted)(`  [${i + 1}/${tasks.length}] ${t.id} — ${t.title}`)),
      onTaskEnd: (r) => err(renderBenchRow(r, theme, color)),
    });
    err(renderBenchSummary(report, theme, color));
    const file = args.out ? resolve(args.out) : join(paths.bench(), `${report.startedAt.replace(/[:.]/g, "-")}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
    writeFileSync(file.replace(/\.json$/, "") + ".md", benchMarkdown(report) + "\n");
    err(c.hex(theme.muted)(`  Results: ${file} (and .md)`));
    if (args.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return report.summary.passed === report.summary.total ? 0 : 1;
  } finally {
    process.off("SIGINT", onSig);
  }
}

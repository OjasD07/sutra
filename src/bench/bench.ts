import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { SutraConfig } from "../config/schema.js";
import { openSession } from "../core/session.js";
import type { AgentEvent } from "../core/events/types.js";
import type { SessionStore } from "../memory/store.js";
import type { ModelProvider } from "../providers/types.js";
import type { SandboxStatus } from "../sandbox/sandbox.js";
import { runProcess } from "../utils/process.js";
import { version } from "../version.js";

const TaskSchema = z.object({
  title: z.string(),
  kind: z.enum(["bugfix", "feature", "refactor"]).default("bugfix"),
  prompt: z.string().min(1),
  /** Run independently after the agent finishes; exit 0 means the task passed. */
  verify: z.string().min(1),
  /** Paths restored from the pristine copy before verifying, so editing tests can't pass a task. */
  protected: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().default(600_000),
});

export interface BenchTask extends z.infer<typeof TaskSchema> {
  id: string;
  dir: string;
}

export interface BenchResult {
  task: string;
  title: string;
  passed: boolean;
  /** How the agent's turn ended (completed / failed / cancelled / budget_exceeded / timeout / error). */
  agentStatus: string;
  reason?: string;
  costUsd: number;
  costComplete: boolean;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  requests: number;
  toolCalls: number;
  durationMs: number;
  filesChanged: string[];
  sessionId: string;
  verifyExitCode: number | null;
  verifyTail: string;
}

export interface BenchReport {
  schema: "sutra.bench/v1";
  sutraVersion: string;
  startedAt: string;
  finishedAt: string;
  provider: string;
  model: string;
  profile: string;
  sandbox: string;
  maxCostPerTaskUsd: number;
  results: BenchResult[];
  summary: { passed: number; total: number; passRate: number; totalCostUsd: number; costComplete: boolean; totalDurationMs: number; meanCostPerPassUsd: number | null };
}

/** The bundled tasks (benchmarks/tasks next to package.json). */
export function defaultTasksDir(): string {
  for (const rel of ["../../benchmarks/tasks", "../benchmarks/tasks"]) {
    const p = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(p)) return p;
  }
  throw new Error("Bundled benchmark tasks not found; pass --tasks <dir>.");
}

export function loadTasks(dir: string, only?: string[]): BenchTask[] {
  const tasks: BenchTask[] = [];
  for (const id of readdirSync(dir).sort()) {
    const taskDir = join(dir, id);
    const file = join(taskDir, "task.json");
    if (!existsSync(file)) continue;
    if (only?.length && !only.includes(id)) continue;
    const parsed = TaskSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (!parsed.success) throw new Error(`Invalid ${file}: ${parsed.error.message}`);
    if (!existsSync(join(taskDir, "repo"))) throw new Error(`Task ${id} has no repo/ directory`);
    tasks.push({ ...parsed.data, id, dir: taskDir });
  }
  if (only?.length) {
    const missing = only.filter((o) => !tasks.some((t) => t.id === o));
    if (missing.length) throw new Error(`Unknown task(s): ${missing.join(", ")}`);
  }
  return tasks;
}

export interface BenchOptions {
  tasks: BenchTask[];
  config: SutraConfig;
  provider: ModelProvider;
  store: SessionStore;
  maxCostPerTaskUsd: number;
  /** Stop the whole run when the summed cost reaches this. */
  maxTotalCostUsd?: number;
  sandbox?: SandboxStatus;
  signal?: AbortSignal;
  onTaskStart?: (task: BenchTask, index: number) => void;
  onTaskEnd?: (result: BenchResult, index: number) => void;
  onEvent?: (task: BenchTask, e: AgentEvent) => void;
  /** Keep task workspaces for inspection. */
  keepWorkspaces?: boolean;
}

async function verify(task: BenchTask, workspace: string, sandbox: SandboxStatus | undefined, signal?: AbortSignal) {
  // Restore protected files (usually the tests) from the pristine task copy.
  for (const rel of task.protected) {
    const src = join(task.dir, "repo", rel);
    const dst = join(workspace, rel);
    rmSync(dst, { recursive: true, force: true });
    if (existsSync(src)) cpSync(src, dst, { recursive: true });
  }
  // The verification runs code the agent wrote, so it gets the same sandbox as the agent's commands.
  const argv = sandbox?.runner ? sandbox.runner.wrap(task.verify, workspace, false) : undefined;
  return runProcess({ command: task.verify, ...(argv ? { argv } : {}), cwd: workspace, timeoutMs: 300_000, ...(signal ? { signal } : {}), env: { ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" } });
}

/**
 * Run each task in a fresh copy of its repository with the real agent
 * (flow profile, no approvals: anything that would need one is denied), then
 * judge it with the task's own verification command, independent of what the
 * agent claimed. Every run is a normal saved session, so `sutra replay <id>`
 * shows exactly what happened.
 */
export async function runBench(o: BenchOptions): Promise<BenchReport> {
  const startedAt = new Date().toISOString();
  let sandboxName = o.sandbox?.runner ? o.sandbox.runner.backend : o.sandbox ? "none" : "auto";
  const results: BenchResult[] = [];
  let spent = 0;
  for (const [index, task] of o.tasks.entries()) {
    if (o.signal?.aborted) break;
    if (o.maxTotalCostUsd !== undefined && spent >= o.maxTotalCostUsd) break;
    o.onTaskStart?.(task, index);
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), `sutra-bench-${task.id}-`)));
    cpSync(join(task.dir, "repo"), workspace, { recursive: true });

    const config: SutraConfig = structuredClone(o.config);
    config.permissions.profile = "flow";
    config.budget.maxSessionCostUsd = o.maxCostPerTaskUsd;
    config.tools.testCommand = task.verify;

    const session = openSession({
      config,
      provider: o.provider,
      store: o.store,
      workspaceRoot: workspace,
      approve: async () => "deny",
      ...(o.sandbox ? { sandbox: o.sandbox } : {}),
    });
    if (sandboxName === "auto") sandboxName = session.sandbox.runner?.backend ?? "none";
    const off = o.onEvent ? session.runtime.on((e) => o.onEvent!(task, e)) : undefined;

    const started = Date.now();
    const timeout = AbortSignal.timeout(task.timeoutMs);
    const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
    let agentStatus = "error";
    let reason: string | undefined;
    let filesChanged: string[] = [];
    try {
      const r = await session.runtime.runTurn(task.prompt, signal);
      agentStatus = timeout.aborted ? "timeout" : r.status;
      reason = r.reason;
      filesChanged = r.filesChanged;
    } catch (err) {
      reason = (err as Error).message;
    } finally {
      off?.();
    }
    const durationMs = Date.now() - started;
    const v = await verify(task, workspace, o.sandbox ?? session.sandbox, o.signal);
    const t = session.usage.totals;
    const result: BenchResult = {
      task: task.id,
      title: task.title,
      passed: v.exitCode === 0,
      agentStatus,
      ...(reason ? { reason } : {}),
      costUsd: t.costUsd,
      costComplete: !t.costIncomplete,
      inputTokens: t.inputTokens,
      cachedInputTokens: t.cachedInputTokens,
      outputTokens: t.outputTokens,
      requests: t.requests,
      toolCalls: t.toolCalls,
      durationMs,
      filesChanged,
      sessionId: session.record.id,
      verifyExitCode: v.exitCode,
      verifyTail: (v.stdout + v.stderr).trim().split("\n").slice(-6).join("\n"),
    };
    spent += t.costUsd;
    results.push(result);
    o.onTaskEnd?.(result, index);
    if (!o.keepWorkspaces) rmSync(workspace, { recursive: true, force: true });
  }

  const passed = results.filter((r) => r.passed).length;
  const totalCostUsd = results.reduce((a, r) => a + r.costUsd, 0);
  return {
    schema: "sutra.bench/v1",
    sutraVersion: version(),
    startedAt,
    finishedAt: new Date().toISOString(),
    provider: o.provider.id,
    model: o.config.model!,
    profile: "flow",
    sandbox: sandboxName,
    maxCostPerTaskUsd: o.maxCostPerTaskUsd,
    results,
    summary: {
      passed,
      total: results.length,
      passRate: results.length ? passed / results.length : 0,
      totalCostUsd,
      costComplete: results.every((r) => r.costComplete),
      totalDurationMs: results.reduce((a, r) => a + r.durationMs, 0),
      meanCostPerPassUsd: passed ? totalCostUsd / passed : null,
    },
  };
}

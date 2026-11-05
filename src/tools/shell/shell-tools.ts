import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { scrubEnv } from "../../permissions/sensitive.js";
import { runProcess, type ProcessResult } from "../../utils/process.js";
import { truncateMiddle } from "../../utils/text.js";
import { parseFailingTests, parseTestCounts } from "./test-counts.js";
import { fail, ok, type Tool, type ToolContext, type ToolResult } from "../types.js";

const MAX_TIMEOUT_MS = 30 * 60_000;

export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_\-./:=@%+,]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function formatProcess(r: ProcessResult, display: string, ctx: ToolContext): string {
  const budget = ctx.settings.maxOutputChars;
  const note = r.logPath ? `full log: ${r.logPath}` : "";
  const stdout = truncateMiddle(r.stdout, Math.floor(budget * 0.6), note).text;
  const stderr = truncateMiddle(r.stderr, Math.floor(budget * 0.4), note).text;
  const status = r.timedOut
    ? `timed out after ${r.durationMs} ms (process tree killed)`
    : r.cancelled
      ? "cancelled by user (process tree killed)"
      : r.exitCode === null
        ? `terminated by signal ${r.signal}`
        : `exit code ${r.exitCode}`;
  const parts = [`$ ${r.command}`, `cwd: ${display}`, `${status}; duration ${(r.durationMs / 1000).toFixed(2)}s`];
  if (ctx.sandbox) parts.push(`sandbox: ${ctx.sandbox.describe(!!ctx.allowNetwork)} (writes outside the workspace and non-approved network access fail with "Operation not permitted")`);
  if (stdout.trim()) parts.push("--- stdout ---", stdout.trimEnd());
  if (stderr.trim()) parts.push("--- stderr ---", stderr.trimEnd());
  if (!stdout.trim() && !stderr.trim()) parts.push("(no output)");
  return parts.join("\n");
}

async function run(command: string, cwdInput: string | undefined, timeoutMs: number | undefined, ctx: ToolContext): Promise<ToolResult> {
  const cwd = ctx.workspace.resolve(cwdInput ?? ".");
  if (!existsSync(cwd.absolute)) return fail("not_found", `Working directory does not exist: ${cwd.display}`);
  const timeout = Math.min(timeoutMs ?? ctx.settings.commandTimeoutMs, MAX_TIMEOUT_MS);
  const logPath = ctx.settings.retainFullLogs ? join(ctx.settings.logDir, `${ctx.toolCallId.replace(/[^A-Za-z0-9_-]/g, "_")}.log`) : undefined;
  const env = { ...(ctx.settings.scrubEnv ? scrubEnv(process.env) : process.env), SUTRA: "1", CI: process.env.CI ?? "1", FORCE_COLOR: "0", NO_COLOR: "1" };
  if (!ctx.sandbox && ctx.sandboxRequired)
    return fail("execution_failed", "sandbox.mode is \"required\" but no OS sandbox is available on this machine; the command was not run.");
  const sandboxNote = ctx.sandbox ? ctx.sandbox.describe(!!ctx.allowNetwork) : "none (approval gate only)";
  const r = await runProcess({
    command,
    ...(ctx.sandbox ? { argv: ctx.sandbox.wrap(command, cwd.absolute, !!ctx.allowNetwork) } : {}),
    cwd: cwd.absolute,
    env,
    timeoutMs: timeout,
    signal: ctx.signal,
    ...(logPath ? { logPath } : {}),
    onData: (_s, chunk) => ctx.onProgress?.(chunk),
  });
  const data = {
    sandbox: sandboxNote,
    command: r.command,
    cwd: cwd.display,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    durationMs: r.durationMs,
    exitCode: r.exitCode,
    signal: r.signal,
    timedOut: r.timedOut,
    cancelled: r.cancelled,
    timeoutMs: timeout,
    stdoutChars: r.stdout.length,
    stderrChars: r.stderr.length,
    ...(r.logPath ? { logPath: r.logPath } : {}),
  };
  const text = formatProcess(r, cwd.display, ctx);
  if (r.cancelled) return { ...fail("cancelled", "Command cancelled by user", { data }), output: text };
  if (r.timedOut) return { ...fail("timeout", `Command timed out after ${timeout} ms`, { data, retryable: false }), output: text };
  // A non-zero exit is a normal observation (e.g. failing tests), not a tool
  // failure: the model needs to see it and react.
  return ok(text, data);
}

export const executeCommandTool: Tool<{ command: string; cwd?: string; timeout_ms?: number }> = {
  name: "execute_command",
  description:
    "Run a shell command (/bin/sh -c) in the workspace. Output is bounded; non-zero exit codes are reported, not hidden. Commands are non-interactive (stdin is closed). Avoid long-running servers.",
  version: "1.0.0",
  category: "execute",
  readOnly: false,
  schema: z.object({
    command: z.string().min(1),
    cwd: z.string().optional().describe("Working directory relative to the workspace (default root)"),
    timeout_ms: z.number().int().min(1000).max(MAX_TIMEOUT_MS).optional(),
  }),
  describe: (a, ctx) => ({ tool: "execute_command", category: "execute", command: a.command, paths: [ctx.workspace.resolve(a.cwd ?? ".")], summary: a.command }),
  preview: async (a, ctx) => ({
    summary: `$ ${a.command}`,
    details: [`cwd: ${ctx.workspace.resolve(a.cwd ?? ".").display}`, `sandbox: ${ctx.sandbox ? ctx.sandbox.describe(!!ctx.allowNetwork) : "none — runs with your full user permissions"}`],
  }),
  execute: (a, ctx) => run(a.command, a.cwd, a.timeout_ms, ctx),
};

/** Best-effort detection of the project's test command. */
export function detectTestCommand(root: string): string | null {
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
      const t = pkg.scripts?.test;
      if (t && !/no test specified/.test(t)) {
        if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm test";
        if (existsSync(join(root, "yarn.lock"))) return "yarn test";
        if (existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock"))) return "bun test";
        return "npm test";
      }
    } catch {
      /* invalid package.json */
    }
  }
  if (existsSync(join(root, "Cargo.toml"))) return "cargo test";
  if (existsSync(join(root, "go.mod"))) return "go test ./...";
  if (["pytest.ini", "conftest.py", "tox.ini"].some((f) => existsSync(join(root, f)))) return "python3 -m pytest";
  const pyproject = join(root, "pyproject.toml");
  if (existsSync(pyproject) && /pytest/.test(readFileSync(pyproject, "utf8"))) return "python3 -m pytest";
  const makefile = join(root, "Makefile");
  if (existsSync(makefile) && /^test:/m.test(readFileSync(makefile, "utf8"))) return "make test";
  return null;
}

export function buildTestCommand(base: string, filter?: string): string {
  if (!filter) return base;
  const quoted = filter.split(/\s+/).filter(Boolean).map(shellQuote).join(" ");
  return /^(npm|pnpm|yarn|bun) (run )?test/.test(base) ? `${base} -- ${quoted}` : `${base} ${quoted}`;
}

function resolveTestCommand(a: { filter?: string }, ctx: ToolContext): string | null {
  const base = ctx.settings.testCommand ?? detectTestCommand(ctx.workspace.root);
  return base ? buildTestCommand(base, a.filter) : null;
}

export const runTestsTool: Tool<{ filter?: string; timeout_ms?: number }> = {
  name: "run_tests",
  description:
    "Run the project's test suite using the configured or detected test command (package.json test script, cargo, go, pytest, make). Pass `filter` to target specific test files or names.",
  version: "1.0.0",
  category: "execute",
  readOnly: false,
  schema: z.object({
    filter: z.string().optional().describe("Test file(s) or name filter appended to the test command"),
    timeout_ms: z.number().int().min(1000).max(MAX_TIMEOUT_MS).optional(),
  }),
  describe: (a, ctx) => {
    const cmd = resolveTestCommand(a, ctx) ?? "(no test command detected)";
    return { tool: "run_tests", category: "execute", command: cmd, paths: [ctx.workspace.resolve(".")], summary: cmd };
  },
  preview: async (a, ctx) => ({
    summary: `$ ${resolveTestCommand(a, ctx) ?? "(none)"}`,
    details: [`sandbox: ${ctx.sandbox ? ctx.sandbox.describe(!!ctx.allowNetwork) : "none — runs with your full user permissions"}`],
  }),
  async execute(a, ctx) {
    const cmd = resolveTestCommand(a, ctx);
    if (!cmd)
      return fail("not_found", "No test command configured or detected. Set tools.testCommand in ~/.sutra/config.json or .sutra/config.json, or use execute_command.");
    const r = await run(cmd, undefined, a.timeout_ms ?? Math.max(ctx.settings.commandTimeoutMs, 300_000), ctx);
    if (r.data) {
      r.data.passed = r.data.exitCode === 0;
      const counts = parseTestCounts(r.output);
      if (counts) r.data.counts = counts;
      const failing = parseFailingTests(r.output);
      if (failing.length) r.data.failing = failing;
    }
    return r;
  },
};

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parseTestReport, type FailureBlock } from "../../context/test-report.js";
import { enclosingDefinition, isTestPath } from "../index/inspect-tools.js";
import { ok, type Tool, type ToolContext } from "../types.js";
import { runTestsTool } from "./shell-tools.js";

const MAX_FAILURES = 3;
const CONTEXT = 5;

function window(ctx: ToolContext, file: string, line: number, radius: number): string | null {
  let lines: string[];
  try {
    lines = readFileSync(join(ctx.workspace.root, file), "utf8").split("\n");
  } catch {
    return null;
  }
  if (line < 1 || line > lines.length) return null;
  const from = Math.max(0, line - 1 - radius);
  const to = Math.min(lines.length - 1, line - 1 + radius);
  const width = String(to + 1).length;
  return lines
    .slice(from, to + 1)
    .map((l, i) => `${from + i + 1 === line ? ">" : " "}${String(from + i + 1).padStart(width)}\t${l}`)
    .join("\n");
}

function where(ctx: ToolContext, file: string, line: number): string {
  const s = ctx.repoIndex ? enclosingDefinition(ctx.repoIndex.index, ctx.workspace.root, file, line) : undefined;
  return s ? ` in ${s.parent ? `${s.parent}.` : ""}${s.name}` : "";
}

/** Source definitions named on the failing test's assertion line, so the model sees what it exercises. */
function exercised(ctx: ToolContext, assertion: string): string[] {
  const idx = ctx.repoIndex?.index;
  if (!idx) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of assertion.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1]!;
    if (seen.has(name) || /^(assert|expect|equal|strictEqual|deepEqual|deepStrictEqual|ok|it|test|describe|toBe|toEqual|require|new)$/.test(name)) continue;
    seen.add(name);
    for (const d of idx.findDefinitions(name).filter((d) => !isTestPath(d.file.path)).slice(0, 2))
      out.push(`${d.file.path}:${d.symbol.line}  ${d.symbol.signature}`);
  }
  return out.slice(0, 4);
}

function describeFailure(ctx: ToolContext, f: FailureBlock): string[] {
  // Runtime-internal frames are noise here; the exact block is one get_output away.
  const text = f.text
    .split("\n")
    .filter((l) => !/^\s*at (?:async )?(?:.*\()?node:/.test(l))
    .slice(0, 40)
    .join("\n");
  const out = [`### ${f.name}`, text];
  const frames = f.frames.map((fr) => {
    const [file, line] = fr.split(":");
    return { file: file!, line: Number(line) };
  });
  const source = frames.find((fr) => !isTestPath(fr.file));
  const test = frames.find((fr) => isTestPath(fr.file));
  if (source) {
    const w = window(ctx, source.file, source.line, CONTEXT);
    if (w) out.push(`Top source frame: ${source.file}:${source.line}${where(ctx, source.file, source.line)}`, w);
  }
  if (test) {
    const w = window(ctx, test.file, test.line, source ? 2 : CONTEXT);
    if (w) {
      out.push(`Assertion: ${test.file}:${test.line}${where(ctx, test.file, test.line)}`, w);
      if (!source) {
        const line = w.split("\n").find((l) => l.startsWith(">")) ?? "";
        const defs = exercised(ctx, line);
        if (defs.length) out.push("Code called on that line:", ...defs.map((d) => `  ${d}`));
      }
    }
  }
  return out;
}

export const diagnoseFailureTool: Tool<{ filter?: string; timeout_ms?: number; force?: boolean }> = {
  name: "diagnose_failure",
  description:
    "Run the tests (optionally targeted with `filter`), and for each failure return the exact assertion, the top stack frame in your source with surrounding lines and the enclosing function, and the assertion line in the test. One call instead of run_tests + several read_file calls. If the output can't be parsed, the raw runner output is returned.",
  version: "1.0.0",
  category: "execute",
  readOnly: false,
  schema: z.object({
    filter: z.string().optional().describe("Test file(s) or name filter appended to the test command"),
    timeout_ms: z.number().int().min(1000).max(30 * 60_000).optional(),
    force: z.boolean().optional().describe("Run even if nothing changed since an identical run"),
  }),
  describe: (a, ctx) => ({ ...runTestsTool.describe(a, ctx), tool: "diagnose_failure" }),
  preview: (a, ctx) => runTestsTool.preview!(a, ctx),
  async execute(a, ctx) {
    const r = await runTestsTool.execute(a, ctx);
    if (!r.ok || !r.data) return r;
    ctx.repoIndex?.refresh();
    const report = parseTestReport(r.output, ctx.workspace.root);
    const head = r.output.split("\n").filter((l) => !l.startsWith("sandbox:")).slice(0, 3);
    const c = report.counts;
    const summary = `${head.join("\n")}\n${c ? `${c.failed} failed, ${c.passed} passed, ${c.total} total` : "no test counts found"}`;
    if (r.data.exitCode === 0) return ok(`${summary}\nAll tests pass; nothing to diagnose.`, r.data);
    if (!report.failures.length) return { ...r, output: `[Sutra: couldn't isolate individual failures (a crash, a compile error, or an unrecognised runner); raw output follows.]\n${r.output}` };
    const out = [summary, ""];
    for (const f of report.failures.slice(0, MAX_FAILURES)) out.push(...describeFailure(ctx, f), "");
    if (report.failures.length > MAX_FAILURES) out.push(`${report.failures.length - MAX_FAILURES} more failing: ${report.failures.slice(MAX_FAILURES).map((f) => JSON.stringify(f.name)).join(", ")}`);
    if (!report.complete) out.push("[some failures couldn't be isolated; see the raw output]");
    out.push(`Raw runner output: get_output {"call_id":"${ctx.toolCallId}"}`);
    return { ...r, output: out.join("\n"), data: { ...r.data, rawOutput: r.output } };
  },
};

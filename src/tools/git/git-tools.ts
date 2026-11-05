import { z } from "zod";
import { runProcess } from "../../utils/process.js";
import { truncateMiddle } from "../../utils/text.js";
import { fail, ok, type Tool, type ToolContext } from "../types.js";

/** Git runs via argv (no shell), with pager and external helpers disabled. */
async function git(args: string[], ctx: ToolContext) {
  const argv = ["git", "-c", "core.pager=cat", "-c", "color.ui=false", "--no-optional-locks", ...args];
  return runProcess({
    command: argv.join(" "),
    argv,
    cwd: ctx.workspace.root,
    timeoutMs: 30_000,
    signal: ctx.signal,
    env: { ...process.env, GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0", GIT_EXTERNAL_DIFF: "", LC_ALL: "C" },
  });
}

export const gitStatusTool: Tool<Record<string, never>> = {
  name: "git_status",
  description: "Show the git working tree status (branch, staged, unstaged and untracked files). Read-only.",
  version: "1.0.0",
  category: "read",
  readOnly: true,
  schema: z.object({}).strict(),
  describe: (_a, ctx) => ({ tool: "git_status", category: "read", paths: [ctx.workspace.resolve(".")], summary: "git status" }),
  async execute(_a, ctx) {
    const r = await git(["status", "--short", "--branch"], ctx);
    if (r.exitCode !== 0) return fail("execution_failed", r.stderr.trim() || "git status failed (is this a git repository?)");
    return ok(r.stdout.trim() || "Clean working tree.", { exitCode: 0 });
  },
};

export const gitDiffTool: Tool<{ staged?: boolean; path?: string; ref?: string }> = {
  name: "git_diff",
  description: "Show git diff of the working tree (or staged changes, or against a ref). Read-only.",
  version: "1.0.0",
  category: "read",
  readOnly: true,
  schema: z.object({
    staged: z.boolean().optional(),
    path: z.string().optional().describe("Limit to a file or directory"),
    ref: z
      .string()
      .regex(/^[A-Za-z0-9_./~^@{}-]+$/, "invalid ref")
      .refine((r) => !r.startsWith("-"), "ref may not start with '-'")
      .optional()
      .describe("Compare against this commit/branch"),
  }),
  describe: (a, ctx) => ({ tool: "git_diff", category: "read", paths: [ctx.workspace.resolve(a.path ?? ".")], summary: "git diff" }),
  async execute(a, ctx) {
    const args = ["diff", "--no-ext-diff", "--stat", "--patch"];
    if (a.staged) args.push("--cached");
    if (a.ref) args.push(a.ref);
    if (a.path) args.push("--", ctx.workspace.resolveInside(a.path).display);
    const r = await git(args, ctx);
    if (r.exitCode !== 0) return fail("execution_failed", r.stderr.trim() || "git diff failed");
    const out = truncateMiddle(r.stdout, ctx.settings.maxOutputChars).text;
    return ok(out.trim() || "No differences.", { exitCode: 0 });
  },
};

import { readFileSync, statSync, utimesSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PlanStore } from "../../src/core/planning/plan.js";
import { Workspace } from "../../src/permissions/paths.js";
import { SecretRedactor } from "../../src/permissions/sensitive.js";
import { FileStateTracker } from "../../src/tools/file-state.js";
import { createDefaultRegistry, toJsonSchema } from "../../src/tools/registry.js";
import { buildTestCommand, detectTestCommand } from "../../src/tools/shell/shell-tools.js";
import type { ToolContext } from "../../src/tools/types.js";
import { runProcess } from "../../src/utils/process.js";
import { tempDir, writeFiles } from "../helpers/harness.js";

const registry = createDefaultRegistry();
const roots: string[] = [];

function ctx(root: string, extra: Partial<ToolContext["settings"]> = {}): ToolContext {
  return {
    workspace: new Workspace(root),
    fileState: new FileStateTracker(),
    plan: new PlanStore(),
    redactor: new SecretRedactor(),
    signal: new AbortController().signal,
    sessionId: "s",
    toolCallId: "call1",
    settings: { commandTimeoutMs: 10_000, maxOutputChars: 30_000, retainFullLogs: false, scrubEnv: true, logDir: join(root, ".logs"), ...extra },
  };
}

async function call(name: string, args: unknown, c: ToolContext) {
  const tool = registry.get(name)!;
  const parsed = tool.schema.parse(args);
  return tool.execute(parsed, c);
}

function workspace(files: Record<string, string>): string {
  const r = tempDir();
  roots.push(r);
  writeFiles(r, files);
  return r;
}
afterAll(() => {});

describe("tool registry", () => {
  it("exposes the v1 tool set with valid JSON schemas", () => {
    expect(registry.list().map((t) => t.name)).toEqual([
      "read_file", "list_directory", "glob_files", "search_files", "grep_search", "write_file", "edit_file", "apply_patch", "execute_command", "run_tests", "diagnose_failure", "git_status", "git_diff", "repo_map", "find_symbol", "code_search", "inspect_symbol", "update_plan", "hypotheses", "get_output",
    ]);
    for (const t of registry.list()) {
      expect(t.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(t.description.length).toBeGreaterThan(20);
      const js = toJsonSchema(t.schema);
      expect(js.type).toBe("object");
      expect(js).not.toHaveProperty("$schema");
    }
    const edit = registry.definitions().find((d) => d.name === "edit_file")!;
    expect(edit.parameters).toMatchObject({ required: ["path", "old_string", "new_string"] });
  });

  it("validates arguments with zod", () => {
    const read = registry.get("read_file")!;
    expect(read.schema.safeParse({ path: "a" }).success).toBe(true);
    expect(read.schema.safeParse({}).success).toBe(false);
    expect(read.schema.safeParse({ path: "a", offset: 0 }).success).toBe(false);
    expect(registry.get("update_plan")!.schema.safeParse({ steps: [{ title: "x", status: "maybe" }] }).success).toBe(false);
    expect(registry.get("git_diff")!.schema.safeParse({ ref: "--output=/tmp/x" }).success).toBe(false);
  });

  it("rejects duplicate and invalid tool names", () => {
    expect(() => registry.register(registry.get("read_file")!)).toThrow(/Duplicate/);
  });
});

describe("filesystem tools", () => {
  it("reads with line numbers and ranges, and refuses binaries", async () => {
    const r = workspace({ "a.txt": "one\ntwo\nthree\n" });
    writeFileSync(join(r, "bin.dat"), Buffer.from([0, 1, 2, 3, 0, 5]));
    const c = ctx(r);
    expect((await call("read_file", { path: "a.txt" }, c)).output).toBe("1\tone\n2\ttwo\n3\tthree");
    const part = await call("read_file", { path: "a.txt", offset: 2, limit: 1 }, c);
    expect(part.output).toContain("2\ttwo");
    expect(part.output).toContain("showing lines 2-2 of 3");
    expect((await call("read_file", { path: "bin.dat" }, c)).ok).toBe(false);
    expect((await call("read_file", { path: "missing" }, c)).error?.code).toBe("not_found");
  });

  it("lists, globs (respecting .gitignore) and fuzzy-finds files", async () => {
    const r = workspace({ ".gitignore": "secret/\n*.log\n", "src/auth/session.ts": "", "src/index.ts": "", "secret/x.ts": "", "debug.log": "", "node_modules/p/i.js": "" });
    const c = ctx(r);
    const list = await call("list_directory", { depth: 2 }, c);
    expect(list.output).toContain("src/");
    expect(list.output).toContain("node_modules/  (ignored)");
    const g = await call("glob_files", { pattern: "**/*.ts" }, c);
    expect(g.output.split("\n")).toEqual(["src/auth/session.ts", "src/index.ts"]);
    const s = await call("search_files", { query: "session" }, c);
    expect(s.output.split("\n")[0]).toBe("src/auth/session.ts");
  });

  it("greps contents (fallback engine) with context and literal mode", async () => {
    const r = workspace({ "src/a.ts": "const refreshToken = 1;\nfoo()\n", "src/b.ts": "nothing\n", "node_modules/x.js": "refreshToken" });
    const prev = process.env.SUTRA_DISABLE_RG;
    process.env.SUTRA_DISABLE_RG = "1";
    const c = ctx(r);
    const res = await call("grep_search", { pattern: "refresh\\w+" }, c);
    expect(res.output).toBe("src/a.ts:1:const refreshToken = 1;");
    const lit = await call("grep_search", { pattern: "foo()", fixedStrings: true, contextLines: 1 }, c);
    expect(lit.output).toContain("src/a.ts:2:foo()");
    expect(lit.output).toContain("src/a.ts-1-const");
    expect((await call("grep_search", { pattern: "(" }, c)).error?.code).toBe("invalid_arguments");
    if (prev === undefined) delete process.env.SUTRA_DISABLE_RG;
    else process.env.SUTRA_DISABLE_RG = prev;
  });

  it("edits exactly, refusing ambiguous or missing matches", async () => {
    const r = workspace({ "a.ts": "let x = 1;\nlet y = 1;\n" });
    const c = ctx(r);
    await call("read_file", { path: "a.ts" }, c);
    expect((await call("edit_file", { path: "a.ts", old_string: "= 1", new_string: "= 2" }, c)).error?.code).toBe("conflict");
    expect((await call("edit_file", { path: "a.ts", old_string: "nope", new_string: "x" }, c)).error?.code).toBe("conflict");
    const ok = await call("edit_file", { path: "a.ts", old_string: "let x = 1;", new_string: "let x = 2;" }, c);
    expect(ok.ok).toBe(true);
    expect(ok.data).toMatchObject({ added: 1, removed: 1, files: ["a.ts"] });
    expect(ok.data!.diff).toContain("+let x = 2;");
    expect(readFileSync(join(r, "a.ts"), "utf8")).toBe("let x = 2;\nlet y = 1;\n");
    const all = await call("edit_file", { path: "a.ts", old_string: "let", new_string: "const", replace_all: true }, c);
    expect(all.ok).toBe(true);
    expect(readFileSync(join(r, "a.ts"), "utf8")).toBe("const x = 2;\nconst y = 1;\n");
  });

  it("never silently overwrites unread or externally modified files", async () => {
    const r = workspace({ "a.ts": "original\n" });
    const c = ctx(r);
    const unread = await call("write_file", { path: "a.ts", content: "new" }, c);
    expect(unread.error?.code).toBe("stale_file");
    await call("read_file", { path: "a.ts" }, c);
    writeFileSync(join(r, "a.ts"), "changed by user\n");
    utimesSync(join(r, "a.ts"), new Date(), new Date(Date.now() + 5000));
    const stale = await call("edit_file", { path: "a.ts", old_string: "changed", new_string: "x" }, c);
    expect(stale.error?.code).toBe("stale_file");
    expect(readFileSync(join(r, "a.ts"), "utf8")).toBe("changed by user\n");
    // New files need no prior read.
    expect((await call("write_file", { path: "dir/new.ts", content: "hi\n" }, c)).ok).toBe(true);
    expect(readFileSync(join(r, "dir/new.ts"), "utf8")).toBe("hi\n");
  });

  it("writes atomically and preserves file mode", async () => {
    const r = workspace({ "run.sh": "#!/bin/sh\necho a\n" });
    chmodSync(join(r, "run.sh"), 0o755);
    const c = ctx(r);
    await call("read_file", { path: "run.sh" }, c);
    expect((await call("write_file", { path: "run.sh", content: "#!/bin/sh\necho b\n" }, c)).ok).toBe(true);
    expect(statSync(join(r, "run.sh")).mode & 0o777).toBe(0o755);
    const leftovers = (await call("list_directory", {}, c)).output;
    expect(leftovers).not.toMatch(/sutra-.*\.tmp/);
  });

  it("applies multi-file unified diffs all-or-nothing", async () => {
    const r = workspace({ "a.ts": "a1\na2\na3\n", "b.ts": "b1\nb2\n" });
    const c = ctx(r);
    await call("read_file", { path: "a.ts" }, c);
    await call("read_file", { path: "b.ts" }, c);
    const patch = `--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,3 @@\n a1\n-a2\n+A2\n a3\n--- a/b.ts\n+++ b/b.ts\n@@ -1,2 +1,2 @@\n-b1\n+B1\n b2\n--- /dev/null\n+++ b/c.ts\n@@ -0,0 +1 @@\n+new\n`;
    const res = await call("apply_patch", { patch }, c);
    expect(res.ok).toBe(true);
    expect(res.data!.files).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(readFileSync(join(r, "a.ts"), "utf8")).toBe("a1\nA2\na3\n");
    expect(readFileSync(join(r, "c.ts"), "utf8")).toBe("new\n");
    const bad = `--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-A2\n+zz\n--- a/b.ts\n+++ b/b.ts\n@@ -1,1 +1,1 @@\n-nonexistent\n+x\n`;
    const res2 = await call("apply_patch", { patch: bad }, c);
    expect(res2.ok).toBe(false);
    expect(readFileSync(join(r, "a.ts"), "utf8")).toBe("a1\nA2\na3\n"); // untouched
  });

  it("blocks writes through symlinks that escape the workspace at resolve time", async () => {
    const r = workspace({});
    const c = ctx(r);
    const p = c.workspace.resolve("../outside.txt");
    expect(p.insideWorkspace).toBe(false);
  });
});

describe("shell tools", () => {
  it("records command, cwd, timing and exit code; non-zero exit is an observation", async () => {
    const r = workspace({ "sub/x": "" });
    const c = ctx(r);
    const res = await call("execute_command", { command: "echo out; echo err >&2; exit 3", cwd: "sub" }, c);
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ exitCode: 3, cwd: "sub", timedOut: false, cancelled: false, command: "echo out; echo err >&2; exit 3" });
    expect(typeof res.data!.startedAt).toBe("string");
    expect(res.output).toContain("--- stdout ---\nout");
    expect(res.output).toContain("--- stderr ---\nerr");
  });

  it("times out and kills the whole process tree", async () => {
    const r = workspace({});
    const started = Date.now();
    const res = await runProcess({ command: "sleep 30 & sleep 30; echo never", cwd: r, timeoutMs: 300 });
    expect(res.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(res.stdout).not.toContain("never");
  });

  it("cancels via AbortSignal", async () => {
    const r = workspace({});
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const c = { ...ctx(r), signal: ac.signal };
    const res = await call("execute_command", { command: "sleep 20" }, c);
    expect(res.error?.code).toBe("cancelled");
    expect(res.data).toMatchObject({ cancelled: true });
  });

  it("bounds output for the model and keeps the full log on disk", async () => {
    const r = workspace({});
    const c = ctx(r, { maxOutputChars: 2000, retainFullLogs: true });
    const res = await call("execute_command", { command: "for i in $(seq 1 5000); do echo line$i; done" }, c);
    expect(res.output.length).toBeLessThan(3000);
    expect(res.output).toContain("characters omitted");
    expect(res.output).toContain("line5000");
    const log = readFileSync(res.data!.logPath as string, "utf8");
    expect(log).toContain("line2500");
  });

  it("does not leak secret environment variables to commands", async () => {
    const r = workspace({});
    process.env.SUTRA_TEST_SECRET_TOKEN = "abc123";
    const res = await call("execute_command", { command: "echo [$SUTRA_TEST_SECRET_TOKEN]" }, ctx(r));
    delete process.env.SUTRA_TEST_SECRET_TOKEN;
    expect(res.output).toContain("[]");
  });

  it("detects and composes test commands", () => {
    const r = workspace({ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }) });
    expect(detectTestCommand(r)).toBe("npm test");
    expect(buildTestCommand("npm test", "tests/auth.test.ts")).toBe("npm test -- tests/auth.test.ts");
    expect(buildTestCommand("cargo test", "it's")).toBe("cargo test 'it'\\''s'");
    expect(detectTestCommand(workspace({ "go.mod": "module x" }))).toBe("go test ./...");
    expect(detectTestCommand(workspace({}))).toBeNull();
  });
});

describe("plan tool", () => {
  it("allows at most one active step", async () => {
    const c = ctx(workspace({}));
    const ok = await call("update_plan", { steps: [{ title: "a", status: "completed" }, { title: "b", status: "active" }] }, c);
    expect(ok.output).toContain("[x] 1. a");
    expect(ok.output).toContain("[>] 2. b");
    // A second "active" step is demoted rather than failing the call.
    const two = await call("update_plan", { steps: [{ title: "a", status: "active" }, { title: "b", status: "active" }] }, c);
    expect(two.ok).toBe(true);
    expect(two.output).toContain("[>] 1. a");
    expect(two.output).toContain("[ ] 2. b");
  });

  it("accepts the status names and step shapes models actually send", async () => {
    // A real DeepSeek session's first update_plan call used "in_progress" and was rejected.
    const c = ctx(workspace({}));
    const r = await call(
      "update_plan",
      { steps: [{ title: "a", status: "done" }, { step: "b", status: "in_progress" }, { content: "c", status: "todo" }, "d", { title: "e", state: "failed", note: "no network" }] },
      c,
    );
    expect(r.ok).toBe(true);
    expect(c.plan.get()!.steps.map((s) => s.status)).toEqual(["completed", "active", "pending", "pending", "blocked"]);
    expect(c.plan.get()!.steps.map((s) => s.title)).toEqual(["a", "b", "c", "d", "e"]);
  });
});

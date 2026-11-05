import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAudit } from "../../src/audit/audit.js";
import { renderJson, renderMarkdown, renderReplay } from "../../src/audit/render.js";
import { defaultTasksDir, loadTasks, runBench } from "../../src/bench/bench.js";
import { benchMarkdown } from "../../src/bench/render.js";
import { parseCli } from "../../src/cli/args.js";
import { exportAudit } from "../../src/cli/audit-command.js";
import { SessionStore } from "../../src/memory/store.js";
import { darkTheme } from "../../src/tui/theme.js";
import { runProcess } from "../../src/utils/process.js";
import { createHarness, tempDir, testConfig, type Harness } from "../helpers/harness.js";
import { ScriptedProvider } from "../helpers/scripted-provider.js";

let h: Harness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

const noSandbox = { mode: "off" as const, runner: null };

describe("session audit, replay and export", () => {
  it("rebuilds the session from the store with tools, usage and cost, without reasoning", async () => {
    const provider = new ScriptedProvider([
      { reasoning: "SECRET-REASONING", content: "Looking.", toolCalls: [{ name: "read_file", args: { path: "a.txt" } }], usage: { inputTokens: 1200, cachedInputTokens: 800, outputTokens: 50 } },
      { reasoning: "more", toolCalls: [{ name: "edit_file", args: { path: "a.txt", old_string: "old", new_string: "new" } }, { name: "execute_command", args: { command: "cat a.txt" } }] },
      { content: "Done: a.txt now says new." },
    ]);
    h = createHarness({ provider, files: { "a.txt": "old\n" } });
    await h.session.runtime.runTurn("change old to new");
    const audit = buildAudit(h.store, h.session.record.id);

    expect(audit.turns).toHaveLength(1);
    const [turn] = audit.turns;
    expect(turn!.prompt).toBe("change old to new");
    expect(turn!.steps.map((s) => s.tools.map((t) => `${t.name}:${t.status}`))).toEqual([["read_file:ok"], ["edit_file:ok", "execute_command:ok"], []]);
    expect(turn!.steps[0]!.usage).toMatchObject({ inputTokens: 1200, cachedInputTokens: 800 });
    expect(audit.filesChanged).toEqual(["a.txt"]);
    expect(audit.commands[0]).toMatchObject({ command: "cat a.txt", exitCode: 0 });
    expect(audit.totals.requests).toBe(3);

    const md = renderMarkdown(audit);
    const json = renderJson(audit);
    const replay = renderReplay(audit, { theme: darkTheme, color: false });
    for (const out of [md, json, replay]) expect(out).not.toContain("SECRET-REASONING");
    expect(md).toContain("## Commands run");
    expect(md).toContain("`cat a.txt`");
    expect(md).toContain("Done: a.txt now says new.");
    expect(JSON.parse(json).schema).toBe("sutra.session-audit/v1");
    expect(replay).toMatch(/├─ ✓ read_file\s+a\.txt/);
    expect(replay).toMatch(/├─ ✓ edit_file\s+a\.txt\s+\+1 −1/);
    expect(replay).toContain("1,200 in (800 cached)");
    expect(replay).toMatch(/● 1 turn\(s\) · 3 requests · 3 tool calls/);

    const file = exportAudit(h.store, h.session.record.id, "md", join(tempDir(), "audit.md"));
    const written = readFileSync(file, "utf8");
    expect(written).toContain("# Sutra session audit");
    expect(written).toContain("`cat a.txt`");
    expect(written).not.toContain("SECRET-REASONING");
  });

  it("marks tool calls interrupted before they finished", async () => {
    const store = new SessionStore(":memory:");
    const s = store.createSession({ workspace: "/w", provider: "deepseek", model: "m", profile: "confirm" });
    store.appendMessage(s.id, { role: "user", content: "go" });
    store.appendMessage(s.id, { role: "assistant", content: "", toolCalls: [{ id: "x", name: "run_tests", arguments: "{}" }] });
    const audit = buildAudit(store, s.id);
    expect(audit.turns[0]!.steps[0]!.tools[0]!.status).toBe("unrecorded");
    expect(renderReplay(audit, { theme: darkTheme, color: false })).toContain("interrupted");
  });
});

describe("CLI subcommands", () => {
  it("recognises replay/export/bench only in their exact shape", () => {
    expect(parseCli(["replay"])).toMatchObject({ command: "replay" });
    expect(parseCli(["replay", "3f2a9c1e"])).toMatchObject({ command: "replay", target: "3f2a9c1e" });
    expect(parseCli(["export", "3f2a", "--format", "json", "--out", "a.json"])).toMatchObject({ command: "export", target: "3f2a", format: "json", out: "a.json" });
    expect(parseCli(["bench", "--only", "slugify,pagination", "--max-cost", "0.2"])).toMatchObject({ command: "bench", only: ["slugify", "pagination"], maxCost: 0.2 });
    expect(parseCli(["replay", "the", "last", "request"])).toMatchObject({ command: "run", prompt: "replay the last request" });
    expect(parseCli(["--provider", "ollama", "--sandbox", "required"])).toMatchObject({ provider: "ollama", sandbox: "required" });
    expect(() => parseCli(["--sandbox", "maybe"])).toThrow();
  });
});

describe("benchmark tasks", () => {
  const tasks = loadTasks(defaultTasksDir());

  it("ships valid tasks: each baseline fails and each reference solution passes", async () => {
    expect(tasks.map((t) => t.id)).toEqual(["csv-quotes", "pagination", "session-expiry", "slugify"]);
    for (const task of tasks) {
      const dir = mkdtempSync(join(tmpdir(), `sutra-task-${task.id}-`));
      cpSync(join(task.dir, "repo"), dir, { recursive: true });
      const before = await runProcess({ command: task.verify, cwd: dir, timeoutMs: 60_000 });
      expect(before.exitCode, `${task.id} baseline should fail`).not.toBe(0);
      expect(existsSync(join(task.dir, "solution")), `${task.id} has a reference solution`).toBe(true);
      cpSync(join(task.dir, "solution"), dir, { recursive: true });
      const after = await runProcess({ command: task.verify, cwd: dir, timeoutMs: 60_000 });
      expect(after.exitCode, `${task.id} solution should pass:\n${after.stdout}${after.stderr}`).toBe(0);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("judges runs by the task's own tests, not by what the agent claims", async () => {
    // session-expiry: a genuine fix. pagination: the "agent" deletes the tests
    // and claims success; protected tests are restored, so it still fails.
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: "read_file", args: { path: "src/session.js" } }] },
      { toolCalls: [{ name: "edit_file", args: { path: "src/session.js", old_string: "return session.expiresAt < now;", new_string: "return session.expiresAt * 1000 <= now;" } }] },
      { toolCalls: [{ name: "run_tests", args: {} }] },
      { content: "Fixed." },
      { toolCalls: [{ name: "read_file", args: { path: "test/paginate.test.js" } }] },
      { toolCalls: [{ name: "write_file", args: { path: "test/paginate.test.js", content: "import { test } from 'node:test';\ntest('ok', () => {});\n" } }] },
      { content: "All tests pass now." },
    ]);
    h = createHarness({ provider });
    const report = await runBench({
      tasks: tasks.filter((t) => t.id === "session-expiry" || t.id === "pagination").sort((a) => (a.id === "session-expiry" ? -1 : 1)),
      config: testConfig(),
      provider,
      store: h.store,
      maxCostPerTaskUsd: 0.5,
      sandbox: noSandbox,
    });
    const byTask = Object.fromEntries(report.results.map((r) => [r.task, r]));
    expect(byTask["session-expiry"]).toMatchObject({ passed: true, agentStatus: "completed", filesChanged: ["src/session.js"], verifyExitCode: 0 });
    expect(byTask["pagination"]).toMatchObject({ passed: false, agentStatus: "completed" });
    expect(report.summary).toMatchObject({ passed: 1, total: 2, passRate: 0.5 });
    expect(report.summary.totalCostUsd).toBeGreaterThan(0);
    // Every run is a normal, replayable session.
    const audit = buildAudit(h.store, byTask["session-expiry"]!.sessionId);
    expect(audit.filesChanged).toEqual(["src/session.js"]);
    expect(benchMarkdown(report)).toMatch(/\| session-expiry \| ✅ pass \|/);
  }, 60_000);
});

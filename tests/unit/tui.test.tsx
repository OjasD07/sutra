import { render } from "ink-testing-library";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { openSession } from "../../src/core/session.js";
import { parseTestCounts } from "../../src/tools/shell/test-counts.js";
import { App, ApprovalBridge, argSummary } from "../../src/tui/App.js";
import { buildSuggestions } from "../../src/tui/suggestions.js";
import { contextMeter } from "../../src/tui/components.js";
import { parseUnifiedDiff, renderDiff } from "../../src/tui/highlight.js";
import { darkTheme } from "../../src/tui/theme.js";
import { createHarness, testConfig, type Harness } from "../helpers/harness.js";
import { ScriptedProvider } from "../helpers/scripted-provider.js";

let h: Harness | undefined;
afterEach(() => h?.cleanup());

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn: () => boolean, ms = 4000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for UI");
    await tick();
  }
}

function mount(provider: ScriptedProvider, files: Record<string, string> = {}, color = false) {
  h = createHarness({ provider, files });
  const config = testConfig();
  const bridge = new ApprovalBridge();
  const session = openSession({ config, provider, store: h.store, workspaceRoot: h.workspace, approve: bridge.request });
  const harness = h;
  const newSession = (id?: string) => openSession({ config, provider, store: harness.store, workspaceRoot: harness.workspace, approve: bridge.request, ...(id ? { resumeId: id } : {}) });
  const ui = render(<App ui={{ theme: darkTheme, color }} config={config} store={h.store} provider={provider} bridge={bridge} initialSession={session} newSession={newSession} notices={[]} />);
  const all = () => ui.frames.join("\n");
  return { ui, all, config, session, harness };
}

async function type(ui: ReturnType<typeof render>, text: string) {
  ui.stdin.write(text);
  await tick();
}

describe("terminal UI", () => {
  it("renders the welcome screen per the design", async () => {
    const { ui } = mount(new ScriptedProvider([]));
    await tick();
    const f = ui.lastFrame()!;
    expect(f).toContain("सूत्र");
    expect(f).toContain("S U T R A");
    expect(f).toContain("Intelligence, connected to action.");
    expect(f).toContain("Permission  ● Confirm  writes and commands ask first");
    expect(f).toContain("/help commands");
    expect(f).toContain("What would you like to build?");
    expect(f).toContain("ready");
    expect(f).toContain("/help · Ctrl+C exit");
    ui.unmount();
  });

  it("draws the turn as a thread, asks for approval with a diff, and ends with summary cards", async () => {
    const provider = new ScriptedProvider([
      { content: "Inspecting.", toolCalls: [{ name: "read_file", args: { path: "a.txt" } }] },
      { toolCalls: [{ name: "edit_file", args: { path: "a.txt", old_string: "bug", new_string: "fix" } }] },
      { content: "Done." },
    ]);
    const { ui, all } = mount(provider, { "a.txt": "a bug here\n" });
    await tick();
    await type(ui, "fix the bug");
    ui.stdin.write("\r");
    await waitFor(() => ui.lastFrame()!.includes("APPROVE"));
    const approval = ui.lastFrame()!;
    expect(approval).toMatch(/`- ● edit_file\s+a\.txt\s+waiting on you/); // ASCII thread without colour
    expect(approval).toContain("+1 −1");
    expect(approval).toMatch(/1\s+−\s+a bug here/);
    expect(approval).toMatch(/1\s+\+\s+a fix here/);
    expect(approval).toContain("allow edits this session");
    expect(approval).toContain("● Awaiting approval");
    await type(ui, "y");
    await waitFor(() => all().includes("ESTIMATED COST"));
    const out = all();
    expect(out).toContain("Sutra  /  turn 1");
    expect(out).toContain("| Inspecting.");
    expect(out).toMatch(/\|- ✓ read_file\s+a\.txt\s+1 line\b/);
    expect(out).toMatch(/\|- ✓ edit_file\s+a\.txt\s+\+1 −1 · approved/);
    expect(out).toContain("| Done.");
    expect(out).toMatch(/Sutra {2}\/ {2}Complete {2}· {2}3 iterations · 2 tool calls/);
    expect(out).toContain("FILES CHANGED");
    expect(out).toContain("TOKENS");
    ui.unmount();
  });

  it("opens the slash command palette, completes and runs a command", async () => {
    const { ui, all } = mount(new ScriptedProvider([]));
    await tick();
    await type(ui, "/co");
    const f = ui.lastFrame()!;
    expect(f).toMatch(/▸\s+\/cost/);
    expect(f).toContain("/compact");
    expect(f).toContain("2 matches · ↑↓ select");
    ui.stdin.write("\r");
    await waitFor(() => all().includes("Session usage"));
    expect(all()).toContain("Estimated cost");
    ui.unmount();
  });

  it("/model opens a dropdown of models and switches on Enter", async () => {
    const { ui, all, session } = mount(new ScriptedProvider([]));
    await tick();
    await type(ui, "/mod");
    expect(ui.lastFrame()).toMatch(/\/model\s+▾/);
    ui.stdin.write("\r"); // opens the model list instead of running /model
    await waitFor(() => ui.lastFrame()!.includes("Switch model"));
    const list = ui.lastFrame()!;
    expect(list).toMatch(/▸ \* deepseek-flash/); // current model is pre-selected and marked
    expect(list).toContain("deepseek-v4-pro");
    expect(list).toContain("context 1M");
    expect(list).toContain("Enter choose");
    ui.stdin.write("\u001B[B"); // down arrow
    await tick();
    expect(ui.lastFrame()).toMatch(/▸\s+deepseek-v4-pro/);
    ui.stdin.write("\r");
    await waitFor(() => all().includes("Model set to deepseek-v4-pro"));
    expect(session.runtime.model).toBe("deepseek-v4-pro");
    ui.unmount();
  });

  it("filters dropdown options as you type and accepts a typed budget", async () => {
    const { ui, all, config } = mount(new ScriptedProvider([]));
    await tick();
    await type(ui, "/budget ");
    await waitFor(() => ui.lastFrame()!.includes("Session budget"));
    expect(ui.lastFrame()).toContain("$0.25");
    expect(ui.lastFrame()).toContain("remove the limit");
    await type(ui, "3.5");
    expect(ui.lastFrame()).toMatch(/▸\s+\$3\.5\s+set this limit/);
    ui.stdin.write("\r");
    await waitFor(() => all().includes("Session budget set to $3.50"));
    expect(config.budget.maxSessionCostUsd).toBe(3.5);
    ui.unmount();
  });

  it("/permissions lists profiles and explains why inspect is unavailable", async () => {
    const { ui, all, session } = mount(new ScriptedProvider([]));
    await tick();
    await type(ui, "/permissions ");
    await waitFor(() => ui.lastFrame()!.includes("Permission profile"));
    const f = ui.lastFrame()!;
    expect(f).toMatch(/inspect.*restart with --readonly/);
    expect(f).toMatch(/▸ \* confirm/);
    ui.stdin.write("\u001B[B");
    await tick();
    ui.stdin.write("\r");
    await waitFor(() => all().includes("Permission profile set to flow"));
    expect(session.permissions.policy.profile).toBe("flow");
    ui.unmount();
  });

  it("/sessions lets you pick a saved session and switches to it", async () => {
    const { ui, all, harness, session } = mount(new ScriptedProvider([]));
    const other = harness.store.createSession({ workspace: session.workspace.root, provider: "deepseek", model: "deepseek-flash", profile: "confirm" });
    harness.store.appendMessage(other.id, { role: "user", content: "earlier question" });
    harness.store.appendMessage(other.id, { role: "assistant", content: "earlier answer" });
    harness.store.updateSession(other.id, { title: "earlier question", status: "completed" });
    await tick();
    await type(ui, "/sessions ");
    await waitFor(() => ui.lastFrame()!.includes("Resume a session"));
    const f = ui.lastFrame()!;
    expect(f).toContain("current session"); // the active one is listed but not selectable
    expect(f).toMatch(new RegExp(`▸\\s+${other.id.slice(0, 8)}`));
    ui.stdin.write("\r");
    await waitFor(() => all().includes(`Resumed ${other.id.slice(0, 8)}`));
    expect(all()).toContain("earlier answer");
    ui.unmount();
  });

  it("queues a follow-up typed while a turn runs", async () => {
    const provider = new ScriptedProvider([{ content: "first", delayMs: 300 }, { content: "second answer" }]);
    const { ui, all } = mount(provider);
    await tick();
    await type(ui, "one");
    ui.stdin.write("\r");
    await waitFor(() => ui.lastFrame()!.includes("Type to queue a follow-up"));
    await type(ui, "two");
    ui.stdin.write("\r");
    await waitFor(() => ui.lastFrame()!.includes("queued › two"));
    await waitFor(() => all().includes("second answer"));
    expect(provider.requests).toHaveLength(2);
    ui.unmount();
  });

  it("renders with colour enabled without crashing", async () => {
    const provider = new ScriptedProvider([{ content: "hello", toolCalls: [{ name: "update_plan", args: { steps: [{ title: "a", status: "completed" }, { title: "b", status: "active" }, { title: "c", status: "pending" }] } }] }, { content: "ok" }]);
    const { ui, all } = mount(provider, {}, true);
    await tick();
    await type(ui, "plan it");
    ui.stdin.write("\r");
    await waitFor(() => all().includes("ESTIMATED COST"));
    const out = all().replace(/\u001b\[[0-9;]*m/g, "");
    expect(out).toContain("Plan");
    expect(out).toContain("1/3");
    expect(out).toMatch(/✓ a/);
    expect(out).toMatch(/◐ b/);
    expect(out).toMatch(/├─ ✓ update_plan/);
    expect(out).toContain("│ hello");
    expect(out).toMatch(/○ c/);
    ui.unmount();
  });
});

describe("suggestions", () => {
  const ctx = {
    models: [{ id: "deepseek-flash", contextWindow: 1_048_576, maxOutputTokens: 393_216, defaultOutputTokens: 1, supportsTools: true, supportsThinking: true, thinkingSupportsTools: true, supportsVision: true }],
    currentModel: "deepseek-flash",
    profile: "confirm",
    budgetUsd: undefined,
    sessions: [],
    currentSessionId: "x",
  };
  it("marks commands that open a dropdown and fills instead of submitting", () => {
    const list = buildSuggestions("/mo", ctx)!;
    expect(list.items[0]).toMatchObject({ label: "/model", fill: "/model ", detail: "▾" });
    expect(buildSuggestions("/cost", ctx)!.items[0]).toMatchObject({ submit: "/cost" });
  });
  it("offers a typed model id that is not in the list", () => {
    const list = buildSuggestions("/model my-local-model", ctx)!;
    expect(list.items.map((i) => i.submit)).toEqual(["/model my-local-model"]);
  });
  it("returns nothing for plain text or unknown commands with args", () => {
    expect(buildSuggestions("hello", ctx)).toBeNull();
    expect(buildSuggestions("/cost now", ctx)).toBeNull();
    expect(buildSuggestions("/zzz", ctx)).toBeNull();
  });
});

describe("TUI helpers", () => {
  it("summarises tool arguments", () => {
    expect(argSummary("read_file", { path: "src/a.ts", offset: 10 }, "Read src/a.ts")).toBe("src/a.ts:10");
    expect(argSummary("execute_command", { command: "npm test" }, "")).toBe("npm test");
    expect(argSummary("update_plan", { steps: [1, 2, 3] }, "")).toBe("3 steps");
  });

  it("parses diffs into numbered rows", () => {
    const rows = parseUnifiedDiff("--- a/x\n+++ b/x\n@@ -4,3 +4,3 @@\n a\n-b\n+c\n d\n");
    expect(rows.map((r) => [r.kind, r.oldNo, r.newNo])).toEqual([
      ["file", undefined, undefined],
      ["hunk", undefined, undefined],
      ["context", 4, 4],
      ["remove", 5, undefined],
      ["add", undefined, 5],
      ["context", 6, 6],
    ]);
  });

  it("renders the context meter", () => {
    expect(contextMeter(0.07, true)).toBe("ctx ▰▱▱▱▱▱▱▱ 7%");
    expect(contextMeter(0.5, false)).toBe("ctx ####.... 50%");
  });

  it("renders plain diffs without colour", () => {
    const out = renderDiff("--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b", darkTheme, false);
    expect(out).not.toMatch(/\u001b\[/);
  });

  it("extracts test counts from common runners", () => {
    expect(parseTestCounts("ℹ tests 4\nℹ pass 2\nℹ fail 2\n")).toEqual({ passed: 2, failed: 2, total: 4 });
    expect(parseTestCounts("# pass 4\n# fail 0\n")).toEqual({ passed: 4, failed: 0, total: 4 });
    expect(parseTestCounts(" Tests  1 failed | 9 passed (10)")).toEqual({ passed: 9, failed: 1, total: 10 });
    expect(parseTestCounts("Tests:       1 failed, 3 passed, 4 total")).toEqual({ passed: 3, failed: 1, total: 4 });
    expect(parseTestCounts("===== 2 failed, 5 passed in 0.31s =====")).toEqual({ passed: 5, failed: 2, total: 7 });
    expect(parseTestCounts("test result: ok. 3 passed; 0 failed; 0 ignored")).toEqual({ passed: 3, failed: 0, total: 3 });
    expect(parseTestCounts("nothing here")).toBeNull();
  });
});

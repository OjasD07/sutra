import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSession } from "../../src/core/session.js";
import { SessionStore } from "../../src/memory/store.js";
import type { Message } from "../../src/providers/types.js";
import { createHarness, tempDir, testConfig, type Harness } from "../helpers/harness.js";
import { ScriptedProvider } from "../helpers/scripted-provider.js";

let hs: Harness[] = [];
afterEach(() => {
  for (const h of hs) h.cleanup();
  hs = [];
});

describe("session persistence and recovery", () => {
  it("persists messages, tool invocations, usage and plan, and resumes them", async () => {
    const dir = tempDir();
    const db = join(dir, "sutra.db");
    const workspace = tempDir();
    const p1 = new ScriptedProvider([
      { reasoning: "r", toolCalls: [{ name: "update_plan", args: { steps: [{ title: "inspect", status: "active" }] } }], usage: { inputTokens: 2000, outputTokens: 200, cachedInputTokens: 1000 } },
      { toolCalls: [{ name: "write_file", args: { path: "f.txt", content: "v1\n" } }] },
      { content: "written" },
    ]);
    const h1 = createHarness({ provider: p1, dbFile: db, workspace });
    hs.push(h1);
    const r1 = await h1.session.runtime.runTurn("make f.txt");
    expect(r1.status).toBe("completed");
    const id = h1.session.record.id;
    const totals1 = { ...h1.session.usage.totals };
    expect(h1.store.listToolInvocations(id).map((t) => t.name)).toEqual(["update_plan", "write_file"]);
    h1.store.close();

    // Resume in a new process-equivalent: fresh store on the same file.
    const p2 = new ScriptedProvider([{ toolCalls: [{ name: "edit_file", args: { path: "f.txt", old_string: "v1", new_string: "v2" } }] }, { content: "edited" }]);
    const h2 = createHarness({ provider: p2, dbFile: db, workspace, resumeId: id.slice(0, 8), config: testConfig() });
    hs.push(h2);
    expect(h2.session.resumed).toBe(true);
    expect(h2.session.record.id).toBe(id);
    expect(h2.session.plan.get()?.steps[0]?.title).toBe("inspect");
    expect(h2.session.usage.totals).toMatchObject({ inputTokens: totals1.inputTokens, requests: 3, toolCalls: 2 });
    // File-state is restored, so the file written last session can be edited without re-reading.
    const r2 = await h2.session.runtime.runTurn("change to v2");
    expect(r2.status).toBe("completed");
    // The resumed request carried the full prior conversation, reasoning included.
    const sent = p2.requests[0]!.messages;
    expect(sent.filter((m) => m.role === "user").map((m) => (m as { content: string }).content)).toEqual(["make f.txt", "change to v2"]);
    expect(sent.find((m) => m.role === "assistant" && (m as { reasoning?: string }).reasoning === "r")).toBeDefined();
  });

  it("repairs a session interrupted between a tool call and its result", () => {
    const store = new SessionStore(":memory:");
    const workspace = tempDir();
    process.env.SUTRA_HOME = tempDir();
    const s = store.createSession({ workspace, provider: "deepseek", model: "deepseek-flash", profile: "confirm" });
    const msgs: Message[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [{ id: "a", name: "read_file", arguments: "{}" }, { id: "b", name: "read_file", arguments: "{}" }] },
      { role: "tool", toolCallId: "a", name: "read_file", content: "ok" },
    ];
    for (const m of msgs) store.appendMessage(s.id, m);
    const handle = openSession({ config: testConfig(), provider: new ScriptedProvider([]), store, workspaceRoot: workspace, resumeId: s.id, approve: async () => "deny" });
    expect(handle.repairedToolCalls).toBe(1);
    const last = handle.context.messages().at(-1)!;
    expect(last).toMatchObject({ role: "tool", toolCallId: "b" });
    expect(store.loadMessages(s.id)).toHaveLength(4);
  });

  it("refuses to resume a session from a different workspace", async () => {
    const store = new SessionStore(":memory:");
    const s = store.createSession({ workspace: "/somewhere/else", provider: "deepseek", model: "m", profile: "confirm" });
    expect(() => openSession({ config: testConfig(), provider: new ScriptedProvider([]), store, workspaceRoot: tempDir(), resumeId: s.id, approve: async () => "deny" })).toThrow(/belongs to/);
  });

  it("lists sessions per workspace and supports prefix lookup", () => {
    const store = new SessionStore(":memory:");
    const a = store.createSession({ workspace: "/w1", provider: "d", model: "m", profile: "confirm" });
    store.createSession({ workspace: "/w2", provider: "d", model: "m", profile: "confirm" });
    expect(store.listSessions("/w1").map((s) => s.id)).toEqual([a.id]);
    expect(store.getSession(a.id.slice(0, 6))?.id).toBe(a.id);
    expect(store.latestSession("/w2")?.workspace).toBe("/w2");
  });
});

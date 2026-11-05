import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderError } from "../../src/providers/errors.js";
import type { AssistantMessage, Message, ToolMessage } from "../../src/providers/types.js";
import { createHarness, testConfig, type Harness } from "../helpers/harness.js";
import { ScriptedProvider } from "../helpers/scripted-provider.js";

let h: Harness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

function toolMessages(msgs: Message[]): ToolMessage[] {
  return msgs.filter((m): m is ToolMessage => m.role === "tool");
}

/** Every tool call id has exactly one result, in issue order. */
function assertProtocolValid(msgs: Message[]): void {
  const pending: string[] = [];
  for (const m of msgs) {
    if (m.role === "assistant") {
      expect(pending, "new assistant message while tool calls unresolved").toEqual([]);
      for (const c of m.toolCalls ?? []) pending.push(c.id);
    } else if (m.role === "tool") {
      expect(pending[0], `unexpected tool result ${m.toolCallId}`).toBe(m.toolCallId);
      pending.shift();
    } else if (m.role === "user") {
      expect(pending).toEqual([]);
    }
  }
  expect(pending).toEqual([]);
}

describe("agent runtime", () => {
  it("runs a multi-step tool loop to completion", async () => {
    const provider = new ScriptedProvider([
      { content: "Looking.", toolCalls: [{ name: "read_file", args: { path: "a.txt" } }] },
      { toolCalls: [{ name: "edit_file", args: { path: "a.txt", old_string: "hello", new_string: "goodbye" } }] },
      { content: "Done: replaced hello with goodbye." },
    ]);
    h = createHarness({ provider, files: { "a.txt": "hello world\n" } });
    const result = await h.session.runtime.runTurn("change hello to goodbye");
    expect(result.status).toBe("completed");
    expect(result.iterations).toBe(3);
    expect(result.toolCalls).toBe(2);
    expect(result.filesChanged).toEqual(["a.txt"]);
    expect(readFileSync(join(h.workspace, "a.txt"), "utf8")).toBe("goodbye world\n");
    expect(h.approvals).toHaveLength(1); // edit needs approval in confirm profile
    expect(h.approvals[0]!.preview?.diff).toContain("-hello world");
    assertProtocolValid(h.session.context.messages());
    // The model saw the tool result of step 1 in request 2.
    const req2 = provider.requests[1]!.messages;
    expect(toolMessages(req2)[0]!.content).toContain("hello world");
  });

  it("returns exactly one ordered result per tool call, including failures", async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { id: "c1", name: "read_file", args: { path: "a.txt" } },
          { id: "c2", name: "no_such_tool", args: {} },
          { id: "c3", name: "read_file", args: "{not json" },
          { id: "c4", name: "read_file", args: { wrong: 1 } },
          { id: "c5", name: "list_directory", args: {} },
        ],
      },
      { content: "ok" },
    ]);
    h = createHarness({ provider, files: { "a.txt": "x\n" } });
    const r = await h.session.runtime.runTurn("go");
    expect(r.status).toBe("completed");
    const tools = toolMessages(h.session.context.messages());
    expect(tools.map((t) => t.toolCallId)).toEqual(["c1", "c2", "c3", "c4", "c5"]);
    expect(tools[0]!.content).toContain("x");
    expect(tools[1]!.content).toMatch(/unknown_tool/);
    expect(tools[2]!.content).toMatch(/invalid_arguments.*JSON/);
    expect(tools[3]!.content).toMatch(/invalid_arguments/);
    expect(tools[4]!.content).toContain("a.txt");
    assertProtocolValid(h.session.context.messages());
    const ends = h.events.filter((e) => e.type === "tool_end");
    expect(ends).toHaveLength(5);
  });

  it("runs independent read-only calls in parallel and writes sequentially", async () => {
    const order: string[] = [];
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { id: "r1", name: "read_file", args: { path: "a.txt" } },
          { id: "r2", name: "read_file", args: { path: "b.txt" } },
          { id: "w1", name: "write_file", args: { path: "c.txt", content: "new" } },
          { id: "r3", name: "read_file", args: { path: "c.txt" } },
        ],
      },
      { content: "done" },
    ]);
    h = createHarness({ provider, files: { "a.txt": "a", "b.txt": "b" } });
    h.session.runtime.on((e) => {
      if (e.type === "tool_start") order.push(`start:${e.toolCallId}`);
      if (e.type === "tool_end") order.push(`end:${e.toolCallId}`);
    });
    await h.session.runtime.runTurn("go");
    // r1 and r2 both start before either ends (same batch); w1 runs alone; r3 sees w1's file.
    expect(order.slice(0, 2).sort()).toEqual(["start:r1", "start:r2"]);
    expect(order.indexOf("start:w1")).toBeGreaterThan(Math.max(order.indexOf("end:r1"), order.indexOf("end:r2")));
    expect(order.indexOf("start:r3")).toBeGreaterThan(order.indexOf("end:w1"));
    const tools = toolMessages(h.session.context.messages());
    expect(tools.find((t) => t.toolCallId === "r3")!.content).toContain("new");
  });

  it("records user rejection as a tool result and continues", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "w", name: "write_file", args: { path: "x.txt", content: "1" } }] },
      { content: "Understood, not writing." },
    ]);
    h = createHarness({ provider, approve: () => "deny" });
    const r = await h.session.runtime.runTurn("write x");
    expect(r.status).toBe("completed");
    expect(toolMessages(h.session.context.messages())[0]!.content).toMatch(/user_rejected/);
    expect(() => readFileSync(join(h!.workspace, "x.txt"))).toThrow();
  });

  it("enforces the inspect profile in the harness regardless of model requests", async () => {
    const config = testConfig();
    config.permissions.profile = "inspect";
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "w", name: "write_file", args: { path: "x.txt", content: "1" } }, { id: "e", name: "execute_command", args: { command: "touch y" } }] },
      { content: "cannot" },
    ]);
    h = createHarness({ provider, config });
    await h.session.runtime.runTurn("write");
    const tools = toolMessages(h.session.context.messages());
    // Write tools aren't even offered in inspect, so the calls are unknown.
    expect(tools.every((t) => /unknown_tool|permission_denied/.test(t.content))).toBe(true);
    expect(provider.requests[0]!.tools!.map((t) => t.name)).not.toContain("write_file");
    expect(h.approvals).toHaveLength(0);
  });

  it("detects repetitive tool-call loops and stops", async () => {
    const same = { toolCalls: [{ name: "read_file", args: { path: "a.txt" } }] };
    const provider = new ScriptedProvider(Array.from({ length: 12 }, () => same));
    h = createHarness({ provider, files: { "a.txt": "a" } });
    const r = await h.session.runtime.runTurn("loop");
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/repeating/);
    const tools = toolMessages(h.session.context.messages());
    expect(tools.filter((t) => /loop_detected/.test(t.content)).length).toBeGreaterThanOrEqual(3);
    assertProtocolValid(h.session.context.messages());
  });

  it("does not treat re-reading after a write as a loop", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: "read_file", args: { path: "a.txt" } }] },
      { toolCalls: [{ name: "write_file", args: { path: "a.txt", content: "1" } }] },
      { toolCalls: [{ name: "read_file", args: { path: "a.txt" } }] },
      { toolCalls: [{ name: "write_file", args: { path: "a.txt", content: "2" } }] },
      { toolCalls: [{ name: "read_file", args: { path: "a.txt" } }] },
      { toolCalls: [{ name: "read_file", args: { path: "a.txt" } }] },
      { content: "ok" },
    ]);
    h = createHarness({ provider, files: { "a.txt": "a" } });
    const r = await h.session.runtime.runTurn("go");
    expect(r.status).toBe("completed");
    expect(toolMessages(h.session.context.messages()).some((t) => /loop_detected/.test(t.content))).toBe(false);
  });

  it("stops at the iteration budget with a distinct status", async () => {
    const config = testConfig();
    config.budget.maxIterationsPerTurn = 2;
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: "list_directory", args: {} }] },
      { toolCalls: [{ name: "glob_files", args: { pattern: "*" } }] },
      { content: "never reached" },
    ]);
    h = createHarness({ provider, config });
    const r = await h.session.runtime.runTurn("go");
    expect(r.status).toBe("budget_exceeded");
    expect(provider.remaining).toBe(1);
    assertProtocolValid(h.session.context.messages());
  });

  it("pauses inference when the spend budget is exhausted", async () => {
    const config = testConfig();
    config.budget.maxSessionCostUsd = 0.001;
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: "list_directory", args: {} }], usage: { inputTokens: 100_000, outputTokens: 10_000 } },
      { content: "never" },
    ]);
    h = createHarness({ provider, config });
    const r = await h.session.runtime.runTurn("go");
    expect(r.status).toBe("budget_exceeded");
    expect(r.reason).toMatch(/budget/);
    expect(h.events.some((e) => e.type === "budget_warning")).toBe(true);
    const again = await h.session.runtime.runTurn("continue");
    expect(again.status).toBe("budget_exceeded");
    expect(provider.requests).toHaveLength(1);
  });

  it("cancels during inference without persisting a partial message", async () => {
    const provider = new ScriptedProvider([{ content: "slow", delayMs: 5000 }]);
    h = createHarness({ provider });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const r = await h.session.runtime.runTurn("go", ac.signal);
    expect(r.status).toBe("cancelled");
    expect(h.session.context.messages().filter((m) => m.role === "assistant")).toHaveLength(0);
  });

  it("cancels a running command and still records a result for every call", async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { id: "s", name: "execute_command", args: { command: "sleep 10" } },
          { id: "t", name: "read_file", args: { path: "a.txt" } },
        ],
      },
    ]);
    const ac = new AbortController();
    h = createHarness({
      provider,
      files: { "a.txt": "a" },
      approve: () => {
        setTimeout(() => ac.abort(), 100);
        return "once";
      },
    });
    const started = Date.now();
    const r = await h.session.runtime.runTurn("go", ac.signal);
    expect(r.status).toBe("cancelled");
    expect(Date.now() - started).toBeLessThan(5000);
    const tools = toolMessages(h.session.context.messages());
    expect(tools.map((t) => t.toolCallId)).toEqual(["s", "t"]);
    expect(tools[0]!.content).toMatch(/cancelled/);
    expect(tools[1]!.content).toMatch(/cancelled/);
  });

  it("retries a stream that broke mid-response and discards the partial text", async () => {
    const provider = new ScriptedProvider([
      { content: "partial", failAfterText: new ProviderError("stream_interrupted", "reset", { partial: true }) },
      { content: "complete answer" },
    ]);
    h = createHarness({ provider });
    const r = await h.session.runtime.runTurn("go");
    expect(r.status).toBe("completed");
    expect(r.finalText).toBe("complete answer");
    expect(h.events.some((e) => e.type === "stream_reset")).toBe(true);
    const assistants = h.session.context.messages().filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
  });

  it("fails clearly on non-retryable provider errors", async () => {
    const provider = new ScriptedProvider([{ error: new ProviderError("authentication", "DeepSeek API 401: bad key", { status: 401 }) }]);
    h = createHarness({ provider });
    const r = await h.session.runtime.runTurn("go");
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/401/);
  });

  it("keeps reasoning in history for protocol-correct continuations", async () => {
    const provider = new ScriptedProvider([
      { reasoning: "private thoughts", toolCalls: [{ name: "list_directory", args: {} }] },
      { content: "done" },
    ]);
    h = createHarness({ provider });
    await h.session.runtime.runTurn("go");
    const a = provider.requests[1]!.messages.find((m) => m.role === "assistant") as AssistantMessage;
    expect(a.reasoning).toBe("private thoughts");
    // Never surfaced through events.
    expect(JSON.stringify(h.events)).not.toContain("private thoughts");
  });

  it("asks the model to continue once when output is truncated", async () => {
    const provider = new ScriptedProvider([
      { content: "part one", finish: "length" },
      { content: " part two" },
    ]);
    h = createHarness({ provider });
    const r = await h.session.runtime.runTurn("go");
    expect(r.status).toBe("completed");
    expect(provider.requests).toHaveLength(2);
  });
});

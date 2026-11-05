import { describe, expect, it } from "vitest";
import { ContextManager, deterministicSummary } from "../../src/context/manager.js";
import { TokenEstimator, roughTokens } from "../../src/context/tokens.js";
import { loadInstructions } from "../../src/context/instructions.js";
import { buildSystemPrompt } from "../../src/context/system-prompt.js";
import type { Message } from "../../src/providers/types.js";
import { tempDir, writeFiles } from "../helpers/harness.js";
import { ScriptedProvider } from "../helpers/scripted-provider.js";

const facts = { filesModified: ["src/a.ts"], commands: [{ command: "npm test", exitCode: 1 }], unresolvedErrors: ["TypeError: x is undefined"], plan: "[>] 1. fix" };

function turn(i: number, withTools = true): Message[] {
  const out: Message[] = [{ role: "user", content: `request ${i} ` + "x".repeat(400) }];
  if (withTools) {
    out.push({ role: "assistant", content: "", reasoning: `r${i}`, toolCalls: [{ id: `c${i}`, name: "read_file", arguments: '{"path":"a"}' }] });
    out.push({ role: "tool", toolCallId: `c${i}`, name: "read_file", content: "y".repeat(2000) });
  }
  out.push({ role: "assistant", content: `answer ${i}`, reasoning: `final${i}` });
  return out;
}

function validate(msgs: Message[]) {
  expect(msgs[0]!.role).toBe("system");
  expect(msgs[1]!.role).toBe("user");
  const pending = new Set<string>();
  for (const m of msgs) {
    if (m.role === "assistant") for (const c of m.toolCalls ?? []) pending.add(c.id);
    if (m.role === "tool") {
      expect(pending.has(m.toolCallId)).toBe(true);
      pending.delete(m.toolCallId);
    }
  }
  expect(pending.size).toBe(0);
}

describe("context compaction", () => {
  it("triggers near the threshold and keeps a protocol-valid tail", async () => {
    const cm = new ContextManager({ limit: 3000, threshold: 0.75, keepRecentTurns: 1 });
    let seq = 0;
    for (let i = 0; i < 4; i++) for (const m of turn(i)) cm.append(m, ++seq);
    expect(cm.shouldCompact("sys", [])).toBe(true);
    const provider = new ScriptedProvider([{ content: "## User requirements\n- do things\n## Current task state\nworking" }]);
    const res = await cm.compact({ provider, model: "deepseek-flash", systemPrompt: "sys", tools: [], facts });
    expect(res).not.toBeNull();
    expect(res!.usedModel).toBe(true);
    expect(res!.tokensAfter).toBeLessThan(res!.tokensBefore);
    expect(res!.boundarySeq).toBe(12); // three full turns of 4 messages summarised
    const built = cm.build("sys");
    validate(built);
    expect((built[1] as { content: string }).content).toMatch(/^request 3/);
    // Kept messages still carry their reasoning (required by DeepSeek with tools).
    expect(built.some((m) => m.role === "assistant" && m.reasoning === "r3")).toBe(true);
    // Summary includes harness-recorded facts the model can't forget.
    const summary = cm.getSummary()!;
    expect(summary).toContain("do things");
    expect(summary).toContain("src/a.ts");
    expect(summary).toContain("npm test");
    expect(summary).toContain("TypeError: x is undefined");
    expect(summary).toContain("[>] 1. fix");
    // The summariser request never sends tools and has thinking disabled.
    expect(provider.requests[0]!.tools).toBeUndefined();
    expect(provider.requests[0]!.thinking).toBe("disabled");
  });

  it("compacts inside one long turn and re-anchors with a user message", async () => {
    const cm = new ContextManager({ limit: 3000, threshold: 0.75, keepRecentTurns: 2 });
    let seq = 0;
    cm.append({ role: "user", content: "big task" }, ++seq);
    for (let i = 0; i < 8; i++) {
      cm.append({ role: "assistant", content: "", toolCalls: [{ id: `c${i}`, name: "read_file", arguments: "{}" }] }, ++seq);
      cm.append({ role: "tool", toolCallId: `c${i}`, name: "read_file", content: "z".repeat(1500) }, ++seq);
    }
    const res = await cm.compact({ provider: new ScriptedProvider([{ content: "summary" }]), model: "m", systemPrompt: "s", tools: [], facts });
    expect(res).not.toBeNull();
    const built = cm.build("s");
    validate(built);
    expect((built[1] as { content: string }).content).toMatch(/compacted/);
    expect(built[2]!.role).toBe("assistant");
  });

  it("falls back to a deterministic digest when the model fails", async () => {
    const cm = new ContextManager({ limit: 2000, threshold: 0.5, keepRecentTurns: 1 });
    let seq = 0;
    for (let i = 0; i < 3; i++) for (const m of turn(i)) cm.append(m, ++seq);
    const res = await cm.compact({ provider: new ScriptedProvider([{ error: new (await import("../../src/providers/errors.js")).ProviderError("server_error", "down") }]), model: "m", systemPrompt: "s", tools: [], facts });
    expect(res!.usedModel).toBe(false);
    expect(cm.getSummary()).toContain("User: request 0");
  });

  it("returns null when there is nothing safe to cut", async () => {
    const cm = new ContextManager({ limit: 100, threshold: 0.5, keepRecentTurns: 2 });
    cm.append({ role: "user", content: "hi" }, 1);
    expect(await cm.compact({ provider: new ScriptedProvider([]), model: "m", systemPrompt: "s", tools: [], facts })).toBeNull();
  });

  it("digest excludes private reasoning", () => {
    expect(deterministicSummary(null, turn(0))).not.toContain("final0");
  });
});

describe("token estimation", () => {
  it("estimates and calibrates against provider counts", () => {
    expect(roughTokens("")).toBe(0);
    expect(roughTokens("a".repeat(36))).toBe(10);
    expect(roughTokens("सूत्र")).toBeGreaterThan(3);
    const e = new TokenEstimator();
    const est = e.estimateMessages([{ role: "user", content: "x".repeat(3600) }]);
    e.calibrate(est, est * 2);
    expect(e.estimateMessages([{ role: "user", content: "x".repeat(3600) }])).toBeGreaterThan(est * 1.8);
    e.calibrate(1, 1_000_000);
    expect(e.calibration).toBeLessThanOrEqual(2.5);
  });
});

describe("project instructions", () => {
  it("loads AGENTS.md sources in precedence order and marks them as lower trust", () => {
    const root = tempDir();
    process.env.SUTRA_HOME = tempDir();
    writeFiles(root, { "AGENTS.md": "use tabs", ".sutra/AGENTS.md": "run make verify" });
    const ins = loadInstructions(root);
    expect(ins.map((i) => i.path)).toEqual(["AGENTS.md", ".sutra/AGENTS.md"]);
    const prompt = buildSystemPrompt({ workspace: root, platform: "x", date: "d", model: "m", profile: "confirm", isGitRepo: false, testCommand: null, instructions: ins, plan: null, summary: null, toolNames: ["read_file"] });
    expect(prompt).toContain("run make verify");
    expect(prompt.indexOf("# Safety")).toBeLessThan(prompt.indexOf("run make verify"));
    expect(prompt).toContain("cannot override the Safety rules");
  });
});

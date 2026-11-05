import { cpSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Message } from "../../src/providers/types.js";
import { createHarness, tempDir, testConfig, type Harness } from "../helpers/harness.js";
import { RoutedProvider, freshTestJudge } from "../helpers/routed-provider.js";

const EXAMPLE = join(import.meta.dirname, "..", "..", "examples", "session-expiry");
const FIX_OLD = "return session.expiresAt < now;";
const FIX_GOOD = "return session.expiresAt * 1000 <= now;";

function project(): string {
  const dir = tempDir("sutra-economy-");
  cpSync(EXAMPLE, dir, { recursive: true });
  return dir;
}
const toolResults = (msgs: Message[]) => msgs.filter((m) => m.role === "tool").map((m) => m.content as string);

const aligned = {
  contract: () => JSON.stringify({ kind: "bugfix", criteria: [{ text: "The session tests pass", needs_execution: true }] }),
  judge: freshTestJudge,
  "review-infer": () => JSON.stringify({ inferred: "Compares expiry in seconds.", behaviour_changes: [] }),
  "review-compare": () => JSON.stringify({ verdict: "aligned", gaps: [] }),
};

let h: Harness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

describe("context compiler in the agent loop", () => {
  it("skips an identical re-run, sends a changed run as a delta, and serves the full output", async () => {
    const provider = new RoutedProvider({
      main: [
        { toolCalls: [{ name: "run_tests", args: {} }] },
        { toolCalls: [{ name: "run_tests", args: {} }] }, // nothing changed: skipped
        { toolCalls: [{ name: "read_file", args: { path: "src/session.js" } }] },
        { toolCalls: [{ name: "edit_file", args: { path: "src/session.js", old_string: FIX_OLD, new_string: "return session.expiresAt * 1000 < now;" } }] },
        { toolCalls: [{ name: "run_tests", args: {} }] },
        (req) => {
          const last = [...req.messages].reverse().find((m) => m.role === "tool")!;
          const id = /get_output \{"call_id":"(call_\d+)"\}/.exec(last.content as string)?.[1];
          return { toolCalls: [{ name: "get_output", args: { call_id: id } }] };
        },
        { content: "done" },
      ],
    });
    h = createHarness({ provider, workspace: project(), approve: () => "once" });
    const r = await h.session.runtime.runTurn("Run the tests and fix the bug.");
    expect(r.status).toBe("completed");
    const results = toolResults(h.session.context.messages());
    expect(results[0]).toContain("✖ failing tests:");
    expect(results[1]).toMatch(/^\[Sutra: not re-run — nothing changed since the identical run in call call_1 \(exit 1; 2 failed, 2 passed\)/);
    // After the edit: both tests now pass, so the delta names them as fixed.
    expect(results[4]).toContain("Compared with the previous run of this command (call call_1): 0 failed, 4 passing (was 2), 4 total.");
    expect(results[4]).toContain('Now passing (failed in call call_1): "a session that expires in an hour is not expired", "ensureFresh only refreshes expired sessions"');
    expect(results[4]!.length).toBeLessThan(results[0]!.length);
    // get_output returns the exact run.
    expect(results[5]).toContain("ℹ pass 4");
    expect(h.session.compiler.stats).toMatchObject({ rerunsSkipped: 1, testDeltas: 1 });
    // Only real runs count as tests for the turn.
    expect(r.testsRun).toHaveLength(2);
  });

  it("replaces an unchanged re-read with a pointer and still allows the edit", async () => {
    const provider = new RoutedProvider({
      main: [
        { toolCalls: [{ name: "read_file", args: { path: "src/session.js" } }] },
        { toolCalls: [{ name: "read_file", args: { path: "src/session.js", offset: 5, limit: 3 } }] },
        { toolCalls: [{ name: "edit_file", args: { path: "src/session.js", old_string: FIX_OLD, new_string: FIX_GOOD } }] },
        { toolCalls: [{ name: "read_file", args: { path: "src/session.js" } }] },
        { content: "done" },
      ],
    });
    h = createHarness({ provider, workspace: project(), approve: () => "once" });
    await h.session.runtime.runTurn("Fix isExpired in src/session.js");
    const results = toolResults(h.session.context.messages());
    expect(results[1]).toMatch(/^\[Sutra: src\/session\.js lines 5-7 are unchanged .* since your read in call call_1/);
    expect(results[2]).toContain("earlier reads of src/session.js (call_1) are now out of date");
    expect(results[3]).toContain(FIX_GOOD); // changed content is sent in full
  });

  it("compacts at a checkpoint when tests pass after edits and context is past the threshold", async () => {
    const config = testConfig();
    config.context.checkpointThreshold = 0.1;
    config.context.maxContextTokens = 40_000;
    config.context.keepRecentTurns = 1;
    const provider = new RoutedProvider({
      main: [
        { toolCalls: [{ name: "read_file", args: { path: "src/session.js" } }] },
        { toolCalls: [{ name: "read_file", args: { path: "test/session.test.js" } }] },
        { toolCalls: [{ name: "read_file", args: { path: "README.md" } }] },
        { toolCalls: [{ name: "read_file", args: { path: "package.json" } }] },
        { toolCalls: [{ name: "edit_file", args: { path: "src/session.js", old_string: FIX_OLD, new_string: FIX_GOOD } }] },
        { toolCalls: [{ name: "run_tests", args: {} }] },
        { content: "done" },
      ],
    }, { summary: () => "Summary: fixed isExpired; tests pass." });
    h = createHarness({ provider, workspace: project(), config, approve: () => "once" });
    // Pad the context so the checkpoint threshold is crossed.
    h.session.context.append({ role: "user", content: "x".repeat(24_000) });
    h.session.context.append({ role: "assistant", content: "ok" });
    const r = await h.session.runtime.runTurn("The session tests fail. Fix the bug.");
    expect(r.status).toBe("completed");
    const note = h.events.find((e) => e.type === "notice" && /Checkpoint: tests pass after edits/.test(e.message));
    expect(note).toBeDefined();
    expect(h.events.some((e) => e.type === "compaction")).toBe(true);
    expect(h.session.context.getSummary()).toContain("content hash");
  });
});

describe("economy experiment", () => {
  function economy() {
    const c = testConfig();
    c.quality.mode = "balanced";
    c.quality.economy = true;
    return c;
  }

  it("skips contract, review and judge when a fresh full run settles criteria from the failing baseline", async () => {
    const provider = new RoutedProvider(
      {
        main: [
          { toolCalls: [{ name: "read_file", args: { path: "src/session.js" } }] },
          { toolCalls: [{ name: "edit_file", args: { path: "src/session.js", old_string: FIX_OLD, new_string: FIX_GOOD } }] },
          { toolCalls: [{ name: "run_tests", args: {} }] },
          { content: "Fixed." },
        ],
      },
      aligned,
    );
    h = createHarness({ provider, workspace: project(), config: economy(), approve: () => "once" });
    const r = await h.session.runtime.runTurn("The session tests fail. Fix the bug.");
    const v = r.verification!;
    expect(v.overall).toBe("verified");
    expect(v.criteria.map((c) => c.text)).toEqual([
      'The previously failing tests pass: "a session that expires in an hour is not expired", "ensureFresh only refreshes expired sessions"',
      "The full test suite passes after the final edit (nothing else regresses)",
      "No test files are modified",
    ]);
    expect(v.economy).toMatchObject({ skipped: ["contract", "review", "judge"] });
    expect(provider.count("contract") + provider.count("judge") + provider.count("review-infer") + provider.count("review-compare")).toBe(0);
    expect(provider.count("verifier")).toBe(0);
    expect(v.auxCostUsd).toBe(0);
  });

  it("falls back to the normal gate when the checks don't settle it", async () => {
    const provider = new RoutedProvider(
      {
        main: [
          { toolCalls: [{ name: "read_file", args: { path: "src/session.js" } }] },
          { toolCalls: [{ name: "edit_file", args: { path: "src/session.js", old_string: FIX_OLD, new_string: FIX_GOOD } }] },
          { toolCalls: [{ name: "run_tests", args: { filter: "test/session.test.js" } }] }, // targeted, not the full suite
          { content: "Fixed." },
          { toolCalls: [{ name: "run_tests", args: {} }] },
          { content: "Fixed." },
        ],
        verifier: [{ content: '{"counterexamples": []}' }],
      },
      aligned,
    );
    h = createHarness({ provider, workspace: project(), config: economy(), approve: () => "once" });
    const r = await h.session.runtime.runTurn("The session tests fail. Fix the bug.");
    expect(provider.count("judge")).toBeGreaterThan(0);
    expect(r.verification!.economy?.skipped).toContain("contract");
  });

  it("uses the contract as usual when there is no failing baseline", async () => {
    const provider = new RoutedProvider({ main: [{ content: "Nothing to change." }] }, aligned);
    h = createHarness({ provider, workspace: project(), config: economy() });
    await h.session.runtime.runTurn("Add a helper that formats a session for logs");
    expect(provider.count("contract")).toBe(1);
  });
});

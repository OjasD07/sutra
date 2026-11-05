import { cpSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Message } from "../../src/providers/types.js";
import { HypothesisLedger } from "../../src/quality/ledger.js";
import { extractSignals } from "../../src/quality/localize.js";
import { runCandidates } from "../../src/quality/branches.js";
import { AuxModel, parseJsonLoose } from "../../src/quality/aux.js";
import { snapshotWorkspace } from "../../src/quality/snapshot.js";
import { createHarness, tempDir, testConfig, type Harness } from "../helpers/harness.js";
import { RoutedProvider, freshTestJudge, lastUser } from "../helpers/routed-provider.js";

const EXAMPLE = join(import.meta.dirname, "..", "..", "examples", "session-expiry");
const FIX_OLD = "return session.expiresAt < now;";
const FIX_GOOD = "return session.expiresAt * 1000 <= now;";
const FIX_STRICT = "return session.expiresAt * 1000 < now;"; // passes the suite, wrong at the boundary

function project(): string {
  const dir = tempDir("sutra-quality-");
  cpSync(EXAMPLE, dir, { recursive: true });
  return dir;
}

const users = (msgs: Message[]) => msgs.filter((m) => m.role === "user").map((m) => m.content as string);

const aligned = {
  contract: () => JSON.stringify({ kind: "bugfix", criteria: [{ text: "The session tests pass", needs_execution: true }, { text: "isExpired treats expiresAt as seconds", needs_execution: true }] }),
  judge: freshTestJudge,
  "review-infer": () => JSON.stringify({ inferred: "Makes isExpired compare expiresAt in seconds against now in milliseconds.", behaviour_changes: ["sessions are no longer always expired"] }),
  "review-compare": () => JSON.stringify({ verdict: "aligned", gaps: [] }),
};

let h: Harness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

function balanced() {
  const c = testConfig();
  c.quality.mode = "balanced";
  return c;
}

describe("evidence packet and baseline", () => {
  it("prepends a localization packet with a real baseline and the task contract", async () => {
    const provider = new RoutedProvider({ main: [{ content: "Nothing to do." }], verifier: [] }, aligned);
    h = createHarness({ provider, workspace: project(), config: balanced() });
    await h.session.runtime.runTurn("The session tests fail. Fix the bug in isExpired.");
    const first = users(h.session.context.messages())[0]!;
    expect(first).toMatch(/^The session tests fail\. Fix the bug in isExpired\.\n\n\[Sutra evidence packet/);
    expect(first).toMatch(/Baseline before any edit: `npm test` → exit 1, 2 of 4 failing: "a session that expires in an hour is not expired"/);
    expect(first).toContain("src/session.js");
    expect(first).toMatch(/`isExpired` defined at src\/session\.js:5/);
    expect(first).toContain("Acceptance criteria the harness will check at the end:\n- C1: The session tests pass");
    expect(h.events.some((e) => e.type === "quality" && e.stage === "baseline")).toBe(true);
  });

  it("does not run the baseline unattended when that would bypass approvals", async () => {
    const provider = new RoutedProvider({ main: [{ content: "ok" }] }, aligned);
    h = createHarness({ provider, workspace: project(), config: balanced(), sandbox: { mode: "off", runner: null } });
    await h.session.runtime.runTurn("Fix the failing session tests");
    const first = users(h.session.context.messages())[0]!;
    expect(first).toMatch(/Baseline: not run automatically \(running `npm test` needs your approval in this profile\)/);
  });

  it("extracts paths, stack frames, identifiers and quoted test names", () => {
    const s = extractSignals('TypeError in `refreshToken`: at handle (src/api/client.ts:42:7)\n  File "app/models.py", line 9\nthe test "renews tokens before expiry" fails; parse_config() too');
    expect(s.paths).toEqual([{ path: "src/api/client.ts", line: 42 }, { path: "app/models.py", line: 9 }]);
    expect(s.identifiers).toEqual(expect.arrayContaining(["refreshToken", "parse_config"]));
    expect(s.testNames).toContain("renews tokens before expiry");
  });
});

describe("finish gate", () => {
  it("sends unverified work back, then finishes verified with fresh evidence", async () => {
    const provider = new RoutedProvider(
      {
        main: [
          { toolCalls: [{ name: "read_file", args: { path: "src/session.js" } }] },
          { toolCalls: [{ name: "edit_file", args: { path: "src/session.js", old_string: FIX_OLD, new_string: FIX_GOOD } }] },
          { content: "Fixed." }, // claims success without running anything
          { toolCalls: [{ name: "run_tests", args: {} }] },
          { content: "Fixed; all 4 tests pass." },
        ],
        verifier: [{ content: '{"counterexamples": []}' }],
      },
      aligned,
    );
    h = createHarness({ provider, workspace: project(), config: balanced(), approve: () => "once" });
    const r = await h.session.runtime.runTurn("The session tests fail. Fix the bug.");
    const gate = users(h.session.context.messages()).find((u) => u.startsWith("[Sutra finish gate]"));
    expect(gate).toBeDefined();
    expect(gate).toMatch(/C1 "The session tests pass" — unverified/);
    expect(r.status).toBe("completed");
    const v = r.verification!;
    expect(v.overall).toBe("verified");
    expect(v.criteria.every((c) => c.status === "passed")).toBe(true);
    const cited = v.checks.find((c) => c.id === v.criteria[0]!.evidence[0]);
    expect(cited).toMatchObject({ kind: "test", passed: true });
    expect(v.review).toMatchObject({ verdict: "aligned" });
    expect(v.treeHash).toMatch(/^[0-9a-f]{12}$/);
    expect(v.bounces).toBe(1);
    // Harness calls are paid for and counted.
    expect(v.auxCostUsd).toBeGreaterThan(0);
    expect(provider.count("contract")).toBe(1);
    expect(provider.count("verifier")).toBe(1);
    // Persisted for the audit trail.
    expect(h.store.listVerifications(h.session.record.id)).toHaveLength(1);
  });

  it("keeps a well-covered fix cheap: no counterexample hunt when every criterion already has evidence", async () => {
    const provider = new RoutedProvider(
      {
        main: [
          { toolCalls: [{ name: "read_file", args: { path: "src/session.js" } }] },
          { toolCalls: [{ name: "edit_file", args: { path: "src/session.js", old_string: FIX_OLD, new_string: FIX_GOOD } }] },
          { toolCalls: [{ name: "run_tests", args: {} }] },
          { content: "Fixed." },
        ],
      },
      { ...aligned, contract: () => JSON.stringify({ kind: "bugfix", criteria: [{ text: "The session tests pass", needs_execution: true }, { text: "No test files are modified", needs_execution: true }] }) },
    );
    h = createHarness({ provider, workspace: project(), config: balanced(), approve: () => "once" });
    const r = await h.session.runtime.runTurn("The session tests fail. Fix the bug without changing the tests.");
    expect(provider.count("verifier")).toBe(0);
    expect(r.verification!.overall).toBe("verified");
    const diff = r.verification!.checks.find((c) => c.kind === "diff")!;
    expect(diff.summary).toBe("harness record: changed src/session.js; no test files changed");
  });

  it("never accepts a stale check, even when the judge cites one", async () => {
    const provider = new RoutedProvider(
      {
        main: [
          { toolCalls: [{ name: "run_tests", args: {} }] }, // fails, before the edit
          { toolCalls: [{ name: "read_file", args: { path: "src/session.js" } }] },
          { toolCalls: [{ name: "edit_file", args: { path: "src/session.js", old_string: FIX_OLD, new_string: FIX_GOOD } }] },
          { content: "Done." },
          { content: "I can't run the tests here." },
        ],
        verifier: [{ content: '{"counterexamples": []}' }],
      },
      {
        ...aligned,
        // A careless judge: claims everything passed, citing the pre-edit run.
        judge: (req) => {
          const ids = [...lastUser(req).matchAll(/^(C\d+):/gm)].map((m) => m[1]);
          return JSON.stringify({ criteria: ids.map((id) => ({ id, status: "passed", evidence: ["c2"] })) });
        },
      },
    );
    h = createHarness({ provider, workspace: project(), config: balanced(), approve: () => "once" });
    const r = await h.session.runtime.runTurn("The session tests fail. Fix the bug.");
    expect(r.status).toBe("completed");
    expect(r.verification!.overall).toBe("unverified");
    for (const c of r.verification!.criteria) expect(c).toMatchObject({ status: "unverified", note: "no passing check after the last edit supports it" });
  });

  it("fast mode labels evidence without any extra model calls", async () => {
    const provider = new RoutedProvider({
      main: [
        { toolCalls: [{ name: "read_file", args: { path: "src/session.js" } }] },
        { toolCalls: [{ name: "edit_file", args: { path: "src/session.js", old_string: FIX_OLD, new_string: FIX_GOOD } }] },
        { toolCalls: [{ name: "run_tests", args: {} }] },
        { content: "Fixed." },
      ],
    });
    h = createHarness({ provider, workspace: project(), approve: () => "once" }); // testConfig = fast
    const r = await h.session.runtime.runTurn("The session tests fail. Fix the bug.");
    expect(provider.requests.every((x) => x.role === "main")).toBe(true);
    expect(r.verification).toMatchObject({ mode: "fast", overall: "partial", auxCostUsd: 0 });
    expect(r.verification!.criteria.map((c) => [c.text, c.status])).toEqual([
      ["The requested change is implemented", "unverified"],
      ["The test suite passes after the final edit", "passed"],
    ]);
  });

  it("records nothing for plan-mode turns and for answers that change nothing", async () => {
    const provider = new RoutedProvider({ main: [{ content: "It is a session helper library." }] }, { contract: () => JSON.stringify({ kind: "question", criteria: [{ text: "Explain the repo", needs_execution: false }] }) });
    h = createHarness({ provider, workspace: project(), config: balanced() });
    const r = await h.session.runtime.runTurn("What does this repository do?");
    expect(r.verification).toBeUndefined();
  });
});

describe("counterexample verifier", () => {
  const boundaryTest = `import assert from "node:assert/strict";
import { test } from "node:test";
import { isExpired } from "../src/session.js";
test("a session expiring exactly now is expired", () => {
  const now = Date.UTC(2026, 0, 1);
  assert.equal(isExpired({ expiresAt: now / 1000 }, now), true);
});
`;
  const verifierFinds = [
    { toolCalls: [{ name: "write_file", args: { path: ".sutra-provisional/boundary.test.js", content: boundaryTest } }] },
    { toolCalls: [{ name: "execute_command", args: { command: "node --test .sutra-provisional/boundary.test.js" } }] },
    {
      content:
        'Found one. ```json\n{"counterexamples":[{"name":"expiry boundary","file":".sutra-provisional/boundary.test.js","command":"node --test .sutra-provisional/boundary.test.js","why":"expired means at or after expiresAt"}, {"name":"made up","file":".sutra-provisional/missing.test.js","command":"node --test .sutra-provisional/missing.test.js","why":"x"}]}\n```',
    },
  ];

  it("confirms failing provisional tests itself, feeds them back, and re-checks them later", async () => {
    const provider = new RoutedProvider(
      {
        main: [
          { toolCalls: [{ name: "read_file", args: { path: "src/session.js" } }] },
          { toolCalls: [{ name: "edit_file", args: { path: "src/session.js", old_string: FIX_OLD, new_string: FIX_STRICT } }] },
          { toolCalls: [{ name: "run_tests", args: {} }] }, // the project suite passes
          { content: "Fixed." },
          (req) => {
            expect(lastUser(req)).toMatch(/^\[Sutra verifier\]/);
            return { toolCalls: [{ name: "edit_file", args: { path: "src/session.js", old_string: FIX_STRICT, new_string: FIX_GOOD } }] };
          },
          { toolCalls: [{ name: "run_tests", args: {} }] },
          { content: "Fixed the boundary too." },
        ],
        verifier: verifierFinds,
      },
      {
        ...aligned,
        // The project's suite doesn't test the boundary, so that criterion stays open
        // until a (provisional) probe covers it — which is what makes the hunt worth running.
        contract: () => JSON.stringify({ kind: "bugfix", criteria: [{ text: "The session tests pass", needs_execution: true }, { text: "A session is expired once its expiry time is reached", needs_execution: true }] }),
        judge: (req) => {
          const u = lastUser(req);
          const test = [...u.matchAll(/^(c\d+) \[test, after last edit\] PASSED/gm)].at(-1)?.[1];
          const probe = [...u.matchAll(/^(c\d+) \[counterexample, provisional, after last edit\] PASSED/gm)].at(-1)?.[1];
          return JSON.stringify({ criteria: [
            { id: "C1", status: test ? "passed" : "unverified", evidence: test ? [test] : [] },
            { id: "C2", status: probe ? "passed" : "unverified", evidence: probe ? [probe] : [] },
          ] });
        },
      },
    );
    h = createHarness({ provider, workspace: project(), config: balanced(), approve: () => "once" });
    const r = await h.session.runtime.runTurn("The session tests fail. Fix the bug. A session is expired once its expiry time is reached.");
    const msg = users(h.session.context.messages()).find((u) => u.startsWith("[Sutra verifier]"))!;
    expect(msg).toContain('"expiry boundary"');
    expect(msg).toContain("generated, not authoritative");
    expect(msg).not.toContain("made up"); // claimed but missing: dropped
    const v = r.verification!;
    expect(v.counterexamples).toHaveLength(1);
    expect(v.counterexamples[0]).toMatchObject({ name: "expiry boundary", failing: false }); // fixed by the second edit
    expect(v.checks.some((c) => c.kind === "counterexample" && c.provisional && c.passed)).toBe(true);
    expect(v.criteria[1]).toMatchObject({ status: "passed", note: "supported only by provisional tests" });
    expect(readFileSync(join(h.workspace, "src/session.js"), "utf8")).toContain(FIX_GOOD);
    // The verifier never wrote into the user's workspace.
    expect(() => readFileSync(join(h!.workspace, ".sutra-provisional/boundary.test.js"))).toThrow();
  }, 60_000);

  it("skips sub-agents when nothing would contain their commands", async () => {
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
    h = createHarness({ provider, workspace: project(), config: balanced(), approve: () => "once", sandbox: { mode: "off", runner: null } });
    const r = await h.session.runtime.runTurn("Fix the failing session tests");
    expect(provider.count("verifier")).toBe(0);
    expect(h.events.some((e) => e.type === "quality" && /counterexample search skipped: needs the OS sandbox or the flow profile/.test(e.message))).toBe(true);
    expect(r.verification!.overall).toBe("verified");
  });
});

describe("hypothesis ledger and stall detection", () => {
  it("keeps at most three open hypotheses", () => {
    const l = new HypothesisLedger();
    l.add({ claim: "units" });
    l.add({ claim: "boundary" });
    l.add({ claim: "timezone" });
    expect(() => l.add({ claim: "fourth" })).toThrow(/At most 3/);
    l.update("H2", { status: "rejected", contradicts: "boundary test passes" });
    expect(l.add({ claim: "fourth" }).id).toBe("H4");
    expect(l.render()).toContain("✗ H2 boundary");
  });

  it("the hypotheses tool reads and writes the session ledger", async () => {
    const provider = new RoutedProvider({
      main: [
        { toolCalls: [{ name: "hypotheses", args: { action: "add", claim: "expiresAt is in seconds", location: "src/session.js:6", next_check: "log expiresAt" } }] },
        { toolCalls: [{ name: "hypotheses", args: { action: "update", id: "H1", status: "confirmed" } }] },
        { content: "ok" },
      ],
    });
    h = createHarness({ provider, workspace: project() });
    await h.session.runtime.runTurn("why do sessions expire immediately?");
    expect(h.session.ledger.list()).toEqual([expect.objectContaining({ id: "H1", status: "confirmed", location: "src/session.js:6" })]);
  });

  it("notices the same failure after an edit and asks for a distinguishing check", async () => {
    const provider = new RoutedProvider({
      main: [
        { toolCalls: [{ name: "run_tests", args: {} }] },
        { toolCalls: [{ name: "read_file", args: { path: "src/session.js" } }] },
        { toolCalls: [{ name: "edit_file", args: { path: "src/session.js", old_string: "Session helpers.", new_string: "Session helpers (edited)." } }] },
        { toolCalls: [{ name: "run_tests", args: {} }] },
        (req) => {
          expect(lastUser(req)).toMatch(/^\[Sutra: the same tests are still failing after your last edit/);
          return { content: "I'll step back." };
        },
      ],
    });
    h = createHarness({ provider, workspace: project(), approve: () => "once" });
    await h.session.runtime.runTurn("Fix the failing tests");
    expect(h.events.some((e) => e.type === "quality" && e.stage === "stall")).toBe(true);
  });
});

describe("competing patches", () => {
  it("tries distinct hypotheses from the initial snapshot and selects by deterministic gates", async () => {
    const root = project();
    const initial = snapshotWorkspace(root);
    // The failed main attempt left a wrong edit in the user's workspace.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(root, "src/session.js"), readFileSync(join(root, "src/session.js"), "utf8").replace(FIX_OLD, "return false;"));
    const provider = new RoutedProvider(
      {
        candidate: [
          // A: weakens the tests instead of fixing the code.
          { toolCalls: [{ name: "read_file", args: { path: "test/session.test.js" } }] },
          { toolCalls: [{ name: "write_file", args: { path: "test/session.test.js", content: "import { test } from 'node:test';\ntest('ok', () => {});\n" } }] },
          { content: "Tests pass now." },
          // B: the real fix.
          { toolCalls: [{ name: "read_file", args: { path: "src/session.js" } }] },
          { toolCalls: [{ name: "edit_file", args: { path: "src/session.js", old_string: FIX_OLD, new_string: FIX_GOOD } }] },
          { toolCalls: [{ name: "run_tests", args: {} }] },
          { content: "Fixed the unit mismatch." },
        ],
      },
      { propose: () => JSON.stringify({ hypotheses: ["the tests are wrong", "expiresAt is seconds, now is milliseconds"] }) },
    );
    const config = testConfig();
    config.tools.testCommand = "npm test";
    const aux = new AuxModel({ provider, model: () => "deepseek-flash", recordUsage: () => 0 }, 1);
    const out = await runCandidates(
      { config, provider, model: "deepseek-flash", store: null, sandbox: null, aux },
      { initial, workspaceRoot: root, request: "Fix the failing session tests", packet: null, lessons: "Returned false always; 2 tests still fail.", hypotheses: [], count: 2, verifyCommand: "npm test", bank: [], mainChanged: ["src/session.js"], maxCostUsd: 1 },
    );
    initial.cleanup();
    const [a, b] = out.results;
    expect(a).toMatchObject({ label: "A", testsWeakened: true, selected: false });
    expect(a!.reason).toMatch(/rejected: modified existing tests/);
    expect(b).toMatchObject({ label: "B", passed: true, testsWeakened: false, selected: true });
    // The patch replaces the failed attempt's edit with the candidate's fix.
    expect(out.patch).toContain("-  return false;");
    expect(out.patch).toContain(`+  ${FIX_GOOD}`);
    expect(out.patch).not.toContain("test/session.test.js");
  }, 60_000);
});

describe("aux JSON parsing", () => {
  it("tolerates fences and prose", () => {
    expect(parseJsonLoose<{ a: number }>('Sure!\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoose('prefix {"a": 2} suffix')).toEqual({ a: 2 });
    expect(parseJsonLoose("no json")).toBeNull();
  });
});

describe("deep mode end to end", () => {
  it("falls back to competing patches after the bounces, and the agent applies the winner with approval", async () => {
    const wrong = "return false;";
    const provider = new RoutedProvider(
      {
        main: [
          { toolCalls: [{ name: "read_file", args: { path: "src/session.js" } }] },
          { toolCalls: [{ name: "edit_file", args: { path: "src/session.js", old_string: FIX_OLD, new_string: wrong } }] },
          { toolCalls: [{ name: "run_tests", args: {} }] }, // still failing
          { content: "Fixed." },
          { content: "I believe it's fixed." }, // after bounce 1
          { content: "Still fixed, I think." }, // after bounce 2
          (req) => {
            const msg = lastUser(req);
            expect(msg).toMatch(/^\[Sutra competing patches\]/);
            const patch = msg.match(/```diff\n([\s\S]*?)```/)![1]!;
            return { toolCalls: [{ name: "apply_patch", args: { patch } }] };
          },
          { toolCalls: [{ name: "run_tests", args: {} }] },
          { content: "Applied candidate B; the cause was seconds vs milliseconds." },
        ],
        verifier: [{ content: '{"counterexamples": []}' }, { content: '{"counterexamples": []}' }],
        candidate: [
          { content: "This explanation does not hold; no change." }, // A
          { toolCalls: [{ name: "read_file", args: { path: "src/session.js" } }] }, // B
          { toolCalls: [{ name: "edit_file", args: { path: "src/session.js", old_string: FIX_OLD, new_string: FIX_GOOD } }] },
          { toolCalls: [{ name: "run_tests", args: {} }] },
          { content: "Fixed." },
        ],
      },
      { ...aligned, propose: () => JSON.stringify({ hypotheses: ["a timezone problem", "expiresAt is seconds, now is milliseconds"] }) },
    );
    const config = testConfig();
    config.quality.mode = "deep";
    h = createHarness({ provider, workspace: project(), config, approve: () => "once" });
    const r = await h.session.runtime.runTurn("The session tests fail. Fix the bug.");
    const v = r.verification!;
    expect(v.bounces).toBe(2);
    expect(v.candidates.map((c) => [c.label, c.selected])).toEqual([["A", false], ["B", true]]);
    expect(v.overall).toBe("verified");
    expect(readFileSync(join(h.workspace, "src/session.js"), "utf8")).toContain(FIX_GOOD);
    // The patch reached the user's files through the normal, approval-gated tool.
    expect(h.approvals.some((a) => a.tool === "apply_patch")).toBe(true);
    expect(h.store.listSessions().filter((s) => s.title?.startsWith("candidate"))).toHaveLength(2);
  }, 120_000);
});

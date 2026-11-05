import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ContextCompiler } from "../../src/context/compiler.js";
import { parseTestReport } from "../../src/context/test-report.js";
import type { ToolResult } from "../../src/tools/types.js";

const RUN = readFileSync(join(__dirname, "../fixtures/node-test-2-failing.txt"), "utf8");
const header = "$ npm test\ncwd: .\nexit code 1; duration 0.40s\n--- stdout ---\n";

function testCall(c: ContextCompiler, id: string, out: string, exitCode = 1) {
  const result: ToolResult = { ok: true, output: header + out, data: { command: "npm test", exitCode } };
  return c.compile({ callId: id, name: "run_tests", category: "execute", result, content: header + out, truncated: false });
}

function readCall(c: ContextCompiler, id: string, hash: string, from = 1, to = 40) {
  const content = Array.from({ length: to - from + 1 }, (_, i) => `${from + i}\tline ${from + i}`).join("\n");
  const result: ToolResult = { ok: true, output: content, data: { path: "src/a.ts", hash, from, to, lines: 40 } };
  return c.compile({ callId: id, name: "read_file", category: "read", result, content, truncated: false });
}

describe("test report parser", () => {
  it("isolates each node:test failure with its exact assertion and workspace frames", () => {
    const r = parseTestReport(RUN, "/repo");
    expect(r.complete).toBe(true);
    expect(r.counts).toEqual({ passed: 2, failed: 2, total: 4 });
    expect(r.failures.map((f) => f.name)).toEqual(["a session that expires in an hour is not expired", "ensureFresh only refreshes expired sessions"]);
    expect(r.failures[0]!.text).toContain("true !== false");
    expect(r.failures[0]!.frames).toEqual(["test/session.test.js:9:10"]);
    expect(r.failures[1]!.text).toContain("refreshToken: 'r2'");
  });

  it("is incomplete when failures exist but can't be isolated", () => {
    const r = parseTestReport("✖ something broke (1ms)\nℹ tests 1\nℹ pass 0\nℹ fail 1\n", "/repo");
    expect(r.complete).toBe(false);
  });
});

describe("context compiler", () => {
  it("sends the first run in full and an identical second run as a delta", () => {
    const c = new ContextCompiler("/repo");
    expect(testCall(c, "c1", RUN)).toBe(header + RUN);
    c.advance();
    const second = testCall(c, "c2", RUN);
    expect(second).toContain("Unchanged failures (2), identical assertion and stack to call c1");
    expect(second).toContain('get_output {"call_id":"c2"}');
    expect(second).toContain("2 passing (unchanged)");
    expect(second.length).toBeLessThan(RUN.length / 2);
    expect(c.output("c2")).toBe(header + RUN);
  });

  it("shows a changed failure in full and names fixed tests", () => {
    const c = new ContextCompiler("/repo");
    testCall(c, "c1", RUN);
    const changed = RUN.replace("true !== false", "1 !== 2")
      .replace(/✖ ensureFresh only refreshes expired sessions \([\d.]+ms\)/g, "✔ ensureFresh only refreshes expired sessions (1ms)")
      .replace(/test at test\/session.test.js:20:1[\s\S]*$/, "")
      .replace("ℹ pass 2", "ℹ pass 3")
      .replace("ℹ fail 2", "ℹ fail 1");
    const out = testCall(c, "c2", changed);
    expect(out).toContain('Changed failure "a session that expires in an hour is not expired"');
    expect(out).toContain("1 !== 2");
    expect(out).toContain('Now passing (failed in call c1): "ensureFresh only refreshes expired sessions"');
    expect(out).toContain("(was 2)");
  });

  it("points unchanged failures at the call that last showed them, not at a delta", () => {
    const c = new ContextCompiler("/repo");
    testCall(c, "c1", RUN);
    testCall(c, "c2", RUN);
    expect(testCall(c, "c3", RUN)).toContain("identical assertion and stack to call c1");
  });

  it("falls back to the full output when the run can't be parsed", () => {
    const c = new ContextCompiler("/repo");
    testCall(c, "c1", RUN);
    const crash = "SyntaxError: Unexpected token\n    at src/x.js:3\n";
    expect(testCall(c, "c2", crash)).toBe(header + crash);
  });

  it("skips an identical re-run when nothing changed, and not after a change", () => {
    const c = new ContextCompiler("/repo");
    testCall(c, "c1", RUN);
    const skip = c.preempt("run_tests", "npm test", false);
    expect(skip?.output).toContain("nothing changed since the identical run in call c1");
    expect(c.preempt("run_tests", "npm test", true)).toBeNull();
    expect(c.preempt("run_tests", "npm test -- x", false)).toBeNull();
    c.compile({ callId: "c2", name: "execute_command", category: "execute", result: { ok: true, output: "ok", data: { command: "touch x", exitCode: 0 } }, content: "ok", truncated: false });
    expect(c.preempt("run_tests", "npm test", false)).toBeNull();
  });

  it("replaces an unchanged re-read with a pointer, but not after the content changes", () => {
    const c = new ContextCompiler("/repo");
    expect(readCall(c, "r1", "h1")).toContain("1\tline 1");
    expect(readCall(c, "r2", "h1", 5, 10)).toContain("unchanged (same content hash h1) since your read in call r1");
    expect(readCall(c, "r3", "h2")).toContain("1\tline 1");
    expect(c.stats.readsDeduped).toBe(1);
  });

  it("marks earlier reads stale after an edit and forgets them", () => {
    const c = new ContextCompiler("/repo");
    readCall(c, "r1", "h1");
    const w = c.compile({ callId: "w1", name: "edit_file", category: "write", result: { ok: true, output: "Edited src/a.ts", data: { files: ["src/a.ts"] } }, content: "Edited src/a.ts", truncated: false });
    expect(w).toContain("earlier reads of src/a.ts (r1) are now out of date");
    expect(readCall(c, "r2", "h1")).toContain("1\tline 1");
  });

  it("forgets everything it could point at after compaction", () => {
    const c = new ContextCompiler("/repo");
    readCall(c, "r1", "h1");
    testCall(c, "c1", RUN);
    c.reset();
    expect(readCall(c, "r2", "h1")).toContain("1\tline 1");
    expect(testCall(c, "c2", RUN)).toBe(header + RUN);
  });

  it("does nothing when disabled, but still keeps full outputs", () => {
    const c = new ContextCompiler("/repo", false);
    testCall(c, "c1", RUN);
    expect(testCall(c, "c2", RUN)).toBe(header + RUN);
    expect(c.preempt("run_tests", "npm test", false)).toBeNull();
    expect(c.output("c1")).toBeDefined();
  });
});

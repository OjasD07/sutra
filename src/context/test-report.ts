import { parseFailingTests, parseTestCounts, type TestCounts } from "../tools/shell/test-counts.js";

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

export interface FailureBlock {
  name: string;
  /** Exact assertion / error text, normalised only for volatile bits (durations, absolute paths). */
  text: string;
  /** Stack frames inside the workspace, as relative path:line[:col]. */
  frames: string[];
}

export interface TestReport {
  counts: TestCounts | null;
  failures: FailureBlock[];
  /** False when failing tests were detected but their details couldn't be isolated. */
  complete: boolean;
}

function normalise(block: string, root: string): string {
  const esc = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return block
    .replace(new RegExp(`file://${esc}/`, "g"), "")
    .replace(new RegExp(`${esc}/`, "g"), "")
    .replace(/\(\d+(\.\d+)?m?s\)/g, "")
    .replace(/\s+$/gm, "")
    .trim();
}

function framesOf(block: string): string[] {
  const out: string[] = [];
  for (const m of block.matchAll(/(?:\(|\s)((?!node:)(?!internal\/)[\w./@-]+\.(?:m?[jt]sx?|cjs|py|go|rs|rb|java|kt)):(\d+)(?::(\d+))?\)?/g)) {
    if (m[1]!.includes("node_modules")) continue;
    const f = `${m[1]}:${m[2]}${m[3] ? `:${m[3]}` : ""}`;
    if (!out.includes(f)) out.push(f);
  }
  return out;
}

/** node:test spec reporter: details live in the "✖ failing tests:" section. */
function nodeBlocks(out: string): Map<string, string> {
  const blocks = new Map<string, string>();
  const at = out.indexOf("✖ failing tests:");
  if (at === -1) return blocks;
  for (const chunk of out.slice(at).split(/\n(?=test at )/).slice(1)) {
    const lines = chunk.split("\n");
    const head = lines.findIndex((l) => /^✖ /.test(l));
    if (head === -1) continue;
    const name = lines[head]!.replace(/^✖ /, "").replace(/ \([\d.]+m?s\)$/, "").trim();
    blocks.set(name, lines.slice(head + 1).join("\n"));
  }
  return blocks;
}

/** node:test TAP: "not ok N - name" followed by an indented YAML block. */
function tapBlocks(out: string): Map<string, string> {
  const blocks = new Map<string, string>();
  const re = /^\s*not ok \d+ - (.+?)(?:\s+#.*)?$\n((?:^\s{2,}.*$\n?)*)/gm;
  for (const m of out.matchAll(re)) blocks.set(m[1]!.trim(), m[2] ?? "");
  return blocks;
}

/** vitest / jest: "FAIL path > name" or "● Suite › name" headers, then the error until the next header. */
function headerBlocks(out: string): Map<string, string> {
  const blocks = new Map<string, string>();
  const lines = out.split("\n");
  let name: string | null = null;
  let body: string[] = [];
  const flush = () => {
    if (name && !blocks.has(name)) blocks.set(name, body.join("\n"));
    name = null;
    body = [];
  };
  for (const l of lines) {
    const v = l.match(/^\s*FAIL\s+\S+\s+>\s+(.+)$/) ?? l.match(/^\s*● (.+? › .+)$/);
    if (v) {
      flush();
      name = v[1]!.trim();
      continue;
    }
    if (name && (/^⎯{3,}/.test(l.trim()) || /^\s*(Test Files|Tests:|Test Suites:)/.test(l))) {
      flush();
      continue;
    }
    if (name) body.push(l);
  }
  flush();
  return blocks;
}

/** pytest: "____ test_name ____" sections. */
function pytestBlocks(out: string): Map<string, string> {
  const blocks = new Map<string, string>();
  const re = /^_{3,} (\S.*?) _{3,}$\n([\s\S]*?)(?=^_{3,} |^=+ )/gm;
  for (const m of out.matchAll(re)) blocks.set(m[1]!.trim(), m[2] ?? "");
  return blocks;
}

/** Parse a test run into counts plus per-failure assertion blocks. */
export function parseTestReport(raw: string, root: string): TestReport {
  const out = raw.replace(ANSI, "");
  const counts = parseTestCounts(out);
  const names = parseFailingTests(out, 100);
  const sources = [nodeBlocks(out), tapBlocks(out), headerBlocks(out), pytestBlocks(out)];
  const failures: FailureBlock[] = [];
  for (const name of names) {
    let block: string | undefined;
    for (const s of sources) {
      block = s.get(name) ?? [...s.entries()].find(([k]) => k.endsWith(name) || name.endsWith(k))?.[1];
      if (block !== undefined) break;
    }
    if (block === undefined) continue;
    const text = normalise(block, root);
    failures.push({ name, text, frames: framesOf(text) });
  }
  const failedCount = counts?.failed ?? names.length;
  return { counts, failures, complete: failures.length === names.length && (failedCount === 0 || failures.length >= Math.min(failedCount, names.length)) && (names.length > 0 || failedCount === 0) };
}

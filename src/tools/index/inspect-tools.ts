import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { RepoIndex } from "../../index/repo-index.js";
import type { CodeSymbol } from "../../index/symbols.js";
import { fail, ok, type Tool, type ToolContext } from "../types.js";

export function isTestPath(path: string): boolean {
  return /(^|\/)(tests?|__tests__|spec|specs)\//i.test(path) || /\.(test|spec)\.[a-z]+$/i.test(path) || /(^|\/)test_[^/]+\.py$/.test(path) || /_test\.(go|py)$/.test(path);
}

const INDENT_LANGS = /\.(py|rb|nim|yaml|yml)$/;

/**
 * Where a definition ends, found from its text: matching braces for C-like
 * languages, indentation for Python-like ones. Bounded by `max` lines.
 */
export function definitionEnd(lines: string[], start: number, max: number, path: string): { end: number; complete: boolean } {
  const limit = Math.min(lines.length, start + max);
  const indentOf = (l: string) => l.length - l.trimStart().length;
  const base = indentOf(lines[start] ?? "");
  if (INDENT_LANGS.test(path)) {
    let end = start;
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i]!;
      if (l.trim() && indentOf(l) <= base) return { end, complete: true };
      if (i >= limit) return { end, complete: false };
      if (l.trim()) end = i;
    }
    return { end, complete: true };
  }
  let depth = 0;
  let opened = false;
  for (let i = start; i < lines.length; i++) {
    if (i >= limit) return { end: limit - 1, complete: false };
    // Strip strings and line comments so braces inside them don't count.
    const code = lines[i]!.replace(/\/\/.*$/, "").replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "");
    for (const ch of code) {
      if (ch === "{") {
        depth++;
        opened = true;
      } else if (ch === "}") depth--;
    }
    if (opened && depth <= 0) return { end: i, complete: true };
    if (!opened && i - start >= 8) break;
    if (!opened && /;\s*$/.test(code) && depth === 0) return { end: i, complete: true };
  }
  // No braces: an expression-bodied definition. Stop at the next line at or below its indent.
  for (let i = start + 1; i < limit; i++) if (lines[i]!.trim() && indentOf(lines[i]!) <= base) return { end: i - 1, complete: true };
  return { end: limit - 1, complete: false };
}

/** The definition whose body really contains `line` (the index only knows where definitions start). */
export function enclosingDefinition(index: RepoIndex, root: string, file: string, line: number, lines?: string[]): CodeSymbol | undefined {
  const f = index.get(file);
  if (!f) return undefined;
  let text = lines;
  if (!text) {
    try {
      text = readFileSync(join(root, file), "utf8").split("\n");
    } catch {
      return undefined;
    }
  }
  const candidates = f.symbols.filter((s) => s.line <= line).sort((a, b) => b.line - a.line);
  for (const s of candidates) if (definitionEnd(text, s.line - 1, 2000, file).end + 1 >= line) return s;
  return undefined;
}

function numbered(lines: string[], from: number, to: number): string {
  const width = String(to + 1).length;
  return lines
    .slice(from, to + 1)
    .map((l, i) => `${String(from + i + 1).padStart(width)}\t${l}`)
    .join("\n");
}

function wordRe(name: string): RegExp {
  return new RegExp(`(^|[^\\w$])${name.replace(/[$]/g, "\\$")}([^\\w$]|$)`);
}

interface Usage {
  file: string;
  line: number;
  text: string;
  within?: CodeSymbol;
}

function usages(index: RepoIndex, root: string, name: string, skip: Set<string>, limit: number): Usage[] {
  const re = wordRe(name);
  const out: Usage[] = [];
  for (const f of index.filesReferencing(name)) {
    let lines: string[];
    try {
      lines = readFileSync(join(root, f), "utf8").split("\n");
    } catch {
      continue;
    }
    for (let i = 0; i < lines.length && out.length < limit; i++) {
      if (!re.test(lines[i]!) || skip.has(`${f}:${i + 1}`)) continue;
      const within = enclosingDefinition(index, root, f, i + 1, lines);
      out.push({ file: f, line: i + 1, text: lines[i]!.trim().slice(0, 140), ...(within ? { within } : {}) });
    }
    if (out.length >= limit) break;
  }
  return out;
}

export const inspectSymbolTool: Tool<{ name: string; body_lines?: number }> = {
  name: "inspect_symbol",
  description:
    "Everything needed to work on one function, class or method in a single call: its definition with the exact body (line-numbered like read_file, bounded), the callers with the function each call sits in, and the tests that mention it. The file counts as read, so you can edit it directly. Accepts `name` or `Class.method`.",
  version: "1.0.0",
  category: "read",
  readOnly: true,
  schema: z.object({
    name: z.string().min(1).max(200).regex(/^[A-Za-z_$][\w$]*(\.[A-Za-z_$#][\w$]*)?$/, "a symbol name such as parseConfig or Session.refresh"),
    body_lines: z.number().int().min(5).max(400).optional().describe("Max body lines per definition (default 80)"),
  }),
  describe: (a, ctx) => ({ tool: "inspect_symbol", category: "read", paths: [ctx.workspace.resolve(".")], summary: `Inspect ${a.name}` }),
  async execute(a, ctx: ToolContext) {
    const svc = ctx.repoIndex;
    if (!svc) return fail("execution_failed", "The repository index is disabled (index.enabled: false). Use grep_search and read_file instead.");
    svc.refresh();
    const defs = svc.index.findDefinitions(a.name);
    if (!defs.length) return fail("not_found", `No definition of ${a.name} in ${svc.index.stats.files} indexed files. Try code_search with a description, or grep_search.`);
    const max = a.body_lines ?? 80;
    const out: string[] = [];
    const defLines = new Set<string>();
    const shown = defs.slice(0, 3);
    for (const d of defs) defLines.add(`${d.file.path}:${d.symbol.line}`);
    for (const d of shown) {
      const abs = ctx.workspace.resolve(d.file.path).absolute;
      const buf = readFileSync(abs);
      const lines = buf.toString("utf8").split("\n");
      // The whole file was read from disk, so edits to it are as safe as after read_file.
      ctx.fileState.record(abs, buf);
      const start = d.symbol.line - 1;
      const { end, complete } = definitionEnd(lines, start, max, d.file.path);
      out.push(
        `## ${d.symbol.kind} ${d.symbol.parent ? `${d.symbol.parent}.` : ""}${d.symbol.name} — ${d.file.path}:${d.symbol.line}-${end + 1}`,
        numbered(lines, start, end),
      );
      if (!complete) out.push(`[body continues past line ${end + 1}; read_file {"path":"${d.file.path}","offset":${end + 2}} for the rest]`);
    }
    if (defs.length > shown.length) out.push(`Other definitions: ${defs.slice(shown.length).map((d) => `${d.file.path}:${d.symbol.line}`).join(", ")}`);

    const member = a.name.split(".").pop()!;
    const all = usages(svc.index, ctx.workspace.root, member, defLines, 60);
    const callers = all.filter((u) => !isTestPath(u.file));
    const tests = all.filter((u) => isTestPath(u.file));
    out.push("", `## Callers (${callers.length}${callers.length >= 30 ? "+" : ""})`);
    if (!callers.length) out.push("  (none found outside tests)");
    for (const u of callers.slice(0, 30)) out.push(`  ${u.file}:${u.line}${u.within ? `  in ${u.within.parent ? `${u.within.parent}.` : ""}${u.within.name}` : ""}  ${u.text}`);
    out.push("", `## Tests (${new Set(tests.map((t) => t.file)).size} file(s))`);
    if (!tests.length) out.push("  (no test mentions it by name)");
    for (const u of tests.slice(0, 20)) out.push(`  ${u.file}:${u.line}${u.within ? `  in ${u.within.name}` : ""}  ${u.text}`);
    out.push("", "Symbol extraction is pattern-based: check the body boundaries above before editing near them.");
    return ok(out.join("\n"), { definitions: defs.length, callers: callers.length, tests: tests.length, paths: shown.map((d) => d.file.path) });
  },
};

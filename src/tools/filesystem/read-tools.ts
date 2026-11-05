import { readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { glob } from "tinyglobby";
import { z } from "zod";
import { hasRipgrep, runProcess } from "../../utils/process.js";
import { isProbablyBinary } from "../../utils/text.js";
import { ALWAYS_IGNORED, loadIgnore, walkFiles } from "../../utils/walk.js";
import { fail, ok, type Tool } from "../types.js";

const MAX_READ_BYTES = 2_000_000;
const DEFAULT_LINES = 2000;
const MAX_LINE_CHARS = 2000;

export const readFileTool: Tool<{ path: string; offset?: number; limit?: number }> = {
  name: "read_file",
  description:
    "Read a text file from the workspace. Output lines are prefixed with their 1-based line number and a tab; the prefix is not part of the file. Use offset/limit for large files.",
  version: "1.0.0",
  category: "read",
  readOnly: true,
  schema: z.object({
    path: z.string().describe("File path, relative to the workspace root"),
    offset: z.number().int().min(1).optional().describe("1-based line to start from"),
    limit: z.number().int().min(1).max(5000).optional().describe(`Max lines to return (default ${DEFAULT_LINES})`),
  }),
  describe: (a, ctx) => ({ tool: "read_file", category: "read", paths: [ctx.workspace.resolve(a.path)], summary: `Read ${a.path}` }),
  async execute(a, ctx) {
    const p = ctx.workspace.resolve(a.path);
    let st;
    try {
      st = statSync(p.absolute);
    } catch {
      return fail("not_found", `No such file: ${p.display}`);
    }
    if (st.isDirectory()) return fail("invalid_arguments", `${p.display} is a directory; use list_directory`);
    if (st.size > MAX_READ_BYTES && !a.limit) return fail("invalid_arguments", `${p.display} is ${st.size} bytes; pass offset/limit to read part of it`);
    const buf = readFileSync(p.absolute);
    if (isProbablyBinary(buf)) return fail("invalid_arguments", `${p.display} looks like a binary file (${st.size} bytes)`);
    ctx.fileState.record(p.absolute, buf);
    const lines = buf.toString("utf8").split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    const start = (a.offset ?? 1) - 1;
    const end = Math.min(lines.length, start + (a.limit ?? DEFAULT_LINES));
    if (start >= lines.length && lines.length > 0) return fail("invalid_arguments", `offset ${a.offset} is past the end of the file (${lines.length} lines)`);
    const width = String(end).length;
    const body = lines
      .slice(start, end)
      .map((l, i) => `${String(start + i + 1).padStart(width)}\t${l.length > MAX_LINE_CHARS ? l.slice(0, MAX_LINE_CHARS) + "… [line truncated]" : l}`)
      .join("\n");
    const more = end < lines.length ? `\n[showing lines ${start + 1}-${end} of ${lines.length}; use offset to read more]` : "";
    return ok(lines.length === 0 ? "[empty file]" : body + more, { path: p.display, lines: lines.length, from: start + 1, to: end });
  },
};

export const listDirectoryTool: Tool<{ path?: string; depth?: number }> = {
  name: "list_directory",
  description: "List files and directories. Directories end with '/'. Ignored directories (node_modules, .git, build output) are shown but not expanded.",
  version: "1.0.0",
  category: "read",
  readOnly: true,
  schema: z.object({
    path: z.string().optional().describe("Directory, relative to the workspace root (default '.')"),
    depth: z.number().int().min(1).max(4).optional().describe("Recursion depth (default 1)"),
  }),
  describe: (a, ctx) => ({ tool: "list_directory", category: "read", paths: [ctx.workspace.resolve(a.path ?? ".")], summary: `List ${a.path ?? "."}` }),
  async execute(a, ctx) {
    const p = ctx.workspace.resolve(a.path ?? ".");
    const depth = a.depth ?? 1;
    const ig = loadIgnore(ctx.workspace.root);
    const out: string[] = [];
    const LIMIT = 1000;
    const visit = async (dir: string, level: number): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (err) {
        if (level === 0) throw err;
        return;
      }
      entries.sort((x, y) => Number(y.isDirectory()) - Number(x.isDirectory()) || x.name.localeCompare(y.name));
      for (const e of entries) {
        if (out.length >= LIMIT) return;
        const abs = join(dir, e.name);
        const rel = relative(ctx.workspace.root, abs).split("\\").join("/");
        const indent = "  ".repeat(level);
        if (e.isDirectory()) {
          const skipped = ALWAYS_IGNORED.includes(e.name) || (p.insideWorkspace && ig.ignores(rel + "/"));
          out.push(`${indent}${e.name}/${skipped ? "  (ignored)" : ""}`);
          if (!skipped && level + 1 < depth) await visit(abs, level + 1);
        } else {
          out.push(`${indent}${e.name}${e.isSymbolicLink() ? " -> (symlink)" : ""}`);
        }
      }
    };
    try {
      await visit(p.absolute, 0);
    } catch {
      return fail("not_found", `Cannot list ${p.display}`);
    }
    if (out.length >= LIMIT) out.push(`[truncated at ${LIMIT} entries]`);
    return ok(out.join("\n") || "[empty directory]", { path: p.display, entries: out.length });
  },
};

export const globFilesTool: Tool<{ pattern: string; path?: string }> = {
  name: "glob_files",
  description: "Find files by glob pattern (e.g. 'src/**/*.ts'). Respects .gitignore. Returns workspace-relative paths, sorted.",
  version: "1.0.0",
  category: "read",
  readOnly: true,
  schema: z.object({ pattern: z.string().min(1), path: z.string().optional().describe("Base directory (default workspace root)") }),
  describe: (a, ctx) => ({ tool: "glob_files", category: "read", paths: [ctx.workspace.resolve(a.path ?? ".")], summary: `Glob ${a.pattern}` }),
  async execute(a, ctx) {
    const base = ctx.workspace.resolve(a.path ?? ".");
    if (a.pattern.includes("..")) return fail("invalid_arguments", "Glob patterns may not contain '..'");
    const ig = loadIgnore(ctx.workspace.root);
    const matches = await glob(a.pattern, {
      cwd: base.absolute,
      ignore: ALWAYS_IGNORED.map((d) => `**/${d}/**`),
      dot: true,
      onlyFiles: true,
      followSymbolicLinks: false,
    });
    const rel = matches
      .map((m) => relative(ctx.workspace.root, join(base.absolute, m)).split("\\").join("/"))
      .filter((r) => !r.startsWith("..") && !ig.ignores(r))
      .sort();
    const LIMIT = 500;
    const shown = rel.slice(0, LIMIT);
    return ok(shown.length ? shown.join("\n") + (rel.length > LIMIT ? `\n[${rel.length - LIMIT} more not shown]` : "") : "No files matched.", {
      count: rel.length,
    });
  },
};

/** Fuzzy file-name search: all query characters must appear in order. */
export function fuzzyScore(query: string, candidate: string): number | null {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  if (c.includes(q)) return 1000 - c.length + (c.endsWith(q) ? 200 : 0);
  let qi = 0;
  let score = 0;
  let streak = 0;
  for (let i = 0; i < c.length && qi < q.length; i++) {
    if (c[i] === q[qi]) {
      qi++;
      streak++;
      score += streak * 2 + (i === 0 || "/._-".includes(c[i - 1]!) ? 5 : 0);
    } else streak = 0;
  }
  return qi === q.length ? score - c.length * 0.1 : null;
}

export const searchFilesTool: Tool<{ query: string; path?: string; limit?: number }> = {
  name: "search_files",
  description: "Search file names/paths (fuzzy). Use this to locate a file when you know part of its name; use grep_search to search file contents.",
  version: "1.0.0",
  category: "read",
  readOnly: true,
  schema: z.object({ query: z.string().min(1), path: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }),
  describe: (a, ctx) => ({ tool: "search_files", category: "read", paths: [ctx.workspace.resolve(a.path ?? ".")], summary: `Find files matching ${a.query}` }),
  async execute(a, ctx) {
    const base = ctx.workspace.resolveInside(a.path ?? ".");
    const scored: [number, string][] = [];
    for await (const f of walkFiles(ctx.workspace.root, base.absolute, { signal: ctx.signal })) {
      const s = fuzzyScore(a.query, f);
      if (s !== null) scored.push([s, f]);
    }
    scored.sort((x, y) => y[0] - x[0] || x[1].localeCompare(y[1]));
    const top = scored.slice(0, a.limit ?? 30).map(([, f]) => f);
    return ok(top.length ? top.join("\n") : "No matching files.", { count: scored.length });
  },
};

export interface GrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  fixedStrings?: boolean;
  contextLines?: number;
  maxResults?: number;
}

export const grepSearchTool: Tool<GrepArgs> = {
  name: "grep_search",
  description:
    "Search file contents with a regular expression (ripgrep syntax; a JavaScript fallback is used if ripgrep is missing). Returns 'path:line: text' matches. Respects .gitignore.",
  version: "1.0.0",
  category: "read",
  readOnly: true,
  schema: z.object({
    pattern: z.string().min(1),
    path: z.string().optional().describe("File or directory to search (default workspace root)"),
    glob: z.string().optional().describe("Only search files matching this glob, e.g. '*.ts'"),
    ignoreCase: z.boolean().optional(),
    fixedStrings: z.boolean().optional().describe("Treat pattern as a literal string"),
    contextLines: z.number().int().min(0).max(10).optional(),
    maxResults: z.number().int().min(1).max(1000).optional(),
  }),
  describe: (a, ctx) => ({ tool: "grep_search", category: "read", paths: [ctx.workspace.resolve(a.path ?? ".")], summary: `Search for ${a.pattern}` }),
  async execute(a, ctx) {
    const base = ctx.workspace.resolveInside(a.path ?? ".");
    const max = a.maxResults ?? 200;
    const lines = (await hasRipgrep()) ? await grepWithRipgrep(a, base.absolute, ctx.workspace.root, ctx.signal) : await grepFallback(a, base.absolute, ctx.workspace.root, ctx.signal);
    if (lines === null) return fail("invalid_arguments", `Invalid regular expression: ${a.pattern}`);
    const shown = lines.slice(0, max);
    return ok(shown.length ? shown.join("\n") + (lines.length > max ? `\n[${lines.length - max} more matches not shown]` : "") : "No matches.", {
      matches: lines.length,
    });
  },
};

async function grepWithRipgrep(a: GrepArgs, base: string, root: string, signal: AbortSignal): Promise<string[] | null> {
  const argv = ["rg", "--line-number", "--no-heading", "--color=never", "--max-columns=400", "--max-count=200"];
  if (a.ignoreCase) argv.push("--ignore-case");
  if (a.fixedStrings) argv.push("--fixed-strings");
  if (a.contextLines) argv.push(`--context=${a.contextLines}`);
  if (a.glob) argv.push("--glob", a.glob);
  for (const d of ALWAYS_IGNORED) argv.push("--glob", `!${d}/`);
  argv.push("--", a.pattern, relative(root, base) || ".");
  const r = await runProcess({ command: argv.join(" "), argv, cwd: root, timeoutMs: 30_000, signal, captureLimit: 2_000_000 });
  if (r.exitCode === 2) return null;
  return r.stdout.split("\n").filter(Boolean);
}

async function grepFallback(a: GrepArgs, base: string, root: string, signal: AbortSignal): Promise<string[] | null> {
  let re: RegExp;
  try {
    const src = a.fixedStrings ? a.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : a.pattern;
    re = new RegExp(src, a.ignoreCase ? "i" : "");
  } catch {
    return null;
  }
  const globRe = a.glob ? new RegExp("(^|/)" + a.glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*") + "$") : null;
  const out: string[] = [];
  const ctxN = a.contextLines ?? 0;
  const files: string[] = [];
  const st = statSync(base);
  if (st.isFile()) files.push(relative(root, base));
  else for await (const f of walkFiles(root, base, { signal })) files.push(f);
  files.sort();
  for (const f of files) {
    if (globRe && !globRe.test(f)) continue;
    let buf: Buffer;
    try {
      buf = readFileSync(join(root, f));
    } catch {
      continue;
    }
    if (buf.length > MAX_READ_BYTES || isProbablyBinary(buf)) continue;
    const lines = buf.toString("utf8").split("\n");
    lines.forEach((line, i) => {
      if (!re.test(line)) return;
      for (let j = Math.max(0, i - ctxN); j < i; j++) out.push(`${f}-${j + 1}-${lines[j]!.slice(0, 400)}`);
      out.push(`${f}:${i + 1}:${line.slice(0, 400)}`);
      for (let j = i + 1; j <= Math.min(lines.length - 1, i + ctxN); j++) out.push(`${f}-${j + 1}-${lines[j]!.slice(0, 400)}`);
    });
    if (out.length > 5000) break;
  }
  return out;
}

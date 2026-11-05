import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { fail, ok, type Tool, type ToolContext } from "../types.js";

function unavailable() {
  return fail("execution_failed", "The repository index is disabled (index.enabled: false). Use glob_files and grep_search instead.");
}

const describeWorkspace = (name: string, summary: string) => (_a: unknown, ctx: ToolContext) => ({
  tool: name,
  category: "read" as const,
  paths: [ctx.workspace.resolve(".")],
  summary,
});

export const repoMapTool: Tool<{ focus?: string[]; max_tokens?: number }> = {
  name: "repo_map",
  description:
    "Outline of the repository: the most-referenced source files and their key definitions (with line numbers), ranked by how much other code uses them. Pass `focus` (file paths, directories or symbol names) to centre the map on the code you are working on.",
  version: "1.0.0",
  category: "read",
  readOnly: true,
  schema: z.object({
    focus: z.array(z.string().min(1)).max(20).optional().describe("Files, directories or symbol names to centre the map on"),
    max_tokens: z.number().int().min(200).max(8000).optional().describe("Size budget (default 2000)"),
  }),
  describe: (a, ctx) => describeWorkspace("repo_map", a.focus?.length ? `Map around ${a.focus.join(", ")}` : "Repository map")(a, ctx),
  async execute(a, ctx) {
    const svc = ctx.repoIndex;
    if (!svc) return unavailable();
    const stats = svc.refresh();
    const text = svc.index.map({ maxTokens: a.max_tokens ?? 2000, ...(a.focus ? { focus: a.focus } : {}) });
    return ok(text, { files: stats.files, symbols: stats.symbols });
  },
};

function lineMatches(root: string, path: string, name: string, limit: number): { line: number; text: string }[] {
  let lines: string[];
  try {
    lines = readFileSync(join(root, path), "utf8").split("\n");
  } catch {
    return [];
  }
  const re = new RegExp(`(^|[^\\w$])${name.replace(/[$]/g, "\\$")}([^\\w$]|$)`);
  const out: { line: number; text: string }[] = [];
  for (let i = 0; i < lines.length && out.length < limit; i++) if (re.test(lines[i]!)) out.push({ line: i + 1, text: lines[i]!.trim().slice(0, 160) });
  return out;
}

export const findSymbolTool: Tool<{ name: string; references?: boolean; limit?: number }> = {
  name: "find_symbol",
  description:
    "Find where a function, class, method, type or constant is defined (file:line and signature) and where it is used. Accepts `name` or `Class.method`. Faster and more precise than grep for code navigation.",
  version: "1.0.0",
  category: "read",
  readOnly: true,
  schema: z.object({
    name: z.string().min(1).max(200).regex(/^[A-Za-z_$][\w$]*(\.[A-Za-z_$#][\w$]*)?$/, "a symbol name such as parseConfig or Session.refresh"),
    references: z.boolean().optional().describe("Also list usages (default true)"),
    limit: z.number().int().min(1).max(200).optional().describe("Max usage lines (default 40)"),
  }),
  describe: (a, ctx) => describeWorkspace("find_symbol", a.name)(a, ctx),
  async execute(a, ctx) {
    const svc = ctx.repoIndex;
    if (!svc) return unavailable();
    svc.refresh();
    const defs = svc.index.findDefinitions(a.name);
    const member = a.name.split(".").pop()!;
    const out: string[] = [];
    if (defs.length) {
      out.push(`Definitions of ${a.name} (${defs.length}):`);
      for (const d of defs.slice(0, 30)) out.push(`  ${d.file.path}:${d.symbol.line}  ${d.symbol.kind}${d.symbol.parent ? ` in ${d.symbol.parent}` : ""}  ${d.symbol.signature}`);
    } else out.push(`No definition of ${a.name} found in ${svc.index.stats.files} indexed files (it may be defined dynamically, in a dependency, or in a language the index doesn't parse; try grep_search).`);

    let usages = 0;
    if (a.references !== false) {
      const limit = a.limit ?? 40;
      const defLines = new Set(defs.map((d) => `${d.file.path}:${d.symbol.line}`));
      const files = svc.index.filesReferencing(member);
      const lines: string[] = [];
      for (const f of files) {
        for (const m of lineMatches(ctx.workspace.root, f, member, limit)) {
          if (defLines.has(`${f}:${m.line}`)) continue;
          if (lines.length >= limit) break;
          lines.push(`  ${f}:${m.line}  ${m.text}`);
          usages++;
        }
        if (lines.length >= limit) break;
      }
      out.push("", `Used in ${files.length} file(s)${usages >= limit ? ` (first ${limit} lines)` : ""}:`, ...(lines.length ? lines : ["  (no usages found)"]));
    }
    return ok(out.join("\n"), { definitions: defs.length, usages });
  },
};

export const codeSearchTool: Tool<{ query: string; limit?: number; path?: string }> = {
  name: "code_search",
  description:
    "Ranked search over the codebase for a concept or behaviour described in words (e.g. 'where expired sessions are refreshed'). Returns the best-matching functions/classes with file:line ranges. Uses BM25 over identifiers split into words; combined with embeddings when configured. Use grep_search for exact strings.",
  version: "1.0.0",
  category: "read",
  readOnly: true,
  schema: z.object({
    query: z.string().min(2).max(500),
    limit: z.number().int().min(1).max(30).optional().describe("Results to return (default 8)"),
    path: z.string().optional().describe("Only search under this directory"),
  }),
  describe: (a, ctx) => describeWorkspace("code_search", a.query)(a, ctx),
  async execute(a, ctx) {
    const svc = ctx.repoIndex;
    if (!svc) return unavailable();
    const prefix = a.path ? ctx.workspace.resolveInside(a.path).display.replace(/^\.$/, "") : undefined;
    const res = await svc.search(a.query, { limit: a.limit ?? 8, ...(prefix ? { pathPrefix: prefix.endsWith("/") || !prefix ? prefix : prefix + "/" } : {}), signal: ctx.signal });
    if (!res.hits.length) return ok(`No matches for "${a.query}". Try different words, find_symbol for a known name, or grep_search for an exact string.`, { hits: 0, mode: res.mode });
    const head = `${res.hits.length} result(s), ranked by ${res.mode === "hybrid" ? `BM25 + embeddings (${svc.embeddingModel})` : "BM25"}${res.note ? ` — ${res.note}` : ""}:`;
    const body = res.hits.map((h, i) => `${i + 1}. ${h.path}:${h.startLine}-${h.endLine}${h.symbol ? `  ${h.symbol}` : ""}\n${h.preview.split("\n").map((l) => `     ${l}`).join("\n")}`);
    return ok([head, ...body].join("\n"), { hits: res.hits.length, mode: res.mode });
  },
};

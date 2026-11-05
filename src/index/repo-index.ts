import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { roughTokens } from "../context/tokens.js";
import { isProbablyBinary } from "../utils/text.js";
import { loadIgnore } from "../utils/walk.js";
import { extractSymbols, identifierCounts, languageOf, splitIdentifier, type CodeSymbol, type Language } from "./symbols.js";

export interface IndexedFile {
  path: string;
  lang: Language;
  size: number;
  mtimeMs: number;
  lines: number;
  symbols: CodeSymbol[];
  idents: Map<string, number>;
  chunks: Chunk[];
}

export interface Chunk {
  path: string;
  startLine: number;
  endLine: number;
  /** Symbol that opens the chunk, if any. */
  symbol?: string;
  terms: Map<string, number>;
  length: number;
  /** First few non-empty lines, for display. */
  preview: string;
  /** Stable key for embedding caches. */
  key: string;
}

export interface SearchHit {
  path: string;
  startLine: number;
  endLine: number;
  symbol?: string;
  score: number;
  preview: string;
}

export interface IndexStats {
  files: number;
  symbols: number;
  chunks: number;
  skipped: number;
  truncated: boolean;
  buildMs: number;
}

export interface RepoIndexOptions {
  maxFiles?: number;
  maxFileBytes?: number;
}

const STOP = new Set(
  (
    "the a an and or of to in on for with is are be by as at it this that from not no do does how where what when which who why " +
    "const let var function return if else for while do switch case break continue new class extends implements import export default from " +
    "public private protected static async await yield try catch finally throw typeof instanceof void null undefined true false this super " +
    "def self cls none pass lambda elif except raise with yield fn pub mut impl use mod struct enum trait type interface package func go " +
    "int str string bool boolean number any object array map set list dict get set end begin then module require include"
  ).split(/\s+/),
);

function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/[A-Za-z_$][\w$]*/g)) {
    for (const part of splitIdentifier(m[0])) if (!STOP.has(part) && part.length >= 2) out.push(stem(part));
  }
  return out;
}

/**
 * Very light stemming so "sessions"/"session", "refreshing"/"refresh" and
 * "expire"/"expired"/"expires" meet. Suffixes are removed in sequence, then a
 * trailing "e" is dropped so the forms converge.
 */
export function stem(word: string): string {
  let w = word;
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ies")) w = w.slice(0, -3) + "y";
  else if (w.length > 4 && /(ss|sh|ch|x|z)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  if (w.length > 4 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

function addTerms(into: Map<string, number>, terms: string[], weight = 1): void {
  for (const t of terms) into.set(t, (into.get(t) ?? 0) + weight);
}

const CHUNK_MAX_LINES = 80;

/** A name distinctive enough to treat a matching identifier elsewhere as a reference. */
export function isLinkable(s: CodeSymbol): boolean {
  if (s.kind === "method") return s.name.length >= 5 && /[A-Z_0-9]/.test(s.name.slice(1));
  if (!s.exported) return false;
  if (s.name.length < 4) return false;
  return /[A-Z_0-9]/.test(s.name.slice(1)) || /^[A-Z]/.test(s.name) || s.name.length >= 8;
}

/** Tests, fixtures, examples, benchmarks and build scripts. */
export function isAuxiliary(path: string): boolean {
  return /(^|\/)(tests?|__tests__|spec|specs|fixtures?|examples?|benchmarks?|scripts?|e2e|mocks?)\//i.test(path) || /\.(test|spec)\.[a-z]+$/i.test(path) || /(^|\/)test_[^/]+\.py$/.test(path);
}

function buildChunks(path: string, lines: string[], symbols: CodeSymbol[]): Chunk[] {
  const starts = [...new Set([1, ...symbols.map((s) => s.line)])].sort((a, b) => a - b);
  const bySymbolLine = new Map(symbols.map((s) => [s.line, s]));
  const pathTerms = tokenize(path.replace(/\.[^.]+$/, ""));
  const chunks: Chunk[] = [];
  for (let i = 0; i < starts.length; i++) {
    const begin = starts[i]!;
    const stop = Math.min(lines.length, (starts[i + 1] ?? lines.length + 1) - 1);
    for (let s = begin; s <= stop; s += CHUNK_MAX_LINES) {
      const e = Math.min(stop, s + CHUNK_MAX_LINES - 1);
      const body = lines.slice(s - 1, e);
      if (!body.some((l) => l.trim())) continue;
      const terms = new Map<string, number>();
      addTerms(terms, tokenize(body.join("\n")));
      const sym = s === begin ? bySymbolLine.get(begin) : undefined;
      // Names say more than bodies: weight the symbol name and the file path.
      if (sym) addTerms(terms, tokenize(sym.name + " " + (sym.parent ?? "")), 4);
      addTerms(terms, pathTerms, 2);
      let length = 0;
      for (const v of terms.values()) length += v;
      chunks.push({
        path,
        startLine: s,
        endLine: e,
        ...(sym ? { symbol: sym.parent ? `${sym.parent}.${sym.name}` : sym.name } : {}),
        terms,
        length,
        preview: body
          .filter((l) => l.trim())
          .slice(0, 3)
          .map((l) => l.trimEnd().slice(0, 140))
          .join("\n"),
        key: `${path}:${s}:${e}`,
      });
    }
  }
  return chunks;
}

/**
 * An in-memory index of the workspace's source code: symbols per file, a
 * reference graph ranked with PageRank, and a BM25 index over symbol-sized
 * chunks. Rebuilt incrementally: unchanged files (same size and mtime) are
 * not re-read.
 */
export class RepoIndex {
  private byPath = new Map<string, IndexedFile>();
  private lastStats: IndexStats = { files: 0, symbols: 0, chunks: 0, skipped: 0, truncated: false, buildMs: 0 };
  private rankCache: Map<string, number> | null = null;
  private dfCache: { df: Map<string, number>; n: number; avg: number } | null = null;
  readonly maxFiles: number;
  readonly maxFileBytes: number;

  constructor(
    readonly root: string,
    opts: RepoIndexOptions = {},
  ) {
    this.maxFiles = opts.maxFiles ?? 5000;
    this.maxFileBytes = opts.maxFileBytes ?? 512 * 1024;
  }

  get stats(): IndexStats {
    return this.lastStats;
  }

  files(): IndexedFile[] {
    return [...this.byPath.values()];
  }

  get(path: string): IndexedFile | undefined {
    return this.byPath.get(path);
  }

  /** Scan the workspace and (re)index new or changed files. */
  refresh(): IndexStats {
    const started = performance.now();
    const ig = loadIgnore(this.root);
    const seen = new Set<string>();
    let skipped = 0;
    let truncated = false;
    let changed = false;
    const stack = [this.root];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const abs = join(dir, e.name);
        const rel = relative(this.root, abs).split("\\").join("/");
        if (e.isDirectory()) {
          if (!ig.ignores(rel + "/")) stack.push(abs);
          continue;
        }
        if (!e.isFile() || ig.ignores(rel)) continue;
        const lang = languageOf(rel);
        if (!lang) continue;
        if (seen.size >= this.maxFiles) {
          truncated = true;
          continue;
        }
        let st;
        try {
          st = statSync(abs);
        } catch {
          continue;
        }
        if (st.size > this.maxFileBytes) {
          skipped++;
          continue;
        }
        seen.add(rel);
        const prev = this.byPath.get(rel);
        if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) continue;
        let buf: Buffer;
        try {
          buf = readFileSync(abs);
        } catch {
          continue;
        }
        if (isProbablyBinary(buf)) {
          skipped++;
          continue;
        }
        const source = buf.toString("utf8");
        const lines = source.split("\n");
        const symbols = extractSymbols(source, lang);
        this.byPath.set(rel, { path: rel, lang, size: st.size, mtimeMs: st.mtimeMs, lines: lines.length, symbols, idents: identifierCounts(source), chunks: buildChunks(rel, lines, symbols) });
        changed = true;
      }
    }
    for (const p of [...this.byPath.keys()])
      if (!seen.has(p)) {
        this.byPath.delete(p);
        changed = true;
      }
    if (changed) {
      this.rankCache = null;
      this.dfCache = null;
    }
    const files = this.files();
    this.lastStats = {
      files: files.length,
      symbols: files.reduce((a, f) => a + f.symbols.length, 0),
      chunks: files.reduce((a, f) => a + f.chunks.length, 0),
      skipped,
      truncated,
      buildMs: Math.round(performance.now() - started),
    };
    return this.lastStats;
  }

  // ----------------------------------------------------------- definitions

  /**
   * Files that define each name, restricted to names that can meaningfully
   * link files: visible outside their file and distinctive enough that a
   * matching identifier elsewhere is probably a real reference. Generic
   * words (type, call, line, ctx, mount) would otherwise wire unrelated
   * files together.
   */
  private definitionsByName(): Map<string, Set<string>> {
    const defs = new Map<string, Set<string>>();
    for (const f of this.byPath.values())
      for (const s of f.symbols) {
        if (!isLinkable(s)) continue;
        let set = defs.get(s.name);
        if (!set) defs.set(s.name, (set = new Set()));
        set.add(f.path);
      }
    return defs;
  }

  findDefinitions(name: string): { file: IndexedFile; symbol: CodeSymbol }[] {
    const out: { file: IndexedFile; symbol: CodeSymbol }[] = [];
    const [parent, member] = name.includes(".") ? (name.split(".", 2) as [string, string]) : [undefined, name];
    for (const f of this.byPath.values())
      for (const s of f.symbols) if (s.name === member && (!parent || s.parent === parent)) out.push({ file: f, symbol: s });
    const kindOrder = (k: string) => (k === "method" ? 1 : 0);
    return out.sort((a, b) => kindOrder(a.symbol.kind) - kindOrder(b.symbol.kind) || a.file.path.localeCompare(b.file.path));
  }

  /** Dependency edges of one file: files whose definitions it uses, and files that use its definitions. */
  neighbors(path: string, limit = 6): { uses: string[]; usedBy: string[] } {
    const file = this.byPath.get(path);
    if (!file) return { uses: [], usedBy: [] };
    const defs = this.definitionsByName();
    const uses = new Map<string, number>();
    for (const [name, count] of file.idents) {
      const d = defs.get(name);
      if (!d || d.size > 8 || d.has(path)) continue;
      for (const t of d) uses.set(t, (uses.get(t) ?? 0) + count);
    }
    const own = new Set(file.symbols.filter(isLinkable).map((s) => s.name));
    const usedBy = new Map<string, number>();
    for (const other of this.byPath.values()) {
      if (other === file) continue;
      let n = 0;
      for (const name of own) n += other.idents.get(name) ?? 0;
      if (n) usedBy.set(other.path, n);
    }
    const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([p]) => p);
    return { uses: top(uses), usedBy: top(usedBy) };
  }

  /** The definition enclosing a 1-based line, if any. */
  enclosingSymbol(path: string, line: number): CodeSymbol | undefined {
    const f = this.byPath.get(path);
    if (!f) return undefined;
    let best: CodeSymbol | undefined;
    for (const s of f.symbols) if (s.line <= line && (!best || s.line >= best.line)) best = s;
    return best;
  }

  /** Files that mention `name` (from the identifier index, excluding pure definitions). */
  filesReferencing(name: string): string[] {
    const out: string[] = [];
    for (const f of this.byPath.values()) {
      const n = f.idents.get(name) ?? 0;
      const own = f.symbols.filter((s) => s.name === name).length;
      if (n > own) out.push(f.path);
    }
    return out.sort();
  }

  // ---------------------------------------------------------------- ranking

  /**
   * PageRank over the file reference graph: file A links to file B when A
   * uses a name that B defines. Focus files (and files defining focus names)
   * get the personalisation mass, so the map centres on what you're working on.
   */
  rank(focus: string[] = []): Map<string, number> {
    if (!focus.length && this.rankCache) return this.rankCache;
    const files = this.files();
    const n = files.length;
    const ranks = new Map<string, number>();
    if (n === 0) return ranks;
    const idx = new Map(files.map((f, i) => [f.path, i]));
    const defs = this.definitionsByName();
    const out: Map<number, number>[] = files.map(() => new Map());
    files.forEach((f, i) => {
      for (const [name, count] of f.idents) {
        const d = defs.get(name);
        if (!d || d.size > 8 || d.has(f.path)) continue;
        const w = Math.sqrt(count) / d.size;
        for (const target of d) {
          const j = idx.get(target)!;
          out[i]!.set(j, (out[i]!.get(j) ?? 0) + w);
        }
      }
    });
    const personal = new Float64Array(n).fill(1 / n);
    if (focus.length) {
      const focusSet = new Set<number>();
      for (const fo of focus) {
        for (const f of files) if (f.path === fo || f.path.endsWith("/" + fo) || f.path.startsWith(fo.replace(/\/$/, "") + "/")) focusSet.add(idx.get(f.path)!);
        for (const p of defs.get(fo) ?? []) focusSet.add(idx.get(p)!);
      }
      if (focusSet.size) {
        personal.fill(0.15 / n);
        for (const i of focusSet) personal[i]! += 0.85 / focusSet.size;
      }
    }
    const totals = out.map((m) => [...m.values()].reduce((a, b) => a + b, 0));
    let pr = Float64Array.from(personal);
    const d = 0.85;
    for (let iter = 0; iter < 40; iter++) {
      const next = new Float64Array(n);
      let dangling = 0;
      for (let i = 0; i < n; i++) {
        if (totals[i] === 0) {
          dangling += pr[i]!;
          continue;
        }
        for (const [j, w] of out[i]!) next[j]! += (d * pr[i]! * w) / totals[i]!;
      }
      for (let i = 0; i < n; i++) next[i]! += (1 - d) * personal[i]! + d * dangling * personal[i]!;
      pr = next;
    }
    // Tests, examples and scripts are useful but rarely where a change belongs.
    files.forEach((f, i) => ranks.set(f.path, pr[i]! * (isAuxiliary(f.path) ? 0.25 : 1)));
    if (!focus.length) this.rankCache = ranks;
    return ranks;
  }

  /** Number of files mentioning each identifier (computed once per map). */
  private identFileCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const f of this.byPath.values()) for (const name of f.idents.keys()) counts.set(name, (counts.get(name) ?? 0) + 1);
    return counts;
  }

  /** How many other files use each symbol of `file` (its importance within the file). */
  private symbolScores(file: IndexedFile, fileCounts: Map<string, number>): Map<CodeSymbol, number> {
    const scores = new Map<CodeSymbol, number>();
    for (const s of file.symbols) {
      const refs = Math.max(0, (fileCounts.get(s.name) ?? 0) - (file.idents.has(s.name) ? 1 : 0));
      scores.set(s, refs * 2 + (s.exported ? 1 : 0) + (s.kind === "class" || s.kind === "interface" ? 1 : 0));
    }
    return scores;
  }

  // -------------------------------------------------------------------- map

  /** A compact, token-budgeted outline of the most important files and their key definitions. */
  map(opts: { maxTokens: number; focus?: string[] }): string {
    const ranks = this.rank(opts.focus ?? []);
    const ordered = this.files().sort((a, b) => (ranks.get(b.path) ?? 0) - (ranks.get(a.path) ?? 0) || a.path.localeCompare(b.path));
    const header = `${this.byPath.size} source files indexed${this.lastStats.truncated ? ` (stopped at ${this.maxFiles})` : ""}; most-referenced first. Line numbers are 1-based; read_file with offset jumps there.`;
    const parts: string[] = [header];
    let used = roughTokens(header);
    let shown = 0;
    const fileCounts = this.identFileCounts();
    for (const f of ordered) {
      if (!f.symbols.length) continue;
      const scores = this.symbolScores(f, fileCounts);
      const top = [...f.symbols].sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0) || a.line - b.line).slice(0, 12);
      top.sort((a, b) => a.line - b.line);
      const width = String(top[top.length - 1]?.line ?? 0).length;
      const block = [`${f.path}:`, ...top.map((s) => `  ${String(s.line).padStart(width)}  ${s.parent ? "  " : ""}${s.signature}`)];
      if (f.symbols.length > top.length) block.push(`  ${" ".repeat(width)}  … ${f.symbols.length - top.length} more`);
      const text = block.join("\n");
      const cost = roughTokens(text) + 1;
      if (used + cost > opts.maxTokens) {
        // Fall back to just the file name if there's room.
        const short = `${f.path}: ${top.slice(0, 3).map((s) => s.name).join(", ")}${f.symbols.length > 3 ? ", …" : ""}`;
        const sc = roughTokens(short) + 1;
        if (used + sc > opts.maxTokens) break;
        parts.push(short);
        used += sc;
      } else {
        parts.push(text);
        used += cost;
      }
      shown++;
    }
    const remaining = ordered.filter((f) => f.symbols.length).length - shown;
    if (remaining > 0) parts.push(`… ${remaining} more files (repo_map with focus, find_symbol or code_search to dig in)`);
    return parts.join("\n");
  }

  // ----------------------------------------------------------------- search

  private corpusStats(): { df: Map<string, number>; n: number; avg: number } {
    if (this.dfCache) return this.dfCache;
    const df = new Map<string, number>();
    let n = 0;
    let total = 0;
    for (const f of this.byPath.values())
      for (const c of f.chunks) {
        n++;
        total += c.length;
        for (const t of c.terms.keys()) df.set(t, (df.get(t) ?? 0) + 1);
      }
    return (this.dfCache = { df, n, avg: n ? total / n : 0 });
  }

  allChunks(): Chunk[] {
    return this.files().flatMap((f) => f.chunks);
  }

  /** BM25 over symbol-sized chunks with identifier-aware tokenisation. */
  search(query: string, opts: { limit?: number; pathPrefix?: string } = {}): SearchHit[] {
    const q = [...new Set(tokenize(query))];
    if (!q.length) return [];
    const { df, n, avg } = this.corpusStats();
    const k1 = 1.2;
    const b = 0.75;
    const hits: SearchHit[] = [];
    for (const f of this.byPath.values()) {
      if (opts.pathPrefix && !f.path.startsWith(opts.pathPrefix)) continue;
      for (const c of f.chunks) {
        let score = 0;
        let matched = 0;
        for (const t of q) {
          const tf = c.terms.get(t);
          if (!tf) continue;
          matched++;
          const idf = Math.log(1 + (n - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
          score += (idf * (tf * (k1 + 1))) / (tf + k1 * (1 - b + (b * c.length) / (avg || 1)));
        }
        if (!matched) continue;
        // Reward chunks that cover more of the query.
        score *= 1 + matched / q.length;
        hits.push({ path: c.path, startLine: c.startLine, endLine: c.endLine, ...(c.symbol ? { symbol: c.symbol } : {}), score, preview: c.preview });
      }
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 10);
  }
}

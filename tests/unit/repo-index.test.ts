import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PlanStore } from "../../src/core/planning/plan.js";
import { reciprocalRankFusion } from "../../src/index/embeddings.js";
import { RepoIndex, isAuxiliary, isLinkable, stem } from "../../src/index/repo-index.js";
import { RepoIndexService } from "../../src/index/service.js";
import { extractSymbols, splitIdentifier } from "../../src/index/symbols.js";
import { Workspace } from "../../src/permissions/paths.js";
import { SecretRedactor } from "../../src/permissions/sensitive.js";
import { FileStateTracker } from "../../src/tools/file-state.js";
import { createDefaultRegistry } from "../../src/tools/registry.js";
import type { ToolContext } from "../../src/tools/types.js";
import { createHarness, tempDir, writeFiles, type Harness } from "../helpers/harness.js";
import { ScriptedProvider } from "../helpers/scripted-provider.js";

const names = (src: string, lang: Parameters<typeof extractSymbols>[1]) => extractSymbols(src, lang).map((s) => `${s.kind}:${s.parent ? s.parent + "." : ""}${s.name}@${s.line}`);

describe("symbol extraction", () => {
  it("TypeScript: functions, classes, methods, types, arrow functions; ignores calls", () => {
    const src = `import x from "y";
export interface Session { id: string }
export type Id = string;
export enum Mode { A }
export async function refreshToken(s: Session): Promise<void> {
  return new Promise((resolve) => {
    resolve({
      ok: true,
    });
  });
}
export const isExpired = (s: Session, now = Date.now()) => s.exp < now;
const helper = function () {};
export class SessionStore extends Base {
  private cache = new Map();
  constructor(private db: Db) {
    super();
  }
  async load(id: string): Promise<Session> {
    if (id) {
      return this.cache.get(id);
    }
  }
}
// function commentedOut() {}
`;
    expect(names(src, "typescript")).toEqual([
      "interface:Session@2",
      "type:Id@3",
      "enum:Mode@4",
      "function:refreshToken@5",
      "function:isExpired@12",
      "function:helper@13",
      "class:SessionStore@14",
      "method:SessionStore.constructor@16",
      "method:SessionStore.load@19",
    ]);
    const exported = extractSymbols(src, "typescript").filter((s) => s.exported).map((s) => s.name);
    expect(exported).toEqual(["Session", "Id", "Mode", "refreshToken", "isExpired", "SessionStore"]);
  });

  it("Python, Go, Rust and Ruby", () => {
    expect(names("class Cache:\n    def get(self, k):\n        pass\n\ndef build_cache():\n    return Cache()\n", "python")).toEqual(["class:Cache@1", "method:Cache.get@2", "function:build_cache@5"]);
    expect(names("package x\n\ntype Server struct {}\n\nfunc (s *Server) Start() error {\n}\n\nfunc NewServer() *Server {\n}\n", "go")).toEqual([
      "struct:Server@3",
      "method:Server.Start@5",
      "function:NewServer@8",
    ]);
    expect(names("pub struct Pool;\nimpl Pool {\n    pub fn acquire(&self) {}\n}\npub trait Handle {}\nfn helper() {}\n", "rust")).toEqual(["struct:Pool@1", "function:acquire@3", "trait:Handle@5", "function:helper@6"]);
    expect(names("module Billing\n  class Invoice\n    def total\n    end\n  end\nend\n", "ruby")).toEqual(["module:Billing@1", "class:Invoice@2", "function:Invoice.total@3"]);
  });

  it("stems word forms together", () => {
    for (const group of [["expire", "expired", "expires", "expiring"], ["session", "sessions"], ["refresh", "refreshing", "refreshes"], ["cache", "caches", "cached"]])
      expect(new Set(group.map(stem)).size, group.join("/")).toBe(1);
  });

  it("splits identifiers into words", () => {
    expect(splitIdentifier("refreshAuthToken")).toEqual(["refresh", "auth", "token"]);
    expect(splitIdentifier("HTTPServerError")).toEqual(["http", "server", "error"]);
    expect(splitIdentifier("max_retry_count")).toEqual(["max", "retry", "count"]);
  });
});

function sampleRepo(): string {
  const root = tempDir("sutra-index-");
  writeFiles(root, {
    "src/session.ts": `export interface Session { expiresAt: number }\nexport function isExpired(session: Session, now = Date.now()): boolean {\n  return session.expiresAt * 1000 <= now;\n}\nexport function refreshSession(session: Session) {\n  // exchange the refresh token for a new session\n  return { ...session, expiresAt: 0 };\n}\n`,
    "src/api.ts": `import { isExpired, refreshSession, type Session } from "./session.js";\nexport function handleRequest(session: Session) {\n  if (isExpired(session)) return refreshSession(session);\n  return session;\n}\n`,
    "src/routes.ts": `import { handleRequest } from "./api.js";\nimport type { Session } from "./session.js";\nexport function route(s: Session) { return handleRequest(s); }\n`,
    "src/util/strings.ts": `export function padLeftText(s: string, n: number) { return s.padStart(n); }\n`,
    "tests/session.test.ts": `import { isExpired } from "../src/session.js";\nexport function mountFixture() {}\n`,
    "README.md": "# not code\n",
    "node_modules/dep/index.js": "export function ignored() {}\n",
  });
  return root;
}

describe("repository index", () => {
  it("indexes source files, honouring ignores", () => {
    const idx = new RepoIndex(sampleRepo());
    const st = idx.refresh();
    expect(idx.files().map((f) => f.path).sort()).toEqual(["src/api.ts", "src/routes.ts", "src/session.ts", "src/util/strings.ts", "tests/session.test.ts"]);
    expect(st.symbols).toBeGreaterThanOrEqual(7);
  });

  it("ranks the most-depended-on file first and tests last", () => {
    const idx = new RepoIndex(sampleRepo());
    idx.refresh();
    const order = [...idx.rank().entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
    expect(order[0]).toBe("src/session.ts");
    expect(order.indexOf("src/api.ts")).toBeLessThan(order.indexOf("src/routes.ts"));
    expect(order.at(-1)).toBe("tests/session.test.ts");
  });

  it("focus shifts the ranking towards the given file", () => {
    const idx = new RepoIndex(sampleRepo());
    idx.refresh();
    const focused = [...idx.rank(["src/util/strings.ts"]).entries()].sort((a, b) => b[1] - a[1]);
    expect(focused[0]![0]).toBe("src/util/strings.ts");
  });

  it("renders a token-budgeted map with line numbers and signatures", () => {
    const idx = new RepoIndex(sampleRepo());
    idx.refresh();
    const map = idx.map({ maxTokens: 2000 });
    expect(map).toMatch(/^5 source files indexed/);
    expect(map).toContain("src/session.ts:\n  1  export interface Session { expiresAt: number }\n  2  export function isExpired(session: Session, now = Date.now()): boolean");
    expect(map.indexOf("src/session.ts")).toBeLessThan(map.indexOf("src/routes.ts"));
    const tiny = idx.map({ maxTokens: 60 });
    expect(tiny.length).toBeLessThan(map.length);
    expect(tiny).toMatch(/more files/);
  });

  it("finds definitions and references", () => {
    const idx = new RepoIndex(sampleRepo());
    idx.refresh();
    expect(idx.findDefinitions("isExpired").map((d) => `${d.file.path}:${d.symbol.line}`)).toEqual(["src/session.ts:2"]);
    expect(idx.filesReferencing("isExpired")).toEqual(["src/api.ts", "tests/session.test.ts"]);
  });

  it("ranks code by meaning-bearing words, not exact strings", () => {
    const idx = new RepoIndex(sampleRepo());
    idx.refresh();
    const hits = idx.search("when do sessions expire");
    expect(hits[0]).toMatchObject({ path: "src/session.ts", symbol: "isExpired" });
    expect(idx.search("refresh token exchange")[0]).toMatchObject({ symbol: "refreshSession" });
    expect(idx.search("pad text on the left")[0]).toMatchObject({ path: "src/util/strings.ts" });
    expect(idx.search("the of and")).toEqual([]);
  });

  it("re-indexes only changed files and drops deleted ones", () => {
    const root = sampleRepo();
    const idx = new RepoIndex(root);
    idx.refresh();
    const before = idx.get("src/api.ts");
    writeFileSync(join(root, "src/session.ts"), "export function brandNewName() {}\n");
    utimesSync(join(root, "src/session.ts"), new Date(), new Date(Date.now() + 5000));
    idx.refresh();
    expect(idx.get("src/api.ts")).toBe(before); // untouched file object reused
    expect(idx.findDefinitions("brandNewName")).toHaveLength(1);
    expect(idx.findDefinitions("isExpired")).toHaveLength(0);
  });

  it("only links distinctive, visible names", () => {
    const base = { line: 1, signature: "", exported: true } as const;
    expect(isLinkable({ ...base, name: "SessionStore", kind: "class" })).toBe(true);
    expect(isLinkable({ ...base, name: "parseRetryAfter", kind: "function" })).toBe(true);
    expect(isLinkable({ ...base, name: "type", kind: "function" })).toBe(false);
    expect(isLinkable({ ...base, name: "helper", kind: "function", exported: false })).toBe(false);
    expect(isLinkable({ ...base, name: "load", kind: "method" })).toBe(false);
    expect(isAuxiliary("tests/unit/x.test.ts")).toBe(true);
    expect(isAuxiliary("src/foo.spec.ts")).toBe(true);
    expect(isAuxiliary("src/index/repo-index.ts")).toBe(false);
  });
});

describe("hybrid search with embeddings", () => {
  it("fuses BM25 and embedding ranks, caches vectors, and falls back to BM25 on failure", async () => {
    const root = sampleRepo();
    let calls = 0;
    let inputs = 0;
    // Fake embedding model: a vector of keyword hits, so "token" queries match refreshSession.
    const vocab = ["expire", "refresh", "token", "pad", "route", "request"];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      calls++;
      const body = JSON.parse(init.body as string) as { input: string[] };
      inputs += body.input.length;
      return new Response(JSON.stringify({ data: body.input.map((t, index) => ({ index, embedding: vocab.map((w) => (t.toLowerCase().includes(w) ? 1 : 0.01)) })) }), { status: 200 });
    }) as unknown as typeof fetch;
    const svc = new RepoIndexService(root, { maxFiles: 100, cacheDir: tempDir(), embeddings: { baseUrl: "http://localhost:9/v1", model: "fake-embed" }, fetch: fakeFetch });
    svc.refresh(true);
    const r1 = await svc.search("token refresh", { limit: 3 });
    expect(r1.mode).toBe("hybrid");
    expect(r1.hits[0]!.symbol).toBe("refreshSession");
    const embeddedFirst = inputs;
    await svc.search("pad text", { limit: 3 });
    expect(inputs - embeddedFirst).toBe(1); // only the query: chunks were cached
    expect(calls).toBe(3);

    const broken = new RepoIndexService(root, { maxFiles: 100, cacheDir: tempDir(), embeddings: { baseUrl: "http://localhost:9/v1", model: "x" }, fetch: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch });
    const r2 = await broken.search("when do sessions expire", { limit: 3 });
    expect(r2.mode).toBe("bm25");
    expect(r2.note).toMatch(/embeddings unavailable/);
    expect(r2.hits[0]!.symbol).toBe("isExpired");
  });

  it("reciprocal rank fusion rewards items ranked well in both lists", () => {
    const s = reciprocalRankFusion([["a", "b", "c"], ["c", "a", "d"]]);
    expect([...s.entries()].sort((x, y) => y[1] - x[1])[0]![0]).toBe("a");
  });
});

describe("navigation tools", () => {
  const reg = createDefaultRegistry();
  function ctx(root: string, svc: RepoIndexService | null): ToolContext {
    return {
      workspace: new Workspace(root),
      fileState: new FileStateTracker(),
      plan: new PlanStore(),
      redactor: new SecretRedactor(),
      signal: new AbortController().signal,
      sessionId: "s",
      toolCallId: "c",
      settings: { commandTimeoutMs: 1000, maxOutputChars: 20_000, retainFullLogs: false, scrubEnv: true, logDir: join(root, ".logs") },
      repoIndex: svc,
    };
  }
  const run = async (name: string, args: unknown, c: ToolContext) => {
    const t = reg.get(name)!;
    return t.execute(t.schema.parse(args), c);
  };

  it("find_symbol lists definitions and usages with line numbers", async () => {
    const root = sampleRepo();
    const svc = new RepoIndexService(root, { maxFiles: 100, cacheDir: tempDir() });
    const r = await run("find_symbol", { name: "isExpired" }, ctx(root, svc));
    expect(r.output).toContain("src/session.ts:2  function  export function isExpired");
    expect(r.output).toContain("src/api.ts:1  import { isExpired");
    expect(r.output).toContain("src/api.ts:3    if (isExpired(session))".replace("    ", "  "));
    expect(r.output).not.toContain("src/session.ts:2  export function isExpired(session"); // definition line isn't a usage
    expect((await run("find_symbol", { name: "nope" }, ctx(root, svc))).output).toMatch(/No definition/);
  });

  it("code_search and repo_map return ranked, located results", async () => {
    const root = sampleRepo();
    const svc = new RepoIndexService(root, { maxFiles: 100, cacheDir: tempDir() });
    const s = await run("code_search", { query: "refresh the session token" }, ctx(root, svc));
    expect(s.output).toMatch(/ranked by BM25/);
    expect(s.output).toMatch(/1\. src\/session\.ts:5-\d+  refreshSession/);
    const scoped = await run("code_search", { query: "session", path: "src/util" }, ctx(root, svc));
    expect(scoped.output).not.toContain("src/session.ts");
    const m = await run("repo_map", { focus: ["src/routes.ts"] }, ctx(root, svc));
    expect(m.output.split("\n")[1]).toBe("src/routes.ts:");
  });

  it("explains itself when the index is disabled", async () => {
    const root = sampleRepo();
    expect((await run("code_search", { query: "x y" }, ctx(root, null))).output).toMatch(/disabled/);
  });
});

describe("session integration", () => {
  let h: Harness | undefined;
  afterEach(() => h?.cleanup());

  it("puts the map in the system prompt once and sees edits through the tools", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: "write_file", args: { path: "src/newmod.ts", content: "export function computeInvoiceTotal() { return 1; }\n" } }] },
      { toolCalls: [{ name: "find_symbol", args: { name: "computeInvoiceTotal" } }] },
      { content: "done" },
    ]);
    h = createHarness({ provider, files: { "src/session.ts": "export function isExpired(): boolean { return true; }\n" }, approve: () => "once" });
    await h.session.runtime.runTurn("add a function");
    const system = provider.requests[0]!.messages[0]!.content as string;
    expect(system).toContain("# Repository map");
    expect(system).toContain("src/session.ts:");
    // Same system prompt on every request (prompt cache stays warm).
    expect(provider.requests.every((r) => r.messages[0]!.content === system)).toBe(true);
    const findResult = h.session.context.messages().filter((m) => m.role === "tool").at(-1)!;
    expect(findResult.content).toContain("src/newmod.ts:1  function  export function computeInvoiceTotal");
  });
});

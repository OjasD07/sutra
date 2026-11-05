import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EmbeddingIndex, reciprocalRankFusion, type EmbeddingConfig } from "./embeddings.js";
import { RepoIndex, type Chunk, type IndexStats, type SearchHit } from "./repo-index.js";

export interface CodeSearchResult {
  hits: SearchHit[];
  mode: "bm25" | "hybrid";
  note?: string;
}

/**
 * Keeps a RepoIndex fresh for tools (cheap incremental refresh before each
 * query, throttled) and adds the optional embedding layer to code search.
 */
export class RepoIndexService {
  readonly index: RepoIndex;
  private lastRefresh = 0;
  private embeddings: EmbeddingIndex | null;

  constructor(
    readonly root: string,
    opts: { maxFiles: number; embeddings?: EmbeddingConfig; cacheDir: string; fetch?: typeof fetch },
  ) {
    this.index = new RepoIndex(root, { maxFiles: opts.maxFiles });
    this.embeddings = opts.embeddings ? new EmbeddingIndex(opts.embeddings, opts.cacheDir, opts.fetch) : null;
  }

  get embeddingModel(): string | null {
    return this.embeddings?.config.model ?? null;
  }

  /** The workspace may have changed (an edit or a command ran): refresh on next use. */
  markDirty(): void {
    this.lastRefresh = 0;
  }

  /** Re-scan for changes, at most every `minIntervalMs` (forced after edits). */
  refresh(force = false, minIntervalMs = 1500): IndexStats {
    if (!force && Date.now() - this.lastRefresh < minIntervalMs) return this.index.stats;
    this.lastRefresh = Date.now();
    return this.index.refresh();
  }

  private chunkTexts(chunks: Chunk[]): { chunk: Chunk; text: string }[] {
    const cache = new Map<string, string[]>();
    return chunks.map((chunk) => {
      let lines = cache.get(chunk.path);
      if (!lines) {
        try {
          lines = readFileSync(join(this.root, chunk.path), "utf8").split("\n");
        } catch {
          lines = [];
        }
        cache.set(chunk.path, lines);
      }
      const body = lines.slice(chunk.startLine - 1, chunk.endLine).join("\n").slice(0, 2000);
      return { chunk, text: `${chunk.path}${chunk.symbol ? ` · ${chunk.symbol}` : ""}\n${body}` };
    });
  }

  async search(query: string, opts: { limit: number; pathPrefix?: string; signal?: AbortSignal }): Promise<CodeSearchResult> {
    this.refresh();
    const lexical = this.index.search(query, { limit: Math.max(50, opts.limit), ...(opts.pathPrefix ? { pathPrefix: opts.pathPrefix } : {}) });
    if (!this.embeddings) return { hits: lexical.slice(0, opts.limit), mode: "bm25" };
    try {
      const chunks = this.index.allChunks().filter((c) => !opts.pathPrefix || c.path.startsWith(opts.pathPrefix));
      const withText = this.chunkTexts(chunks);
      const embedded = await this.embeddings.ensure(withText, opts.signal);
      const semantic = await this.embeddings.rank(query, withText, 50, opts.signal);
      const key = (h: { path: string; startLine: number }) => `${h.path}:${h.startLine}`;
      const fused = reciprocalRankFusion([lexical.map(key), semantic.map((s) => key(s.chunk))]);
      const byKey = new Map<string, SearchHit>();
      for (const h of lexical) byKey.set(key(h), h);
      for (const s of semantic)
        if (!byKey.has(key(s.chunk)))
          byKey.set(key(s.chunk), { path: s.chunk.path, startLine: s.chunk.startLine, endLine: s.chunk.endLine, ...(s.chunk.symbol ? { symbol: s.chunk.symbol } : {}), score: 0, preview: s.chunk.preview });
      const hits = [...fused.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, opts.limit)
        .map(([k, score]) => ({ ...byKey.get(k)!, score }));
      return { hits, mode: "hybrid", ...(embedded ? { note: `embedded ${embedded} new chunk(s) with ${this.embeddings.config.model}` } : {}) };
    } catch (err) {
      return { hits: lexical.slice(0, opts.limit), mode: "bm25", note: `embeddings unavailable (${(err as Error).message}); showing BM25 results` };
    }
  }
}

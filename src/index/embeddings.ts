import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Chunk } from "./repo-index.js";

export interface EmbeddingConfig {
  /** OpenAI-compatible base URL, e.g. http://localhost:11434/v1 (Ollama) or https://api.openai.com/v1. */
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Upper bound on chunks embedded per workspace (keeps first-run time and cost bounded). */
  maxChunks?: number;
}

/**
 * Optional semantic layer for code_search: chunk embeddings from any
 * OpenAI-compatible /embeddings endpoint, cached on disk by content hash so
 * unchanged code is never re-embedded. Off unless configured. Embedding
 * requests send code to the configured endpoint (use a local one, such as
 * Ollama, to keep code on your machine) and are not included in /cost.
 */
export class EmbeddingIndex {
  private vectors = new Map<string, Float32Array>();
  private dirty = false;
  private readonly cacheFile: string;

  constructor(
    readonly config: EmbeddingConfig,
    cacheDir: string,
    private readonly fetchFn: typeof fetch = globalThis.fetch,
  ) {
    const id = createHash("sha256").update(`${config.baseUrl}|${config.model}`).digest("hex").slice(0, 16);
    this.cacheFile = join(cacheDir, `embeddings-${id}.json`);
    this.load();
  }

  private load(): void {
    if (!existsSync(this.cacheFile)) return;
    try {
      const raw = JSON.parse(readFileSync(this.cacheFile, "utf8")) as Record<string, string>;
      for (const [k, b64] of Object.entries(raw)) {
        const buf = Buffer.from(b64, "base64");
        this.vectors.set(k, new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
      }
    } catch {
      /* corrupt cache: rebuild */
    }
  }

  save(): void {
    if (!this.dirty) return;
    mkdirSync(dirname(this.cacheFile), { recursive: true, mode: 0o700 });
    const out: Record<string, string> = {};
    for (const [k, v] of this.vectors) out[k] = Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
    writeFileSync(this.cacheFile, JSON.stringify(out), { mode: 0o600 });
    this.dirty = false;
  }

  get size(): number {
    return this.vectors.size;
  }

  private async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const res = await this.fetchFn(`${this.config.baseUrl.replace(/\/+$/, "")}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}) },
      body: JSON.stringify({ model: this.config.model, input: texts }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`embeddings endpoint returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { data?: { embedding: number[]; index?: number }[] };
    const data = [...(body.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (data.length !== texts.length) throw new Error(`embeddings endpoint returned ${data.length} vectors for ${texts.length} inputs`);
    return data.map((d) => normalise(Float32Array.from(d.embedding)));
  }

  /** Embed every chunk that isn't cached yet. Returns how many were embedded now. */
  async ensure(chunks: { chunk: Chunk; text: string }[], signal?: AbortSignal): Promise<number> {
    const max = this.config.maxChunks ?? 4000;
    const todo = chunks.slice(0, max).filter((c) => !this.vectors.has(contentKey(c.text)));
    for (let i = 0; i < todo.length; i += 32) {
      const batch = todo.slice(i, i + 32);
      const vecs = await this.embed(
        batch.map((b) => b.text),
        signal,
      );
      batch.forEach((b, j) => this.vectors.set(contentKey(b.text), vecs[j]!));
      this.dirty = true;
    }
    this.save();
    return todo.length;
  }

  async rank(query: string, chunks: { chunk: Chunk; text: string }[], limit: number, signal?: AbortSignal): Promise<{ chunk: Chunk; similarity: number }[]> {
    const [q] = await this.embed([query], signal);
    const scored: { chunk: Chunk; similarity: number }[] = [];
    for (const c of chunks) {
      const v = this.vectors.get(contentKey(c.text));
      if (v && v.length === q!.length) scored.push({ chunk: c.chunk, similarity: dot(q!, v) });
    }
    return scored.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
  }
}

export function contentKey(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

function normalise(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  const len = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i]! /= len;
  return v;
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/** Reciprocal-rank fusion of several ranked lists (keys must identify the same items). */
export function reciprocalRankFusion(lists: string[][], k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) list.forEach((key, rank) => scores.set(key, (scores.get(key) ?? 0) + 1 / (k + rank + 1)));
  return scores;
}

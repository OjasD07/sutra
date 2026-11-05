import { generateWithRetry } from "../providers/retry.js";
import type { ModelProvider, TokenUsage } from "../providers/types.js";

export interface AuxDeps {
  provider: ModelProvider;
  model: () => string;
  /** Records a harness-made request in the session's usage and cost; returns its cost. */
  recordUsage: (model: string, usage: TokenUsage | null, latencyMs: number) => number | null;
}

/**
 * Harness-owned model calls (task contract, finish-gate judge, alignment
 * review). Tool-free, thinking off, short output; every call is counted in
 * the session's cost, and `spent` lets the caller enforce a per-turn ceiling.
 */
export class AuxModel {
  spent = 0;
  calls = 0;
  constructor(
    private readonly d: AuxDeps,
    readonly ceilingUsd: number,
  ) {}

  get exhausted(): boolean {
    return this.spent >= this.ceilingUsd;
  }

  async text(system: string, user: string, opts: { maxTokens?: number; signal?: AbortSignal } = {}): Promise<string | null> {
    if (this.exhausted) return null;
    const model = this.d.model();
    const started = performance.now();
    let content = "";
    let usage: TokenUsage | null = null;
    for await (const ev of generateWithRetry(
      this.d.provider,
      { model, messages: [{ role: "system", content: system }, { role: "user", content: user }], thinking: "disabled", maxOutputTokens: opts.maxTokens ?? 1200 },
      { ...(opts.signal ? { signal: opts.signal } : {}) },
    )) {
      if (ev.type === "message_complete") {
        content = ev.message.content;
        usage = ev.usage;
      }
    }
    this.calls++;
    const cost = this.d.recordUsage(model, usage, performance.now() - started);
    this.spent += cost ?? 0;
    return content;
  }

  /** Ask for JSON; returns null when the reply can't be parsed. */
  async json<T>(system: string, user: string, opts: { maxTokens?: number; signal?: AbortSignal } = {}): Promise<T | null> {
    const raw = await this.text(`${system}\nReply with a single JSON object and nothing else.`, user, opts);
    return raw === null ? null : parseJsonLoose<T>(raw);
  }
}

/** Parse the first JSON object in a model reply (tolerates ```json fences and surrounding prose). */
export function parseJsonLoose<T>(raw: string): T | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1]! : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

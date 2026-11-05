import type { ModelPrice } from "../config/schema.js";
import type { TokenUsage } from "../providers/types.js";

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function isPeak(price: ModelPrice, at: Date): boolean {
  if (!price.peakWindowsUtc || !price.offPeak) return true;
  const day = at.getUTCDay();
  const mins = at.getUTCHours() * 60 + at.getUTCMinutes();
  return price.peakWindowsUtc.some((w) => w.days.includes(day) && mins >= minutes(w.start) && mins < minutes(w.end));
}

/**
 * Estimated request cost in USD. Returns null when no price is configured for
 * the model: Sutra reports "unknown" rather than guessing.
 */
export function estimateCost(usage: TokenUsage, price: ModelPrice | undefined, at = new Date()): number | null {
  if (!price) return null;
  const rates = isPeak(price, at) ? price : { ...price, ...price.offPeak };
  const cacheHit = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const cacheMiss = usage.inputTokens - cacheHit;
  return (cacheHit * rates.inputCacheHit + cacheMiss * rates.inputCacheMiss + usage.outputTokens * rates.output) / 1_000_000;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  requests: number;
  toolCalls: number;
  modelLatencyMs: number;
  toolLatencyMs: number;
  costUsd: number;
  /** True if any request had no configured price. */
  costIncomplete: boolean;
}

export const emptyTotals = (): UsageTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedInputTokens: 0,
  requests: 0,
  toolCalls: 0,
  modelLatencyMs: 0,
  toolLatencyMs: 0,
  costUsd: 0,
  costIncomplete: false,
});

export class UsageTracker {
  totals: UsageTotals;

  constructor(initial?: UsageTotals) {
    this.totals = initial ? { ...initial } : emptyTotals();
  }

  recordRequest(usage: TokenUsage | null, latencyMs: number, cost: number | null): void {
    const t = this.totals;
    t.requests += 1;
    t.modelLatencyMs += latencyMs;
    if (usage) {
      t.inputTokens += usage.inputTokens;
      t.outputTokens += usage.outputTokens;
      t.reasoningTokens += usage.reasoningTokens;
      t.cachedInputTokens += usage.cachedInputTokens;
    }
    if (cost === null) t.costIncomplete = true;
    else t.costUsd += cost;
  }

  recordTool(latencyMs: number): void {
    this.totals.toolCalls += 1;
    this.totals.toolLatencyMs += latencyMs;
  }
}

export function formatUsd(v: number): string {
  if (v === 0) return "$0.00";
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

import { describe, expect, it } from "vitest";
import { costReport } from "../../src/cli/commands.js";
import { DEFAULT_PRICING } from "../../src/config/pricing.js";
import { UsageTracker, estimateCost, formatUsd, isPeak } from "../../src/telemetry/cost.js";
import { testConfig } from "../helpers/harness.js";

const flash = DEFAULT_PRICING["deepseek-flash"]!;

describe("cost tracking", () => {
  it("prices cache hits, misses and output separately", () => {
    const offPeak = new Date("2026-11-07T12:00:00Z"); // Saturday
    const usage = { inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 100_000, reasoningTokens: 50_000 };
    // 0.4M * 0.003 + 0.6M * 0.15 + 0.1M * 0.6
    expect(estimateCost(usage, flash, offPeak)).toBeCloseTo(0.0012 + 0.09 + 0.06, 10);
  });

  it("applies peak windows (UTC, weekdays)", () => {
    expect(isPeak(flash, new Date("2026-11-05T02:30:00Z"))).toBe(true); // Thu 02:30
    expect(isPeak(flash, new Date("2026-11-05T05:00:00Z"))).toBe(false);
    expect(isPeak(flash, new Date("2026-11-05T09:59:00Z"))).toBe(true);
    expect(isPeak(flash, new Date("2026-11-05T10:00:00Z"))).toBe(false);
    expect(isPeak(flash, new Date("2026-11-08T02:30:00Z"))).toBe(false); // Sunday
    const u = { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
    expect(estimateCost(u, flash, new Date("2026-11-05T02:30:00Z"))).toBeCloseTo(0.3);
  });

  it("returns null without a configured price, and totals flag it", () => {
    const u = { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10, reasoningTokens: 0 };
    expect(estimateCost(u, undefined)).toBeNull();
    const t = new UsageTracker();
    t.recordRequest(u, 100, null);
    t.recordRequest(u, 50, 0.5);
    t.recordTool(20);
    expect(t.totals).toMatchObject({ requests: 2, inputTokens: 20, outputTokens: 20, costUsd: 0.5, costIncomplete: true, toolCalls: 1, modelLatencyMs: 150, toolLatencyMs: 20 });
  });

  it("renders the /cost report from real totals with pricing provenance", () => {
    const t = new UsageTracker();
    t.recordRequest({ inputTokens: 48_210, cachedInputTokens: 30_000, outputTokens: 12_840, reasoningTokens: 4000 }, 1000, 0.0123);
    const out = costReport(t.totals, testConfig(), "deepseek-flash");
    expect(out).toContain("48,210");
    expect(out).toContain("12,840");
    expect(out).toContain("$0.01");
    expect(out).toContain("as of 2026-11-05");
    expect(formatUsd(0.0012)).toBe("$0.0012");
  });
});

import type { ModelPrice } from "./schema.js";

/**
 * Default DeepSeek prices (USD per 1M tokens), copied from
 * https://api-docs.deepseek.com/quick_start/pricing on 2026-11-05.
 *
 * Prices change. These are defaults for estimation only and are always shown
 * with their `asOf` date. Override them in ~/.sutra/config.json under
 * `pricing.<model-id>`. Chinese public holidays (which DeepSeek bills at the
 * off-peak rate) are not modelled, so estimates may slightly overstate cost.
 */
const PEAK_WINDOWS = [
  { days: [1, 2, 3, 4, 5], start: "01:00", end: "04:00" },
  { days: [1, 2, 3, 4, 5], start: "06:00", end: "10:00" },
];
const SOURCE = "https://api-docs.deepseek.com/quick_start/pricing";
const AS_OF = "2026-11-05";

export const DEFAULT_PRICING: Record<string, ModelPrice> = {
  "deepseek-flash": {
    inputCacheHit: 0.006,
    inputCacheMiss: 0.3,
    output: 1.2,
    offPeak: { inputCacheHit: 0.003, inputCacheMiss: 0.15, output: 0.6 },
    peakWindowsUtc: PEAK_WINDOWS,
    currency: "USD",
    source: SOURCE,
    asOf: AS_OF,
  },
  "deepseek-v4-pro": {
    inputCacheHit: 0.044,
    inputCacheMiss: 1.32,
    output: 3.96,
    offPeak: { inputCacheHit: 0.022, inputCacheMiss: 0.66, output: 1.98 },
    peakWindowsUtc: PEAK_WINDOWS,
    currency: "USD",
    source: SOURCE,
    asOf: AS_OF,
  },
};

import { stableStringify } from "../../utils/text.js";

/**
 * Detects repetitive tool calls within a turn. A call signature is the tool
 * name plus canonicalised arguments plus the current "workspace epoch", which
 * advances whenever something may have changed the workspace (a write or a
 * command). Re-reading a file after editing it is therefore not a loop;
 * reading the same unchanged file five times is.
 */
export class LoopDetector {
  private counts = new Map<string, number>();
  private epoch = 0;
  private blocked = 0;

  constructor(
    private readonly maxRepeats = 3,
    private readonly maxBlocked = 3,
  ) {}

  advanceEpoch(): void {
    this.epoch++;
  }

  /** Returns true if this call should be refused as a loop. */
  check(name: string, args: unknown): boolean {
    let canonical: string;
    try {
      canonical = stableStringify(args);
    } catch {
      canonical = String(args);
    }
    const sig = `${this.epoch}|${name}|${canonical}`;
    const n = (this.counts.get(sig) ?? 0) + 1;
    this.counts.set(sig, n);
    if (n > this.maxRepeats) {
      this.blocked++;
      return true;
    }
    return false;
  }

  /** True once the model has kept looping after being told to stop. */
  get exhausted(): boolean {
    return this.blocked >= this.maxBlocked;
  }

  reset(): void {
    this.counts.clear();
    this.blocked = 0;
    this.epoch = 0;
  }
}

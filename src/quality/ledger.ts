import type { Hypothesis } from "./types.js";

/**
 * Harness-owned hypothesis ledger for difficult bugs: at most three open
 * explanations, each with where it points, what supports and contradicts it,
 * and the cheapest check that would tell it apart from the others. It is
 * evidence storage, not an essay: the finish gate and stall prompts read it.
 */
export class HypothesisLedger {
  private items: Hypothesis[] = [];
  private seq = 0;
  static readonly MAX_OPEN = 3;

  list(): Hypothesis[] {
    return this.items.map((h) => ({ ...h }));
  }

  open(): Hypothesis[] {
    return this.items.filter((h) => h.status === "open");
  }

  add(h: Omit<Hypothesis, "id" | "status">): Hypothesis {
    if (this.open().length >= HypothesisLedger.MAX_OPEN)
      throw new Error(`At most ${HypothesisLedger.MAX_OPEN} open hypotheses: confirm or reject one first (run its distinguishing check).`);
    const item: Hypothesis = { id: `H${++this.seq}`, status: "open", ...h };
    this.items.push(item);
    return item;
  }

  update(id: string, patch: Partial<Omit<Hypothesis, "id">>): Hypothesis {
    const h = this.items.find((x) => x.id.toLowerCase() === id.toLowerCase());
    if (!h) throw new Error(`No hypothesis ${id}. Current: ${this.items.map((x) => x.id).join(", ") || "none"}`);
    Object.assign(h, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
    return { ...h };
  }

  render(): string {
    if (!this.items.length) return "No hypotheses recorded.";
    return this.items
      .map((h) => {
        const mark = h.status === "confirmed" ? "✓" : h.status === "rejected" ? "✗" : "?";
        const parts = [`${mark} ${h.id} ${h.claim}`];
        if (h.location) parts.push(`   at: ${h.location}`);
        if (h.supports) parts.push(`   supports: ${h.supports}`);
        if (h.contradicts) parts.push(`   contradicts: ${h.contradicts}`);
        if (h.nextCheck && h.status === "open") parts.push(`   next check: ${h.nextCheck}`);
        return parts.join("\n");
      })
      .join("\n");
  }

  toJSON(): Hypothesis[] {
    return this.list();
  }

  restore(items: Hypothesis[]): void {
    this.items = items.map((h) => ({ ...h }));
    this.seq = items.reduce((m, h) => Math.max(m, Number(h.id.replace(/\D/g, "")) || 0), 0);
  }
}

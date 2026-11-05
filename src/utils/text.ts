import { createHash } from "node:crypto";

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Keep the beginning and end of long text; the middle is usually the least useful. */
export function truncateMiddle(text: string, max: number, note = ""): { text: string; truncated: boolean; omitted: number } {
  if (text.length <= max) return { text, truncated: false, omitted: 0 };
  const head = Math.floor(max * 0.4);
  const tail = max - head;
  const omitted = text.length - head - tail;
  const marker = `\n… [${omitted.toLocaleString("en-US")} characters omitted${note ? `; ${note}` : ""}] …\n`;
  return { text: text.slice(0, head) + marker + text.slice(text.length - tail), truncated: true, omitted };
}

export function isProbablyBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, 8000);
  if (sample.includes(0)) return true;
  let suspicious = 0;
  for (const b of sample) if (b < 7 || (b > 13 && b < 32)) suspicious++;
  return sample.length > 0 && suspicious / sample.length > 0.3;
}

export function countLines(s: string): number {
  if (s.length === 0) return 0;
  return s.split("\n").length - (s.endsWith("\n") ? 1 : 0);
}

/** Stable JSON stringify (sorted keys), used for loop-detection signatures. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${stableStringify(val)}`).join(",")}}`;
}

export function oneLine(s: string, max = 120): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

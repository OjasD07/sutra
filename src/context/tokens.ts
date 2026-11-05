import type { Message, ToolDefinition } from "../providers/types.js";

/**
 * Fast token estimate. Exact tokenizers are provider-specific; Sutra uses a
 * heuristic and calibrates it against the provider's reported prompt_tokens
 * after every request (see TokenEstimator.calibrate).
 */
export function roughTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++;
    else other++;
  }
  // ~3.6 chars/token for code & English; CJK/Devanagari closer to 1 token/char.
  return Math.ceil(ascii / 3.6 + other * 0.9);
}

export function messageChars(m: Message): string {
  switch (m.role) {
    case "assistant":
      return m.content + (m.reasoning ?? "") + (m.toolCalls ?? []).map((c) => c.name + c.arguments).join("");
    case "tool":
      return m.content;
    default:
      return m.content;
  }
}

export class TokenEstimator {
  /** Ratio actual/estimated from the last request, clamped. */
  private factor = 1;

  estimateMessages(messages: Message[], tools: ToolDefinition[] = []): number {
    let n = 0;
    for (const m of messages) n += roughTokens(messageChars(m)) + 4;
    if (tools.length) n += roughTokens(JSON.stringify(tools));
    return Math.ceil(n * this.factor);
  }

  estimateText(text: string): number {
    return Math.ceil(roughTokens(text) * this.factor);
  }

  calibrate(estimatedRaw: number, actual: number): void {
    if (estimatedRaw <= 0 || actual <= 0) return;
    const raw = actual / (estimatedRaw / this.factor);
    this.factor = Math.min(2.5, Math.max(0.4, raw));
  }

  get calibration(): number {
    return this.factor;
  }
}

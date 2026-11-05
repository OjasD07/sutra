import type { AssistantMessage, FinishReason, Message, ModelRequest, TokenUsage, ToolCall } from "../types.js";

/** DeepSeek / OpenAI chat-completions wire types (only the fields Sutra uses). */
export interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type WireMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; reasoning_content?: string; tool_calls?: WireToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface WireRequest {
  model: string;
  messages: WireMessage[];
  stream: true;
  stream_options: { include_usage: true };
  tools?: { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }[];
  max_tokens?: number;
  thinking?: { type: "enabled" | "disabled" };
  reasoning_effort?: "low" | "high" | "max";
  temperature?: number;
}

/**
 * Build a protocol-correct request body.
 *
 * DeepSeek thinking-mode rule (api-docs.deepseek.com/guides/thinking_mode):
 * when a request carries `tools`, the `reasoning_content` of every previous
 * assistant message must be passed back in full, or the API returns 400.
 * Without tools it is ignored, so we omit it to save bandwidth.
 */
export type WireDialect = "deepseek" | "openai";

export function buildWireRequest(req: ModelRequest, dialect: WireDialect = "deepseek"): WireRequest {
  const hasTools = !!req.tools && req.tools.length > 0;
  const deepseek = dialect === "deepseek";
  const body: WireRequest = {
    model: req.model,
    // Generic OpenAI-compatible servers have no reasoning_content field to echo back.
    messages: req.messages.map((m) => toWireMessage(m, hasTools && deepseek)),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (hasTools) {
    body.tools = req.tools!.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  if (req.maxOutputTokens !== undefined) body.max_tokens = req.maxOutputTokens;
  if (req.thinking && deepseek) {
    body.thinking = { type: req.thinking };
    if (req.thinking === "enabled" && req.reasoningEffort) body.reasoning_effort = req.reasoningEffort;
  }
  // temperature has no effect in thinking mode; only send it when meaningful.
  if ((req.thinking === "disabled" || !deepseek) && req.temperature !== undefined) body.temperature = req.temperature;
  return body;
}

export function toWireMessage(m: Message, includeReasoning: boolean): WireMessage {
  switch (m.role) {
    case "system":
    case "user":
      return { role: m.role, content: m.content };
    case "tool":
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    case "assistant": {
      const out: WireMessage = { role: "assistant", content: m.content };
      if (includeReasoning && m.reasoning !== undefined) out.reasoning_content = m.reasoning;
      if (m.toolCalls && m.toolCalls.length > 0) {
        out.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.arguments },
        }));
      }
      return out;
    }
  }
}

export interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
  completion_tokens_details?: { reasoning_tokens?: number } | null;
}

export function parseUsage(u: WireUsage | null | undefined): TokenUsage | null {
  if (!u) return null;
  return {
    inputTokens: u.prompt_tokens ?? 0,
    outputTokens: u.completion_tokens ?? 0,
    reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
    cachedInputTokens: u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0,
  };
}

export function mapFinishReason(r: string | null | undefined): FinishReason {
  switch (r) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    case "insufficient_system_resource":
      return "insufficient_resources";
    case "aborted":
      return "aborted";
    default:
      return "unknown";
  }
}

/** Accumulates streamed deltas into a complete assistant message. */
export class StreamAccumulator {
  private content = "";
  private reasoning: string | undefined;
  private calls = new Map<number, ToolCall>();

  appendContent(t: string): void {
    this.content += t;
  }
  appendReasoning(t: string): void {
    this.reasoning = (this.reasoning ?? "") + t;
  }
  /** Returns true when this delta opened a new tool call. */
  applyToolDelta(d: { index: number; id?: string; function?: { name?: string; arguments?: string } }): boolean {
    let call = this.calls.get(d.index);
    let opened = false;
    if (!call) {
      call = { id: d.id ?? "", name: d.function?.name ?? "", arguments: "" };
      this.calls.set(d.index, call);
      opened = true;
    } else {
      if (d.id) call.id = d.id;
      if (d.function?.name && !call.name) call.name = d.function.name;
    }
    if (d.function?.arguments) call.arguments += d.function.arguments;
    return opened;
  }
  getCall(index: number): ToolCall | undefined {
    return this.calls.get(index);
  }
  build(): AssistantMessage {
    const msg: AssistantMessage = { role: "assistant", content: this.content };
    if (this.reasoning !== undefined) msg.reasoning = this.reasoning;
    const calls = [...this.calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
    if (calls.length > 0) msg.toolCalls = calls;
    return msg;
  }
}

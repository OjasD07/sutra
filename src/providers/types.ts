/**
 * Provider-neutral model protocol.
 *
 * The agent runtime only speaks these types. Each provider adapter translates
 * them to and from its wire format, so no provider-specific field (for example
 * DeepSeek's `reasoning_content`) leaks into the runtime's control flow.
 */

export interface ToolCall {
  /** Provider-assigned call id. Every id must receive exactly one tool result. */
  id: string;
  name: string;
  /** Raw JSON argument text exactly as produced by the model. */
  arguments: string;
}

export interface SystemMessage {
  role: "system";
  content: string;
}

export interface UserMessage {
  role: "user";
  content: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: string;
  /**
   * Private chain-of-thought returned by thinking models. It is kept so that
   * protocol-correct continuations can be built (DeepSeek requires it to be
   * echoed back when tools are present), but it is never shown in normal UI
   * output or written to logs.
   */
  reasoning?: string;
  toolCalls?: ToolCall[];
}

export interface ToolMessage {
  role: "tool";
  toolCallId: string;
  name: string;
  content: string;
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export type ThinkingMode = "enabled" | "disabled";
export type ReasoningEffort = "low" | "high" | "max";

export interface ModelRequest {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  maxOutputTokens?: number;
  thinking?: ThinkingMode;
  reasoningEffort?: ReasoningEffort;
  /** Only honoured in non-thinking mode by most providers. */
  temperature?: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Subset of outputTokens spent on reasoning, when the provider reports it. */
  reasoningTokens: number;
  /** Subset of inputTokens served from the provider's prompt cache. */
  cachedInputTokens: number;
}

export type FinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "insufficient_resources"
  | "aborted"
  | "unknown";

export type ModelEvent =
  | { type: "text_delta"; text: string }
  /** Signals reasoning progress without exposing the reasoning text to UIs. */
  | { type: "reasoning_delta"; chars: number }
  | { type: "tool_call_start"; index: number; id: string; name: string }
  | { type: "tool_call_delta"; index: number; argumentsDelta: string }
  | {
      type: "message_complete";
      message: AssistantMessage;
      finishReason: FinishReason;
      usage: TokenUsage | null;
      model: string;
    };

export interface ModelInfo {
  id: string;
  contextWindow: number;
  maxOutputTokens: number;
  defaultOutputTokens: number;
  supportsTools: boolean;
  supportsThinking: boolean;
  /** Thinking mode cannot be combined with forced tool choice etc. */
  thinkingSupportsTools: boolean;
  supportsVision: boolean;
}

export interface ModelCapabilities {
  streaming: boolean;
  toolCalls: boolean;
  parallelToolCalls: boolean;
  thinking: boolean;
  promptCaching: boolean;
  models: ModelInfo[];
}

export interface ModelProvider {
  readonly id: string;
  readonly displayName: string;
  /** True for local inference, where requests have no per-token price. */
  readonly freeOfCharge?: boolean;
  getCapabilities(): ModelCapabilities;
  getModelInfo(model: string): ModelInfo;
  /**
   * Stream one model response. Implementations must emit exactly one
   * `message_complete` event on success and throw a `ProviderError` on failure.
   */
  generate(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent>;
  /** Optional cheap reachability check used by `sutra init`. */
  listModels?(signal?: AbortSignal): Promise<string[]>;
}

export const emptyUsage = (): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedInputTokens: 0,
});

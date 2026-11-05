import { ProviderError } from "../../src/providers/errors.js";
import { DEEPSEEK_MODELS } from "../../src/providers/deepseek/models.js";
import type { AssistantMessage, FinishReason, ModelCapabilities, ModelEvent, ModelInfo, ModelProvider, ModelRequest, TokenUsage } from "../../src/providers/types.js";

export interface ScriptStep {
  content?: string;
  reasoning?: string;
  toolCalls?: { id?: string; name: string; args: unknown | string }[];
  finish?: FinishReason;
  usage?: Partial<TokenUsage>;
  error?: ProviderError;
  /** Emit some text, then throw this error mid-stream. */
  failAfterText?: ProviderError;
  delayMs?: number;
}

type StepFn = (req: ModelRequest) => ScriptStep;

/**
 * Deterministic in-process provider for tests. It plays back scripted model
 * turns while the rest of Sutra (tools, permissions, persistence) runs for real.
 */
export class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  readonly displayName = "Scripted";
  requests: ModelRequest[] = [];
  private i = 0;

  constructor(private steps: (ScriptStep | StepFn)[], private info: ModelInfo = DEEPSEEK_MODELS["deepseek-flash"]!) {}

  getCapabilities(): ModelCapabilities {
    return { streaming: true, toolCalls: true, parallelToolCalls: true, thinking: true, promptCaching: true, models: [this.info] };
  }
  getModelInfo(): ModelInfo {
    return this.info;
  }

  get remaining(): number {
    return this.steps.length - this.i;
  }

  async *generate(req: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    this.requests.push(structuredClone(req));
    const raw = this.steps[this.i++];
    if (!raw) throw new Error(`ScriptedProvider: no step ${this.i} (request had ${req.messages.length} messages)`);
    const step = typeof raw === "function" ? raw(req) : raw;
    if (step.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, step.delayMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new ProviderError("cancelled", "aborted"));
        });
      });
    }
    if (step.error) throw step.error;
    if (step.reasoning) yield { type: "reasoning_delta", chars: step.reasoning.length };
    if (step.content) {
      for (const part of step.content.match(/.{1,16}/gs) ?? []) yield { type: "text_delta", text: part };
    }
    if (step.failAfterText) throw step.failAfterText;
    const msg: AssistantMessage = { role: "assistant", content: step.content ?? "" };
    if (step.reasoning !== undefined) msg.reasoning = step.reasoning;
    if (step.toolCalls?.length) {
      msg.toolCalls = step.toolCalls.map((c, idx) => ({
        id: c.id ?? `call_${this.i}_${idx}`,
        name: c.name,
        arguments: typeof c.args === "string" ? c.args : JSON.stringify(c.args),
      }));
      for (const [idx, c] of msg.toolCalls.entries()) yield { type: "tool_call_start", index: idx, id: c.id, name: c.name };
    }
    const usage: TokenUsage = { inputTokens: 1000, outputTokens: 100, reasoningTokens: 0, cachedInputTokens: 0, ...step.usage };
    yield { type: "message_complete", message: msg, finishReason: step.finish ?? (msg.toolCalls ? "tool_calls" : "stop"), usage, model: req.model };
  }
}

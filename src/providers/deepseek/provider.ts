import { ProviderError, classifyHttpStatus, parseRetryAfter, toProviderError } from "../errors.js";
import type { ModelCapabilities, ModelEvent, ModelInfo, ModelProvider, ModelRequest } from "../types.js";
import { StreamAccumulator, buildWireRequest, mapFinishReason, parseUsage, type WireUsage } from "./messages.js";
import { DEEPSEEK_MODELS, fallbackModelInfo } from "./models.js";
import { parseSse } from "./sse.js";

export interface DeepSeekOptions {
  apiKey: string;
  baseUrl?: string;
  /** Per-request timeout covering connection and the whole stream. */
  timeoutMs?: number;
  /** Max silence between stream chunks before the request is treated as stalled. */
  idleTimeoutMs?: number;
  models?: Record<string, Partial<ModelInfo>>;
  fetch?: typeof fetch;
}

interface ChunkDelta {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: { index: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }[];
}

interface Chunk {
  model?: string;
  choices?: { index: number; delta?: ChunkDelta; finish_reason?: string | null }[];
  usage?: WireUsage | null;
  error?: { message?: string };
}

/**
 * DeepSeek adapter using the OpenAI-compatible Chat Completions API.
 *
 * Implemented directly over fetch + SSE rather than through a generic SDK so
 * that DeepSeek-specific fields (`reasoning_content`, `thinking`,
 * `prompt_cache_hit_tokens`) are handled exactly as documented, and so retry
 * classification stays under Sutra's control.
 */
export class DeepSeekProvider implements ModelProvider {
  readonly id = "deepseek";
  readonly displayName = "DeepSeek";
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly models: Record<string, ModelInfo>;
  private readonly fetchFn: typeof fetch;

  constructor(opts: DeepSeekOptions) {
    if (!opts.apiKey) throw new ProviderError("authentication", "DEEPSEEK_API_KEY is not set");
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://api.deepseek.com").replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 15 * 60_000;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 5 * 60_000;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.models = { ...DEEPSEEK_MODELS };
    for (const [id, info] of Object.entries(opts.models ?? {})) {
      this.models[id] = { ...(this.models[id] ?? fallbackModelInfo(id)), ...info, id };
    }
  }

  getCapabilities(): ModelCapabilities {
    return {
      streaming: true,
      toolCalls: true,
      parallelToolCalls: true,
      thinking: true,
      promptCaching: true,
      models: Object.values(this.models),
    };
  }

  getModelInfo(model: string): ModelInfo {
    return this.models[model] ?? fallbackModelInfo(model);
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const res = await this.request("/models", { method: "GET" }, signal);
    const body = (await res.json()) as { data?: { id: string }[] };
    return (body.data ?? []).map((m) => m.id);
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.fetchFn(this.baseUrl + path, {
        ...init,
        signal: combined,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          accept: init.method === "GET" ? "application/json" : "text/event-stream",
        },
      });
    } catch (err) {
      if (timeout.aborted && !signal?.aborted) throw new ProviderError("timeout", "Request timed out", { cause: err });
      throw toProviderError(err, signal);
    }
    if (!res.ok) {
      let detail = "";
      try {
        const text = await res.text();
        const parsed = JSON.parse(text) as { error?: { message?: string } };
        detail = parsed.error?.message ?? text;
      } catch {
        /* body unreadable */
      }
      throw new ProviderError(classifyHttpStatus(res.status), `DeepSeek API ${res.status}: ${detail || res.statusText}`.slice(0, 600), {
        status: res.status,
        retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
      });
    }
    return res;
  }

  async *generate(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    const body = buildWireRequest(request);
    const res = await this.request("/chat/completions", { method: "POST", body: JSON.stringify(body) }, signal);
    if (!res.body) throw new ProviderError("protocol", "Response has no body");

    const acc = new StreamAccumulator();
    let finish: string | null | undefined;
    let usage: WireUsage | null | undefined;
    let model = request.model;
    let sawDone = false;
    let yielded = false;

    const idle = new IdleWatchdog(this.idleTimeoutMs);
    const bodyStream = idle.wrap(res.body as unknown as AsyncIterable<Uint8Array>);

    try {
      for await (const ev of parseSse(bodyStream)) {
        if (ev.data === "[DONE]") {
          sawDone = true;
          break;
        }
        let chunk: Chunk;
        try {
          chunk = JSON.parse(ev.data) as Chunk;
        } catch {
          throw new ProviderError("protocol", "Malformed stream chunk", { partial: yielded });
        }
        if (chunk.error) throw new ProviderError("server_error", chunk.error.message ?? "Stream error", { partial: yielded });
        if (chunk.model) model = chunk.model;
        if (chunk.usage) usage = chunk.usage;
        for (const choice of chunk.choices ?? []) {
          const d = choice.delta;
          if (d?.reasoning_content) {
            acc.appendReasoning(d.reasoning_content);
            yielded = true;
            yield { type: "reasoning_delta", chars: d.reasoning_content.length };
          }
          if (d?.content) {
            acc.appendContent(d.content);
            yielded = true;
            yield { type: "text_delta", text: d.content };
          }
          for (const tc of d?.tool_calls ?? []) {
            const opened = acc.applyToolDelta(tc);
            const call = acc.getCall(tc.index)!;
            yielded = true;
            if (opened) yield { type: "tool_call_start", index: tc.index, id: call.id, name: call.name };
            if (tc.function?.arguments) yield { type: "tool_call_delta", index: tc.index, argumentsDelta: tc.function.arguments };
          }
          if (choice.finish_reason) finish = choice.finish_reason;
        }
      }
    } catch (err) {
      if (idle.fired && !signal?.aborted)
        throw new ProviderError("stream_interrupted", "Stream stalled", { partial: yielded, cause: err });
      throw toProviderError(err, signal, yielded);
    } finally {
      idle.stop();
    }

    if (!sawDone && !finish) {
      throw new ProviderError("stream_interrupted", "Stream ended before completion", { partial: yielded });
    }
    const message = acc.build();
    // Some OpenAI-compatible servers omit ids; give every call a stable id so
    // each one can be paired with exactly one tool result.
    message.toolCalls?.forEach((c, i) => {
      if (!c.id) c.id = `call_${Date.now().toString(36)}_${i}`;
    });
    yield { type: "message_complete", message, finishReason: mapFinishReason(finish), usage: parseUsage(usage), model };
  }
}

/** Fails a stream that goes silent for too long (keep-alives count as activity). */
class IdleWatchdog {
  fired = false;
  private timer: NodeJS.Timeout | undefined;
  constructor(private readonly ms: number) {}

  async *wrap(src: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
    const it = src[Symbol.asyncIterator]();
    while (true) {
      const next = await new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
        this.timer = setTimeout(() => {
          this.fired = true;
          void it.return?.();
          reject(new Error("idle timeout"));
        }, this.ms);
        it.next().then(resolve, reject);
      }).finally(() => clearTimeout(this.timer));
      if (next.done) return;
      yield next.value;
    }
  }
  stop(): void {
    clearTimeout(this.timer);
  }
}

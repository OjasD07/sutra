import { ProviderError, classifyHttpStatus, parseRetryAfter, toProviderError } from "../errors.js";
import type { ModelCapabilities, ModelEvent, ModelInfo, ModelProvider, ModelRequest } from "../types.js";
import { StreamAccumulator, buildWireRequest, mapFinishReason, parseUsage, type WireDialect, type WireUsage } from "../deepseek/messages.js";
import { fallbackModelInfo } from "../deepseek/models.js";
import { parseSse } from "../deepseek/sse.js";

export interface OpenAICompatibleOptions {
  id: string;
  displayName: string;
  /** Optional: local servers such as Ollama need none. */
  apiKey?: string;
  baseUrl: string;
  /** "deepseek" adds thinking fields and echoes reasoning_content; "openai" sends plain Chat Completions. */
  dialect: WireDialect;
  /** Built-in model metadata for this endpoint. */
  knownModels?: Record<string, ModelInfo>;
  /** Requests cost nothing (local inference). */
  freeOfCharge?: boolean;
  /** Per-request timeout covering connection and the whole stream. */
  timeoutMs?: number;
  /** Max silence between stream chunks before the request is treated as stalled. */
  idleTimeoutMs?: number;
  models?: Record<string, Partial<ModelInfo>>;
  /** Context window assumed for models with no metadata. */
  defaultContextWindow?: number;
  /** Extra headers on every request (for example OpenRouter's app attribution). */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

export interface ModelDetails {
  id: string;
  name?: string;
  contextWindow?: number;
  /** USD per 1M tokens, when the server publishes prices. */
  pricePerM?: { input: number; output: number; cachedInput: number };
  /** Whether the model accepts tool definitions, when the server says. */
  tools?: boolean;
}

interface RawModel {
  id: string;
  name?: string;
  context_length?: number;
  context_window?: number;
  pricing?: { prompt?: string | number; completion?: string | number; input_cache_read?: string | number };
  supported_parameters?: string[];
}

interface ChunkDelta {
  content?: string | null;
  reasoning_content?: string | null;
  /** Ollama / OpenRouter name for streamed reasoning. */
  reasoning?: string | null;
  tool_calls?: { index: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }[];
}

interface Chunk {
  model?: string;
  choices?: { index: number; delta?: ChunkDelta; finish_reason?: string | null }[];
  usage?: WireUsage | null;
  error?: { message?: string };
}

/**
 * Adapter for any OpenAI-compatible Chat Completions endpoint: DeepSeek,
 * OpenAI, Ollama, vLLM, LM Studio, llama.cpp server, OpenRouter, ...
 *
 * Implemented directly over fetch + SSE rather than through a generic SDK so
 * provider-specific fields (`reasoning_content`, `thinking`,
 * `prompt_cache_hit_tokens`) are handled exactly as documented, and so retry
 * classification stays under Sutra's control.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  readonly displayName: string;
  readonly freeOfCharge: boolean;
  readonly dialect: WireDialect;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly models: Record<string, ModelInfo>;
  private readonly fetchFn: typeof fetch;
  private readonly extraHeaders: Record<string, string>;

  constructor(opts: OpenAICompatibleOptions) {
    this.id = opts.id;
    this.displayName = opts.displayName;
    this.dialect = opts.dialect;
    this.freeOfCharge = opts.freeOfCharge ?? false;
    this.apiKey = opts.apiKey || undefined;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 15 * 60_000;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 5 * 60_000;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.extraHeaders = opts.headers ?? {};
    this.defaultContextWindow = opts.defaultContextWindow;
    this.models = { ...(opts.knownModels ?? {}) };
    for (const [id, info] of Object.entries(opts.models ?? {})) {
      this.models[id] = { ...(this.models[id] ?? this.fallback(id)), ...info, id };
    }
  }

  getCapabilities(): ModelCapabilities {
    return {
      streaming: true,
      toolCalls: true,
      parallelToolCalls: true,
      thinking: this.dialect === "deepseek",
      promptCaching: this.dialect === "deepseek",
      models: Object.values(this.models),
    };
  }

  private readonly defaultContextWindow: number | undefined;

  private fallback(id: string): ModelInfo {
    const base = fallbackModelInfo(id);
    return this.defaultContextWindow ? { ...base, contextWindow: this.defaultContextWindow } : base;
  }

  getModelInfo(model: string): ModelInfo {
    return this.models[model] ?? this.fallback(model);
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    return (await this.listModelDetails(signal)).map((m) => m.id);
  }

  /**
   * The server's model list with whatever metadata it gives. OpenRouter (and
   * some others) include context length, per-token prices and the request
   * parameters each model supports; plain OpenAI-style servers give only ids.
   */
  async listModelDetails(signal?: AbortSignal): Promise<ModelDetails[]> {
    const res = await this.request("/models", { method: "GET" }, signal);
    const body = (await res.json()) as { data?: RawModel[] } | RawModel[];
    const list = Array.isArray(body) ? body : (body.data ?? []);
    return list.filter((m) => typeof m?.id === "string").map((m) => {
      const perM = (v: unknown) => (v === undefined || v === null || v === "" || Number.isNaN(Number(v)) ? undefined : Number(v) * 1e6);
      const input = perM(m.pricing?.prompt);
      const output = perM(m.pricing?.completion);
      return {
        id: m.id,
        ...(m.name ? { name: m.name } : {}),
        ...(typeof m.context_length === "number" ? { contextWindow: m.context_length } : typeof m.context_window === "number" ? { contextWindow: m.context_window } : {}),
        ...(input !== undefined && output !== undefined ? { pricePerM: { input, output, cachedInput: perM(m.pricing?.input_cache_read) ?? input } } : {}),
        ...(Array.isArray(m.supported_parameters) ? { tools: m.supported_parameters.includes("tools") } : {}),
      };
    });
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
          ...this.extraHeaders,
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
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
      throw new ProviderError(classifyHttpStatus(res.status), `${this.displayName} API ${res.status}: ${detail || res.statusText}`.slice(0, 600), {
        status: res.status,
        retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
      });
    }
    return res;
  }

  async *generate(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    const body = buildWireRequest(request, this.dialect);
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
          const reasoning = d?.reasoning_content ?? d?.reasoning;
          if (reasoning) {
            acc.appendReasoning(reasoning);
            yielded = true;
            yield { type: "reasoning_delta", chars: reasoning.length };
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

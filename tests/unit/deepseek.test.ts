import { describe, expect, it } from "vitest";
import { buildWireRequest, parseUsage } from "../../src/providers/deepseek/messages.js";
import { DeepSeekProvider } from "../../src/providers/deepseek/provider.js";
import { parseSse } from "../../src/providers/deepseek/sse.js";
import { ProviderError, classifyHttpStatus, parseRetryAfter } from "../../src/providers/errors.js";
import { backoffDelay, defaultRetryPolicy, generateWithRetry } from "../../src/providers/retry.js";
import type { Message, ModelEvent, ModelRequest } from "../../src/providers/types.js";

const enc = new TextEncoder();

function streamOf(parts: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(enc.encode(p));
      c.close();
    },
  });
}

function sse(chunks: unknown[], opts: { keepAlive?: boolean; done?: boolean } = {}): string[] {
  const out: string[] = [];
  if (opts.keepAlive) out.push(": keep-alive\n\n");
  for (const c of chunks) out.push(`data: ${JSON.stringify(c)}\n\n`);
  if (opts.done !== false) out.push("data: [DONE]\n\n");
  return out;
}

const chunk = (delta: Record<string, unknown>, finish: string | null = null, usage: unknown = null) => ({
  id: "x",
  object: "chat.completion.chunk",
  model: "deepseek-flash",
  choices: [{ index: 0, delta, finish_reason: finish }],
  usage,
});

interface Captured {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function mockFetch(responses: (Response | ((c: Captured) => Response) | Error)[], captured: Captured[] = []): typeof fetch {
  let i = 0;
  return (async (url: string, init: RequestInit) => {
    const c: Captured = { url, body: init.body ? JSON.parse(init.body as string) : {}, headers: init.headers as Record<string, string> };
    captured.push(c);
    const r = responses[i++];
    if (!r) throw new Error("no more responses");
    if (r instanceof Error) throw r;
    if (init.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    return typeof r === "function" ? r(c) : r;
  }) as unknown as typeof fetch;
}

const okStream = (parts: string[]) => new Response(streamOf(parts), { status: 200, headers: { "content-type": "text/event-stream" } });

async function collect(it: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const baseReq = (messages: Message[], extra: Partial<ModelRequest> = {}): ModelRequest => ({ model: "deepseek-flash", messages, ...extra });
const tools = [{ name: "read_file", description: "read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];

describe("DeepSeek message construction", () => {
  it("builds a streaming request with thinking and tools", () => {
    const body = buildWireRequest(baseReq([{ role: "user", content: "hi" }], { tools, thinking: "enabled", reasoningEffort: "high", maxOutputTokens: 1000, temperature: 0.2 }));
    expect(body).toMatchObject({
      model: "deepseek-flash",
      stream: true,
      stream_options: { include_usage: true },
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      max_tokens: 1000,
      tools: [{ type: "function", function: { name: "read_file", description: "read" } }],
    });
    // temperature has no effect in thinking mode and is not sent
    expect(body).not.toHaveProperty("temperature");
  });

  it("sends temperature only when thinking is disabled", () => {
    const body = buildWireRequest(baseReq([{ role: "user", content: "hi" }], { thinking: "disabled", temperature: 0.2, reasoningEffort: "high" }));
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.temperature).toBe(0.2);
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("passes reasoning_content back on every assistant message when tools are present", () => {
    const history: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "turn 1" },
      { role: "assistant", content: "", reasoning: "r1", toolCalls: [{ id: "c1", name: "read_file", arguments: '{"path":"a"}' }] },
      { role: "tool", toolCallId: "c1", name: "read_file", content: "data" },
      { role: "assistant", content: "answer 1", reasoning: "r2" }, // a turn with no tool call
      { role: "user", content: "turn 2" },
    ];
    const body = buildWireRequest(baseReq(history, { tools, thinking: "enabled" }));
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "turn 1" },
      { role: "assistant", content: "", reasoning_content: "r1", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }] },
      { role: "tool", tool_call_id: "c1", content: "data" },
      { role: "assistant", content: "answer 1", reasoning_content: "r2" },
      { role: "user", content: "turn 2" },
    ]);
  });

  it("omits reasoning_content when no tools are sent (the API ignores it)", () => {
    const body = buildWireRequest(baseReq([{ role: "user", content: "a" }, { role: "assistant", content: "b", reasoning: "r" }, { role: "user", content: "c" }]));
    expect(body.messages[1]).toEqual({ role: "assistant", content: "b" });
    expect(body).not.toHaveProperty("tools");
  });

  it("parses usage including cache hits and reasoning tokens", () => {
    expect(
      parseUsage({ prompt_tokens: 100, completion_tokens: 50, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40, completion_tokens_details: { reasoning_tokens: 30 } }),
    ).toEqual({ inputTokens: 100, outputTokens: 50, cachedInputTokens: 60, reasoningTokens: 30 });
    expect(parseUsage({ prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } })!.cachedInputTokens).toBe(4);
    expect(parseUsage(null)).toBeNull();
  });
});

describe("SSE parsing", () => {
  it("handles keep-alive comments, CRLF, split lines and split UTF-8", async () => {
    const payload = 'data: {"t":"सूत्र"}\r\n\r\n';
    const bytes = enc.encode(": keep-alive\n\n" + payload + "data: [DONE]\n\n");
    const parts: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 3) parts.push(bytes.slice(i, i + 3)); // split mid-codepoint
    async function* gen() {
      for (const p of parts) yield p;
    }
    const events = [];
    for await (const e of parseSse(gen())) events.push(e.data);
    expect(events).toEqual(['{"t":"सूत्र"}', "[DONE]"]);
  });

  it("joins multi-line data fields", async () => {
    async function* gen() {
      yield enc.encode("data: a\ndata: b\n\n");
    }
    const out = [];
    for await (const e of parseSse(gen())) out.push(e.data);
    expect(out).toEqual(["a\nb"]);
  });
});

describe("DeepSeek streaming", () => {
  it("assembles reasoning, text and multiple streamed tool calls", async () => {
    const parts = sse(
      [
        chunk({ role: "assistant", reasoning_content: "Let me " }),
        chunk({ reasoning_content: "think." }),
        chunk({ content: "Reading " }),
        chunk({ content: "files." }),
        chunk({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "read_file", arguments: '{"pa' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] }),
        chunk({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "read_file", arguments: '{"path":"b.ts"}' } }] }),
        chunk({ content: "" }, "tool_calls", { prompt_tokens: 120, completion_tokens: 40, prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 20, completion_tokens_details: { reasoning_tokens: 12 } }),
      ],
      { keepAlive: true },
    );
    const captured: Captured[] = [];
    const p = new DeepSeekProvider({ apiKey: "sk-test", fetch: mockFetch([okStream(parts)], captured) });
    const events = await collect(p.generate(baseReq([{ role: "user", content: "x" }], { tools, thinking: "enabled" })));
    expect(captured[0]!.url).toBe("https://api.deepseek.com/chat/completions");
    expect(captured[0]!.headers.authorization).toBe("Bearer sk-test");
    const done = events.find((e) => e.type === "message_complete");
    expect(done).toBeDefined();
    if (done?.type !== "message_complete") throw new Error();
    expect(done.message).toEqual({
      role: "assistant",
      content: "Reading files.",
      reasoning: "Let me think.",
      toolCalls: [
        { id: "call_a", name: "read_file", arguments: '{"path":"a.ts"}' },
        { id: "call_b", name: "read_file", arguments: '{"path":"b.ts"}' },
      ],
    });
    expect(done.finishReason).toBe("tool_calls");
    expect(done.usage).toEqual({ inputTokens: 120, outputTokens: 40, cachedInputTokens: 100, reasoningTokens: 12 });
    // Reasoning text is not exposed in events, only its length.
    expect(events.filter((e) => e.type === "reasoning_delta").map((e) => (e as { chars: number }).chars)).toEqual([7, 6]);
    expect(events.filter((e) => e.type === "tool_call_start")).toHaveLength(2);
  });

  it("builds a protocol-correct continuation after a tool call", async () => {
    const captured: Captured[] = [];
    const first = sse([
      chunk({ reasoning_content: "need file" }),
      chunk({ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }] }, "tool_calls", { prompt_tokens: 1, completion_tokens: 1 }),
    ]);
    const second = sse([chunk({ content: "done" }, "stop", { prompt_tokens: 2, completion_tokens: 1 })]);
    const p = new DeepSeekProvider({ apiKey: "k", fetch: mockFetch([okStream(first), okStream(second)], captured) });
    const msgs: Message[] = [{ role: "user", content: "go" }];
    for await (const e of p.generate(baseReq(msgs, { tools, thinking: "enabled" }))) if (e.type === "message_complete") msgs.push(e.message);
    msgs.push({ role: "tool", toolCallId: "c1", name: "read_file", content: "contents" });
    await collect(p.generate(baseReq(msgs, { tools, thinking: "enabled" })));
    const sent = captured[1]!.body.messages as Record<string, unknown>[];
    expect(sent[1]).toEqual({
      role: "assistant",
      content: "",
      reasoning_content: "need file",
      tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }],
    });
    expect(sent[2]).toEqual({ role: "tool", tool_call_id: "c1", content: "contents" });
  });

  it("treats a stream that ends without [DONE] or finish_reason as interrupted", async () => {
    const p = new DeepSeekProvider({ apiKey: "k", fetch: mockFetch([okStream(sse([chunk({ content: "par" })], { done: false }))]) });
    await expect(collect(p.generate(baseReq([{ role: "user", content: "x" }])))).rejects.toMatchObject({ kind: "stream_interrupted", partial: true });
  });

  it("maps HTTP errors to typed provider errors", async () => {
    const mk = (status: number, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify({ error: { message: `err ${status}` } }), { status, headers });
    for (const [status, kind, retryable] of [
      [400, "invalid_request", false],
      [401, "authentication", false],
      [402, "insufficient_balance", false],
      [422, "invalid_request", false],
      [429, "rate_limited", true],
      [500, "server_error", true],
      [503, "overloaded", true],
    ] as const) {
      const p = new DeepSeekProvider({ apiKey: "k", fetch: mockFetch([mk(status, { "retry-after": "2" })]) });
      const err = await collect(p.generate(baseReq([{ role: "user", content: "x" }]))).catch((e) => e as ProviderError);
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).kind).toBe(kind);
      expect((err as ProviderError).retryable).toBe(retryable);
      expect((err as ProviderError).message).toContain(`err ${status}`);
      expect((err as ProviderError).retryAfterMs).toBe(2000);
    }
  });

  it("cancels an in-flight request", async () => {
    const ac = new AbortController();
    const slow = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(`data: ${JSON.stringify(chunk({ content: "a" }))}\n\n`));
        ac.signal.addEventListener("abort", () => c.error(Object.assign(new Error("aborted"), { name: "AbortError" })));
      },
    });
    const p = new DeepSeekProvider({ apiKey: "k", fetch: mockFetch([new Response(slow, { status: 200 })]) });
    const it = p.generate(baseReq([{ role: "user", content: "x" }]), ac.signal)[Symbol.asyncIterator]();
    await it.next();
    ac.abort();
    await expect(it.next()).rejects.toMatchObject({ kind: "cancelled" });
  });

  it("times out a stalled stream", async () => {
    const stalled = new ReadableStream<Uint8Array>({ start() {} });
    const p = new DeepSeekProvider({ apiKey: "k", idleTimeoutMs: 50, fetch: mockFetch([new Response(stalled, { status: 200 })]) });
    await expect(collect(p.generate(baseReq([{ role: "user", content: "x" }])))).rejects.toMatchObject({ kind: "stream_interrupted" });
  });
});

describe("retry classification", () => {
  it("classifies HTTP statuses", () => {
    expect(classifyHttpStatus(429)).toBe("rate_limited");
    expect(classifyHttpStatus(502)).toBe("server_error");
    expect(classifyHttpStatus(401)).toBe("authentication");
    expect(new ProviderError("insufficient_balance", "x").retryable).toBe(false);
    expect(new ProviderError("network", "x").retryable).toBe(true);
    expect(new ProviderError("cancelled", "x").retryable).toBe(false);
  });

  it("parses Retry-After seconds and dates", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4000)).toBe(6000);
    expect(parseRetryAfter(null)).toBeUndefined();
  });

  it("uses Retry-After when present and capped exponential backoff otherwise", () => {
    expect(backoffDelay(defaultRetryPolicy, 1, new ProviderError("rate_limited", "x", { retryAfterMs: 5000 }))).toBe(5000);
    const d = backoffDelay(defaultRetryPolicy, 10, new ProviderError("server_error", "x"), () => 1);
    expect(d).toBe(defaultRetryPolicy.maxDelayMs);
  });

  it("retries transient failures before output, never after", async () => {
    const good = okStream(sse([chunk({ content: "hi" }, "stop", { prompt_tokens: 1, completion_tokens: 1 })]));
    const err503 = new Response("{}", { status: 503 });
    const p = new DeepSeekProvider({ apiKey: "k", fetch: mockFetch([err503, new TypeError("fetch failed"), good]) });
    const retries: number[] = [];
    const events = await collect(generateWithRetry(p, baseReq([{ role: "user", content: "x" }]), { onRetry: (n) => retries.push(n.attempt), sleepFn: async () => {} }));
    expect(retries).toEqual([1, 2]);
    expect(events.at(-1)?.type).toBe("message_complete");

    const p401 = new DeepSeekProvider({ apiKey: "k", fetch: mockFetch([new Response("{}", { status: 401 })]) });
    const r2: number[] = [];
    await expect(collect(generateWithRetry(p401, baseReq([{ role: "user", content: "x" }]), { onRetry: (n) => r2.push(n.attempt), sleepFn: async () => {} }))).rejects.toMatchObject({
      kind: "authentication",
    });
    expect(r2).toEqual([]);

    const partial = new DeepSeekProvider({ apiKey: "k", fetch: mockFetch([okStream(sse([chunk({ content: "par" })], { done: false })), good]) });
    await expect(collect(generateWithRetry(partial, baseReq([{ role: "user", content: "x" }]), { sleepFn: async () => {} }))).rejects.toMatchObject({ partial: true });
  });

  it("gives up after maxRetries", async () => {
    const p = new DeepSeekProvider({ apiKey: "k", fetch: mockFetch(Array.from({ length: 5 }, () => new Response("{}", { status: 500 }))) });
    const retries: number[] = [];
    await expect(
      collect(generateWithRetry(p, baseReq([{ role: "user", content: "x" }]), { policy: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1 }, onRetry: (n) => retries.push(n.attempt), sleepFn: async () => {} })),
    ).rejects.toMatchObject({ kind: "server_error" });
    expect(retries).toEqual([1, 2]);
  });
});

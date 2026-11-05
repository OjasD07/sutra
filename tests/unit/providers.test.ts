import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, ollamaUrl } from "../../src/config/load.js";
import { buildWireRequest } from "../../src/providers/deepseek/messages.js";
import { OpenAICompatibleProvider } from "../../src/providers/openai-compatible/provider.js";
import { createProvider, providerNeedsKey } from "../../src/providers/registry.js";
import type { Message, ModelEvent } from "../../src/providers/types.js";
import { createHarness, tempDir, testConfig, type Harness } from "../helpers/harness.js";
import { ScriptedProvider } from "../helpers/scripted-provider.js";

const enc = new TextEncoder();
const sse = (chunks: unknown[]) =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(`data: ${JSON.stringify(ch)}\n\n`));
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    }),
    { status: 200 },
  );
const chunk = (delta: Record<string, unknown>, finish: string | null = null, usage: unknown = null) => ({ choices: [{ index: 0, delta, finish_reason: finish }], usage });

let h: Harness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

describe("OpenAI-compatible provider", () => {
  const history: Message[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "", reasoning: "r", toolCalls: [{ id: "c1", name: "read_file", arguments: "{}" }] },
    { role: "tool", toolCallId: "c1", name: "read_file", content: "x" },
  ];
  const tools = [{ name: "read_file", description: "d", parameters: { type: "object" } }];

  it("sends plain Chat Completions: no DeepSeek thinking fields, no reasoning_content", () => {
    const body = buildWireRequest({ model: "qwen3-coder", messages: history, tools, thinking: "enabled", reasoningEffort: "high", temperature: 0.2 }, "openai");
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body.temperature).toBe(0.2);
    expect(body.messages[1]).not.toHaveProperty("reasoning_content");
    expect(body.messages[1]).toMatchObject({ tool_calls: [{ id: "c1" }] });
  });

  it("streams from a local server without an API key and reads Ollama-style reasoning", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string> });
      return sse([chunk({ reasoning: "think" }), chunk({ content: "ok" }), chunk({}, "stop", { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } })]);
    }) as unknown as typeof fetch;
    const p = new OpenAICompatibleProvider({ id: "ollama", displayName: "Ollama", baseUrl: "http://localhost:11434/v1/", dialect: "openai", freeOfCharge: true, defaultContextWindow: 32_768, fetch: fetchFn });
    const events: ModelEvent[] = [];
    for await (const e of p.generate({ model: "qwen3-coder", messages: [{ role: "user", content: "x" }] })) events.push(e);
    expect(seen[0]!.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(seen[0]!.headers).not.toHaveProperty("authorization");
    const done = events.find((e) => e.type === "message_complete");
    expect(done).toMatchObject({ message: { content: "ok", reasoning: "think" }, usage: { inputTokens: 12, cachedInputTokens: 4 } });
    expect(p.getModelInfo("anything").contextWindow).toBe(32_768);
    expect(p.getCapabilities().thinking).toBe(false);
    expect(p.freeOfCharge).toBe(true);
  });

  it("is registered for ollama and openai-compatible", () => {
    const c = testConfig();
    c.provider = "ollama";
    const p = createProvider(c);
    expect(p.id).toBe("ollama");
    expect(p.freeOfCharge).toBe(true);
    c.provider = "openai-compatible";
    expect(createProvider(c).displayName).toBe("OpenAI-compatible");
  });

  it("knows which providers need a key", () => {
    const c = testConfig();
    c.provider = "ollama";
    expect(providerNeedsKey(c).needed).toBe(false);
    c.provider = "openai-compatible";
    c.providers.openai.baseUrl = "https://api.openai.com/v1";
    expect(providerNeedsKey(c)).toEqual({ needed: true, envVar: "OPENAI_API_KEY" });
    c.providers.openai.baseUrl = "http://localhost:8000/v1";
    expect(providerNeedsKey(c).needed).toBe(false);
  });

  it("reads provider settings from the environment", () => {
    process.env.SUTRA_HOME = tempDir();
    const { config } = loadConfig(tempDir(), {}, { SUTRA_PROVIDER: "ollama", OLLAMA_HOST: "127.0.0.1:11434", SUTRA_MODEL: "qwen3-coder" });
    expect(config.provider).toBe("ollama");
    expect(config.providers.ollama.baseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(config.model).toBe("qwen3-coder");
    // No default model for non-DeepSeek providers: Sutra asks the server.
    expect(loadConfig(tempDir(), { provider: "ollama" }, {}).config.model).toBeUndefined();
    expect(() => loadConfig(tempDir(), { provider: "nope" }, {})).toThrow(/Unknown provider/);
    expect(ollamaUrl("http://box:11434/v1/")).toBe("http://box:11434/v1");
  });

  it("records local inference as free instead of unknown cost", async () => {
    const provider = new ScriptedProvider([{ content: "hi", usage: { inputTokens: 5000, outputTokens: 500 } }]);
    Object.assign(provider, { freeOfCharge: true });
    const config = testConfig();
    config.model = "llama-local";
    h = createHarness({ provider, config });
    const r = await h.session.runtime.runTurn("hello");
    expect(r.costUsd).toBe(0);
    expect(h.session.usage.totals.costIncomplete).toBe(false);
  });
});

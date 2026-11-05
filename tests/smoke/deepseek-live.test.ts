import { describe, expect, it } from "vitest";
import { DeepSeekProvider } from "../../src/providers/deepseek/provider.js";
import type { Message, ModelEvent } from "../../src/providers/types.js";

/**
 * Optional smoke tests against the real DeepSeek API. Skipped unless
 * DEEPSEEK_API_KEY is set. Each test costs a fraction of a cent.
 *   DEEPSEEK_API_KEY=... npm run test:smoke
 */
const key = process.env.DEEPSEEK_API_KEY;
const model = process.env.DEEPSEEK_MODEL ?? "deepseek-flash";
const live = describe.skipIf(!key);

live("DeepSeek live API", () => {
  const provider = () => new DeepSeekProvider({ apiKey: key!, baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com", timeoutMs: 120_000 });

  it("lists models", async () => {
    const ids = await provider().listModels();
    expect(ids.length).toBeGreaterThan(0);
  });

  it("streams a completion with usage", async () => {
    const events: ModelEvent[] = [];
    for await (const e of provider().generate({ model, messages: [{ role: "user", content: "Reply with exactly: ok" }], thinking: "disabled", maxOutputTokens: 8 })) events.push(e);
    const done = events.find((e) => e.type === "message_complete");
    expect(done?.type).toBe("message_complete");
    if (done?.type === "message_complete") {
      expect(done.message.content.toLowerCase()).toContain("ok");
      expect(done.usage?.inputTokens).toBeGreaterThan(0);
    }
  }, 120_000);

  it("completes a thinking-mode tool-call round trip with reasoning_content passed back", async () => {
    const p = provider();
    const tools = [{ name: "get_time", description: "Returns the current UTC time.", parameters: { type: "object", properties: {}, additionalProperties: false } }];
    const messages: Message[] = [{ role: "user", content: "What time is it? Use the get_time tool, then answer in one short sentence." }];
    let done: Extract<ModelEvent, { type: "message_complete" }> | undefined;
    for await (const e of p.generate({ model, messages, tools, thinking: "enabled", reasoningEffort: "low", maxOutputTokens: 2048 })) if (e.type === "message_complete") done = e;
    expect(done?.message.toolCalls?.[0]?.name).toBe("get_time");
    messages.push(done!.message);
    for (const c of done!.message.toolCalls!) messages.push({ role: "tool", toolCallId: c.id, name: c.name, content: "2026-01-01T12:00:00Z" });
    let final: typeof done;
    for await (const e of p.generate({ model, messages, tools, thinking: "enabled", reasoningEffort: "low", maxOutputTokens: 2048 })) if (e.type === "message_complete") final = e;
    expect(final?.message.content).toMatch(/12/);
  }, 180_000);
});

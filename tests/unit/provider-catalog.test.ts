import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, readCredentials, writeCredentials } from "../../src/config/load.js";
import { PROVIDERS, findPreset, isLocalUrl } from "../../src/providers/catalog.js";
import { OpenAICompatibleProvider } from "../../src/providers/openai-compatible/provider.js";
import { createProvider, listProviders, providerNeedsKey } from "../../src/providers/registry.js";
import { tempDir } from "../helpers/harness.js";

let home: string;
beforeEach(() => {
  home = tempDir();
  process.env.SUTRA_HOME = home;
});
afterEach(() => {
  delete process.env.SUTRA_HOME;
});

describe("provider catalog", () => {
  it("registers every catalog provider, with unique ids and valid URLs", () => {
    const ids = PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(listProviders()).toContain(id);
    for (const p of PROVIDERS) if (p.id !== "custom") expect(() => new URL(p.baseUrl)).not.toThrow();
    expect(ids).toEqual(expect.arrayContaining(["openrouter", "anthropic", "gemini", "groq", "mistral", "xai", "together", "fireworks", "lmstudio", "vllm", "llamacpp"]));
    for (const p of PROVIDERS.filter((x) => x.local)) expect(isLocalUrl(p.baseUrl)).toBe(true);
  });

  it("reads a provider's key from its environment variable, then credentials", () => {
    const ws = tempDir();
    writeFileSync(join(home, "config.json"), JSON.stringify({ provider: "openrouter", model: "deepseek/deepseek-chat" }));
    let { config, apiKeySource } = loadConfig(ws, {}, {});
    expect(providerNeedsKey(config)).toEqual({ needed: true, envVar: "OPENROUTER_API_KEY" });
    expect(apiKeySource).toBe("none");

    writeCredentials({ apiKeys: { openrouter: "sk-or-stored" } });
    ({ config, apiKeySource } = loadConfig(ws, {}, {}));
    expect(apiKeySource).toBe("credentials");
    expect(providerNeedsKey(config).needed).toBe(false);

    ({ config, apiKeySource } = loadConfig(ws, {}, { OPENROUTER_API_KEY: "sk-or-env" }));
    expect(apiKeySource).toBe("env");
    expect((config.providers as Record<string, { apiKey?: string }>).openrouter!.apiKey).toBe("sk-or-env");
    const p = createProvider(config);
    expect(p.id).toBe("openrouter");
    expect(p.displayName).toBe("OpenRouter");
  });

  it("keeps other providers' saved keys when adding one", () => {
    writeCredentials({ deepseekApiKey: "sk-ds" });
    writeCredentials({ apiKeys: { groq: "gsk-1" } });
    writeCredentials({ apiKeys: { mistral: "ms-1" } });
    expect(readCredentials()).toEqual({ deepseekApiKey: "sk-ds", apiKeys: { groq: "gsk-1", mistral: "ms-1" } });
  });

  it("needs no key for local servers and uses the configured address", () => {
    const ws = tempDir();
    writeFileSync(join(home, "config.json"), JSON.stringify({ provider: "lmstudio", model: "qwen3-coder", providers: { lmstudio: { baseUrl: "http://192.168.1.20:1234/v1" } } }));
    const { config } = loadConfig(ws, {}, {});
    expect(providerNeedsKey(config).needed).toBe(false);
    const p = createProvider(config);
    expect(p.freeOfCharge).toBe(true);
    expect(findPreset("lmstudio")!.local).toBe(true);
  });

  it("asks for a URL when a custom endpoint has none", () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ provider: "custom", model: "m" }));
    const { config } = loadConfig(tempDir(), {}, {});
    expect(() => createProvider(config)).toThrow(/No URL configured for Custom endpoint/);
  });

  it("names every provider when the configured one is unknown", () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ provider: "nope" }));
    expect(() => loadConfig(tempDir(), {}, {})).toThrow(/Unknown provider "nope". Use one of: deepseek, openrouter/);
  });
});

describe("model details", () => {
  it("parses prices, context and tool support, and sends the provider's headers", async () => {
    let seen: Headers | undefined;
    const fetchFn = (async (_url: string, init: RequestInit) => {
      seen = new Headers(init.headers);
      return new Response(
        JSON.stringify({
          data: [
            { id: "a/coder", context_length: 131072, pricing: { prompt: "0.0000003", completion: "0.0000012", input_cache_read: "0.00000003" }, supported_parameters: ["tools"] },
            { id: "b/chat", pricing: { prompt: "0", completion: "0" }, supported_parameters: ["temperature"] },
            { id: "c/plain" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const p = new OpenAICompatibleProvider({ id: "openrouter", displayName: "OpenRouter", baseUrl: "https://example.test/v1", dialect: "openai", apiKey: "k", headers: { "X-Title": "Sutra" }, fetch: fetchFn });
    const d = await p.listModelDetails();
    expect(d[0]).toEqual({ id: "a/coder", contextWindow: 131072, pricePerM: { input: 0.3, output: 1.2, cachedInput: 0.03 }, tools: true });
    expect(d[1]).toMatchObject({ id: "b/chat", tools: false, pricePerM: { input: 0, output: 0 } });
    expect(d[2]).toEqual({ id: "c/plain" });
    expect(seen?.get("x-title")).toBe("Sutra");
    expect(seen?.get("authorization")).toBe("Bearer k");
  });
});

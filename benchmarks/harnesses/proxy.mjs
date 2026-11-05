// Metering proxy: every harness talks to DeepSeek through this, so tokens,
// cache hits, requests and errors are counted the same way for all of them,
// from the provider's own usage fields, not from what each harness reports.
//
// It forwards the request unchanged (path, method, headers, body) to the
// upstream, with one exception: for an OpenAI-style streaming chat request
// that didn't ask for usage, it adds `stream_options.include_usage` so the
// provider reports tokens. The API key passes through in the client's own
// header and is never logged or stored.

import http from "node:http";

const DROP_REQ = new Set(["host", "connection", "content-length", "accept-encoding", "transfer-encoding"]);
const DROP_RES = new Set(["connection", "content-length", "content-encoding", "transfer-encoding"]);

/** Pull usage numbers out of any provider JSON object (OpenAI chat, OpenAI responses, Anthropic). */
export function usageOf(obj) {
  if (!obj || typeof obj !== "object") return null;
  const u = obj.usage ?? obj.message?.usage ?? obj.response?.usage;
  if (!u || typeof u !== "object") return null;
  const out = {};
  if (typeof u.prompt_tokens === "number") {
    // OpenAI chat (DeepSeek): prompt_tokens includes cached ones.
    out.input = u.prompt_tokens;
    out.cached = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
    out.output = u.completion_tokens ?? 0;
    out.reasoning = u.completion_tokens_details?.reasoning_tokens ?? 0;
    out.dialect = "openai";
  } else if (typeof u.input_tokens === "number" && ("cache_read_input_tokens" in u || "cache_creation_input_tokens" in u || obj.type?.startsWith?.("message"))) {
    // Anthropic: input_tokens excludes cache reads and writes.
    out.input = u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    out.cached = u.cache_read_input_tokens ?? 0;
    out.output = u.output_tokens ?? 0;
    out.reasoning = 0;
    out.dialect = "anthropic";
  } else if (typeof u.input_tokens === "number") {
    // OpenAI responses API.
    out.input = u.input_tokens;
    out.cached = u.input_tokens_details?.cached_tokens ?? 0;
    out.output = u.output_tokens ?? 0;
    out.reasoning = u.output_tokens_details?.reasoning_tokens ?? 0;
    out.dialect = "responses";
  } else if (typeof u.output_tokens === "number") {
    // Anthropic message_delta: output only (cumulative).
    out.output = u.output_tokens;
  } else return null;
  return out;
}

/** Usage for one response body: JSON, or SSE where counts may arrive in several (cumulative) events. */
export function usageFromBody(text) {
  const merged = { input: 0, cached: 0, output: 0, reasoning: 0, dialect: null, found: false };
  const take = (u) => {
    if (!u) return;
    merged.found = true;
    for (const k of ["input", "cached", "output", "reasoning"]) if (typeof u[k] === "number") merged[k] = Math.max(merged[k], u[k]);
    if (u.dialect) merged.dialect = u.dialect;
  };
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) {
    try {
      take(usageOf(JSON.parse(trimmed)));
      return merged;
    } catch {
      /* fall through to SSE parsing */
    }
  }
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      take(usageOf(JSON.parse(data)));
    } catch {
      /* not JSON */
    }
  }
  return merged;
}

/**
 * Start a proxy on 127.0.0.1 (random port). Returns { url, port, requests, close() }.
 * `requests` collects one record per upstream call.
 */
export function startProxy({ upstream = "https://api.deepseek.com", injectStreamUsage = true } = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = Buffer.concat(chunks);
    let model = null;
    let injected = false;
    if (body.length && (req.headers["content-type"] ?? "").includes("json")) {
      try {
        const j = JSON.parse(body.toString("utf8"));
        model = typeof j.model === "string" ? j.model : null;
        if (injectStreamUsage && j.stream === true && /chat\/completions$/.test(req.url.split("?")[0]) && !j.stream_options?.include_usage) {
          j.stream_options = { ...(j.stream_options ?? {}), include_usage: true };
          body = Buffer.from(JSON.stringify(j));
          injected = true;
        }
      } catch {
        /* forward as-is */
      }
    }
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!DROP_REQ.has(k) && v !== undefined) headers[k] = v;
    headers["accept-encoding"] = "identity";
    const rec = { at: new Date(started).toISOString(), method: req.method, path: req.url.split("?")[0], model, status: 0, ms: 0, input: 0, cached: 0, output: 0, reasoning: 0, usageFound: false, injectedStreamUsage: injected };
    requests.push(rec);
    let upstreamRes;
    try {
      upstreamRes = await fetch(upstream.replace(/\/$/, "") + req.url, {
        method: req.method,
        headers,
        ...(body.length && req.method !== "GET" && req.method !== "HEAD" ? { body } : {}),
        redirect: "manual",
      });
    } catch (err) {
      rec.status = 599;
      rec.error = String(err?.message ?? err);
      rec.ms = Date.now() - started;
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `metering proxy could not reach upstream: ${rec.error}` } }));
      return;
    }
    rec.status = upstreamRes.status;
    const outHeaders = {};
    upstreamRes.headers.forEach((v, k) => {
      if (!DROP_RES.has(k)) outHeaders[k] = v;
    });
    res.writeHead(upstreamRes.status, outHeaders);
    const decoder = new TextDecoder();
    let text = "";
    if (upstreamRes.body) {
      for await (const chunk of upstreamRes.body) {
        res.write(chunk);
        if (text.length < 20_000_000) text += decoder.decode(chunk, { stream: true });
      }
    }
    res.end();
    const u = usageFromBody(text);
    Object.assign(rec, { input: u.input, cached: u.cached, output: u.output, reasoning: u.reasoning, usageFound: u.found, ...(u.dialect ? { dialect: u.dialect } : {}) });
    if (upstreamRes.status >= 400) rec.errorBody = text.slice(0, 300).replace(/sk-[A-Za-z0-9*_-]{6,}/g, "sk-[redacted]");
    rec.ms = Date.now() - started;
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ url: `http://127.0.0.1:${port}`, port, requests, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

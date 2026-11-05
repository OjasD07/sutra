import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockReply {
  reasoning?: string;
  content?: string;
  toolCalls?: { name: string; args: unknown }[];
  usage?: { prompt_tokens: number; completion_tokens: number; prompt_cache_hit_tokens?: number; reasoning_tokens?: number };
  status?: number;
}

export type WireBody = {
  model: string;
  messages: { role: string; content: string | null; reasoning_content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[]; tool_call_id?: string }[];
  tools?: unknown[];
  thinking?: { type: string };
  stream?: boolean;
};

/**
 * A local HTTP server that speaks DeepSeek's chat-completions streaming
 * protocol (SSE chunks, keep-alive comments, final usage chunk, [DONE]).
 * It also enforces the documented thinking-mode rule: with tools present,
 * every assistant message must carry its reasoning_content, otherwise 400.
 */
export async function startMockDeepSeek(script: ((body: WireBody, n: number) => MockReply)[], apiKey: string) {
  const requests: WireBody[] = [];
  let n = 0;
  let callCounter = 0;
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      if (req.headers.authorization !== `Bearer ${apiKey}`) {
        res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Authentication Fails" } }));
        return;
      }
      if (req.method === "GET" && req.url === "/models") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "list", data: [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }] }));
        return;
      }
      const body = JSON.parse(raw) as WireBody;
      requests.push(body);
      if (body.tools?.length && body.thinking?.type !== "disabled") {
        const missing = body.messages.find((m) => m.role === "assistant" && m.reasoning_content === undefined);
        if (missing) {
          res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "reasoning_content must be passed back" } }));
          return;
        }
      }
      const step = script[n];
      const reply = step ? step(body, n) : { content: "(script exhausted)" };
      n++;
      if (reply.status) {
        res.writeHead(reply.status, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: `mock ${reply.status}` } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (delta: Record<string, unknown>, finish: string | null = null, usage: unknown = null) =>
        res.write(`data: ${JSON.stringify({ id: "m", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], usage })}\n\n`);
      res.write(": keep-alive\n\n");
      send({ role: "assistant", content: "" });
      if (reply.reasoning) for (const part of reply.reasoning.match(/.{1,12}/gs) ?? []) send({ reasoning_content: part });
      if (reply.content) for (const part of reply.content.match(/.{1,12}/gs) ?? []) send({ content: part });
      (reply.toolCalls ?? []).forEach((c, index) => {
        const args = JSON.stringify(c.args);
        const half = Math.ceil(args.length / 2);
        send({ tool_calls: [{ index, id: `call_${++callCounter}`, type: "function", function: { name: c.name, arguments: args.slice(0, half) } }] });
        send({ tool_calls: [{ index, function: { arguments: args.slice(half) } }] });
      });
      const u = reply.usage ?? { prompt_tokens: 1500, completion_tokens: 120, prompt_cache_hit_tokens: 1000, reasoning_tokens: 40 };
      send({ content: "" }, reply.toolCalls?.length ? "tool_calls" : "stop", {
        prompt_tokens: u.prompt_tokens,
        completion_tokens: u.completion_tokens,
        total_tokens: u.prompt_tokens + u.completion_tokens,
        prompt_cache_hit_tokens: u.prompt_cache_hit_tokens ?? 0,
        prompt_cache_miss_tokens: u.prompt_tokens - (u.prompt_cache_hit_tokens ?? 0),
        completion_tokens_details: { reasoning_tokens: u.reasoning_tokens ?? 0 },
      });
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    get count() {
      return n;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** Text content of the most recent tool message in a request. */
export function lastToolOutput(body: WireBody): string {
  const tools = body.messages.filter((m) => m.role === "tool");
  return tools.at(-1)?.content ?? "";
}

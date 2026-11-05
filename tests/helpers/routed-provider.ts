import { DEEPSEEK_MODELS } from "../../src/providers/deepseek/models.js";
import type { AssistantMessage, Message, ModelCapabilities, ModelEvent, ModelInfo, ModelProvider, ModelRequest } from "../../src/providers/types.js";

export interface RoutedStep {
  content?: string;
  toolCalls?: { name: string; args: unknown }[];
}
type StepFn = (req: ModelRequest) => RoutedStep;

export type Role = "main" | "verifier" | "candidate" | "contract" | "judge" | "review-infer" | "review-compare" | "propose" | "summary";

/** Which part of Sutra is calling, from the request's system prompt. */
export function roleOf(req: ModelRequest): Role {
  const sys = (req.messages[0]?.content as string) ?? "";
  if (sys.startsWith("You are Sutra, an AI coding agent")) return "main";
  if (sys.startsWith("You are Sutra's verifier")) return "verifier";
  if (sys.startsWith("You are one of several independent attempts")) return "candidate";
  if (sys.startsWith("Turn a coding request into a task contract")) return "contract";
  if (sys.startsWith("You are a strict verification judge")) return "judge";
  if (sys.startsWith("You review a code change with no other context")) return "review-infer";
  if (sys.startsWith("Compare what a patch actually does")) return "review-compare";
  if (sys.startsWith("Propose distinct, concrete root-cause")) return "propose";
  return "summary";
}

export const lastUser = (req: ModelRequest): string => {
  const u = [...req.messages].reverse().find((m: Message) => m.role === "user");
  return (u?.content as string) ?? "";
};

/**
 * Test provider that routes each request by caller. Agent roles (main,
 * verifier, candidate) play back their own script queues; harness roles
 * (contract, judge, review, propose) are answered by functions of the request.
 */
export class RoutedProvider implements ModelProvider {
  readonly id = "routed";
  readonly displayName = "Routed";
  requests: { role: Role; req: ModelRequest }[] = [];
  private queues = new Map<Role, (RoutedStep | StepFn)[]>();
  private counter = 0;

  constructor(
    scripts: Partial<Record<"main" | "verifier" | "candidate", (RoutedStep | StepFn)[]>>,
    private readonly answers: Partial<Record<Role, (req: ModelRequest) => string>> = {},
    private readonly info: ModelInfo = DEEPSEEK_MODELS["deepseek-flash"]!,
  ) {
    for (const [k, v] of Object.entries(scripts)) this.queues.set(k as Role, [...v!]);
  }

  getCapabilities(): ModelCapabilities {
    return { streaming: true, toolCalls: true, parallelToolCalls: true, thinking: true, promptCaching: true, models: [this.info] };
  }
  getModelInfo(): ModelInfo {
    return this.info;
  }
  count(role: Role): number {
    return this.requests.filter((r) => r.role === role).length;
  }

  async *generate(req: ModelRequest): AsyncIterable<ModelEvent> {
    const role = roleOf(req);
    this.requests.push({ role, req: structuredClone(req) });
    let step: RoutedStep;
    const q = this.queues.get(role);
    if (q) {
      const next = q.shift();
      if (!next) throw new Error(`RoutedProvider: no scripted step left for ${role}`);
      step = typeof next === "function" ? next(req) : next;
    } else {
      const fn = this.answers[role];
      step = { content: fn ? fn(req) : "{}" };
    }
    const msg: AssistantMessage = { role: "assistant", content: step.content ?? "" };
    if (step.toolCalls?.length) msg.toolCalls = step.toolCalls.map((c) => ({ id: `call_${++this.counter}`, name: c.name, arguments: JSON.stringify(c.args) }));
    if (msg.content) yield { type: "text_delta", text: msg.content };
    yield { type: "message_complete", message: msg, finishReason: msg.toolCalls ? "tool_calls" : "stop", usage: { inputTokens: 1000, outputTokens: 50, reasoningTokens: 0, cachedInputTokens: 500 }, model: req.model };
  }
}

/** A judge that cites the most recent passing test run after the last edit for every criterion. */
export function freshTestJudge(req: ModelRequest): string {
  const user = lastUser(req);
  const ids = [...user.matchAll(/^(C\d+):/gm)].map((m) => m[1]!);
  const fresh = [...user.matchAll(/^(c\d+) \[test[^\]]*after last edit\] PASSED/gm)].map((m) => m[1]!);
  const stale = [...user.matchAll(/^(c\d+) \[(?:test|baseline)[^\]]*\] (?:PASSED|FAILED)/gm)].map((m) => m[1]!);
  const cite = fresh.at(-1) ?? stale.at(-1);
  return JSON.stringify({ criteria: ids.map((id) => ({ id, status: cite ? "passed" : "unverified", evidence: cite ? [cite] : [], note: "judge" })) });
}

import type { AuxModel } from "./aux.js";
import type { ReviewResult } from "./types.js";

/**
 * Independent task-alignment review (after RETRACE): a fresh-context call
 * first infers what problem the patch solves WITHOUT seeing the request, then
 * a second call compares that inference with the request. It supplements
 * executable checks; it can flag a gap but never pass a criterion by itself.
 */
export async function reviewAlignment(aux: AuxModel, o: { request: string; diff: string; checks: string; signal?: AbortSignal }): Promise<ReviewResult> {
  const inferred = await aux.json<{ inferred?: string; behaviour_changes?: string[] }>(
    "You review a code change with no other context. Infer, precisely and neutrally, what problem this patch solves and how it changes behaviour. Do not guess at intent beyond what the code shows.",
    `Patch:\n\`\`\`diff\n${o.diff.slice(0, 14_000)}\n\`\`\`\n\nChecks that were run:\n${o.checks || "(none)"}\n\nJSON: {"inferred": "one or two sentences", "behaviour_changes": ["..."]}`,
    { maxTokens: 600, ...(o.signal ? { signal: o.signal } : {}) },
  );
  if (!inferred?.inferred) return { verdict: "unknown", inferred: "", gaps: ["review unavailable"] };
  const cmp = await aux.json<{ verdict?: string; gaps?: string[] }>(
    "Compare what a patch actually does (as inferred by an independent reviewer) with what the user asked for. Judge only alignment: does it address the request, all of it, and nothing contrary to it?",
    `User request:\n${o.request}\n\nIndependent description of the patch:\n${inferred.inferred}\nBehaviour changes:\n${(inferred.behaviour_changes ?? []).map((b) => `- ${b}`).join("\n")}\n\nJSON: {"verdict": "aligned" | "partial" | "misaligned", "gaps": ["specific parts of the request the patch does not address or contradicts"]}`,
    { maxTokens: 400, ...(o.signal ? { signal: o.signal } : {}) },
  );
  const verdict = cmp?.verdict === "aligned" || cmp?.verdict === "partial" || cmp?.verdict === "misaligned" ? cmp.verdict : "unknown";
  return { verdict, inferred: inferred.inferred, gaps: (cmp?.gaps ?? []).filter((g) => typeof g === "string").slice(0, 5) };
}

import { z } from "zod";
import { fail, ok, type Tool } from "../types.js";

/**
 * Full output of an earlier tool call. Sutra sends repeated test runs as
 * deltas and unchanged re-reads as pointers; this returns the exact text.
 */
export const getOutputTool: Tool<{ call_id: string; offset?: number; limit?: number }> = {
  name: "get_output",
  description:
    "Return the full, exact output of an earlier tool call by its call id (Sutra sends repeated test runs as deltas and unchanged re-reads as pointers, and names the call id to use). offset/limit select lines.",
  version: "1.0.0",
  category: "internal",
  readOnly: true,
  schema: z.object({
    call_id: z.string().min(1),
    offset: z.number().int().min(1).optional().describe("1-based first line"),
    limit: z.number().int().min(1).max(5000).optional().describe("Max lines (default all)"),
  }),
  describe: (a) => ({ tool: "get_output", category: "internal", summary: `Output of ${a.call_id}` }),
  async execute(a, ctx) {
    const text = ctx.outputs?.(a.call_id);
    if (text === undefined) return fail("not_found", `No recorded output for call ${a.call_id} (only calls from this session, and only the most recent few hundred, are kept).`);
    if (!a.offset && !a.limit) return ok(text, { call_id: a.call_id, chars: text.length });
    const lines = text.split("\n");
    const start = (a.offset ?? 1) - 1;
    const end = Math.min(lines.length, start + (a.limit ?? lines.length));
    return ok(lines.slice(start, end).join("\n") + (end < lines.length ? `\n[lines ${start + 1}-${end} of ${lines.length}]` : ""), { call_id: a.call_id, from: start + 1, to: end });
  },
};

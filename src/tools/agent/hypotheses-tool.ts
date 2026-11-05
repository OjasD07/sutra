import { z } from "zod";
import { fail, ok, type Tool } from "../types.js";

type Args = {
  action: "add" | "update" | "list";
  id?: string;
  claim?: string;
  location?: string;
  supports?: string;
  contradicts?: string;
  next_check?: string;
  status?: "open" | "confirmed" | "rejected";
};

export const hypothesesTool: Tool<Args> = {
  name: "hypotheses",
  description:
    "For difficult bugs: keep up to 3 competing explanations of the cause. 'add' one (claim, location, supports, contradicts, next_check: the cheapest check that would distinguish it), 'update' it as evidence arrives (status confirmed/rejected), or 'list' them. Prefer running a distinguishing check over editing on a guess. Skip for obvious fixes.",
  version: "1.0.0",
  category: "internal",
  readOnly: false,
  schema: z.object({
    action: z.enum(["add", "update", "list"]),
    id: z.string().optional().describe("H1, H2, … (for update)"),
    claim: z.string().max(300).optional(),
    location: z.string().max(200).optional().describe("file:line or symbol"),
    supports: z.string().max(300).optional(),
    contradicts: z.string().max(300).optional(),
    next_check: z.string().max(300).optional(),
    status: z.enum(["open", "confirmed", "rejected"]).optional(),
  }),
  describe: () => ({ tool: "hypotheses", category: "internal", summary: "Update hypotheses" }),
  async execute(a, ctx) {
    const ledger = ctx.hypotheses;
    if (!ledger) return fail("execution_failed", "The hypothesis ledger is not available in this session.");
    try {
      if (a.action === "add") {
        if (!a.claim) return fail("invalid_arguments", "add needs a claim");
        const h = ledger.add({
          claim: a.claim,
          ...(a.location ? { location: a.location } : {}),
          ...(a.supports ? { supports: a.supports } : {}),
          ...(a.contradicts ? { contradicts: a.contradicts } : {}),
          ...(a.next_check ? { nextCheck: a.next_check } : {}),
        });
        return ok(`Recorded ${h.id}.\n${ledger.render()}`, { open: ledger.open().length });
      }
      if (a.action === "update") {
        if (!a.id) return fail("invalid_arguments", "update needs an id");
        ledger.update(a.id, {
          ...(a.claim ? { claim: a.claim } : {}),
          ...(a.location ? { location: a.location } : {}),
          ...(a.supports ? { supports: a.supports } : {}),
          ...(a.contradicts ? { contradicts: a.contradicts } : {}),
          ...(a.next_check ? { nextCheck: a.next_check } : {}),
          ...(a.status ? { status: a.status } : {}),
        });
        return ok(ledger.render(), { open: ledger.open().length });
      }
      return ok(ledger.render(), { open: ledger.open().length });
    } catch (err) {
      return fail("invalid_arguments", (err as Error).message);
    }
  },
};

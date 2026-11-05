import { z } from "zod";
import { fail, ok, type Tool } from "../types.js";

const StepSchema = z.object({
  title: z.string().min(1).max(200),
  status: z.enum(["pending", "active", "completed", "blocked"]),
  note: z.string().max(300).optional(),
});

export const updatePlanTool: Tool<{ steps: z.infer<typeof StepSchema>[]; explanation?: string }> = {
  name: "update_plan",
  description:
    "Create or update the task plan for multi-step work. Send the full list each time. Keep exactly one step 'active' while working; mark steps 'completed' only after they are verified, 'blocked' with a note if they cannot proceed. Skip planning for simple one-step tasks.",
  version: "1.0.0",
  category: "internal",
  readOnly: false,
  schema: z.object({ steps: z.array(StepSchema).min(1).max(30), explanation: z.string().max(500).optional() }),
  describe: () => ({ tool: "update_plan", category: "internal", summary: "Update plan" }),
  async execute(a, ctx) {
    try {
      ctx.plan.set(a.steps, a.explanation);
    } catch (err) {
      return fail("invalid_arguments", (err as Error).message);
    }
    return ok(`Plan updated.\n${ctx.plan.render()}`, { steps: a.steps.length });
  },
};

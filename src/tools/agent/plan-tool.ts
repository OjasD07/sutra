import { z } from "zod";
import { fail, ok, type Tool } from "../types.js";

/**
 * Models name plan states in many ways ("in_progress", "done", "todo", ...).
 * Rejecting those wastes a round trip (DeepSeek's first update_plan call in a
 * real session failed on "in_progress"), so common synonyms are normalised.
 */
const STATUS_ALIASES: Record<string, "pending" | "active" | "completed" | "blocked"> = {
  pending: "pending", todo: "pending", "to-do": "pending", not_started: "pending", "not-started": "pending", open: "pending", planned: "pending", queued: "pending", waiting: "pending",
  active: "active", in_progress: "active", "in-progress": "active", inprogress: "active", doing: "active", current: "active", started: "active", working: "active", running: "active", ongoing: "active",
  completed: "completed", complete: "completed", done: "completed", finished: "completed", success: "completed", succeeded: "completed", passed: "completed", verified: "completed", closed: "completed",
  blocked: "blocked", failed: "blocked", stuck: "blocked", error: "blocked", cancelled: "blocked", canceled: "blocked", skipped: "blocked",
};

function normaliseStatus(v: unknown): unknown {
  if (typeof v !== "string") return v;
  return STATUS_ALIASES[v.trim().toLowerCase().replace(/\s+/g, "_")] ?? v;
}

/** Accept a bare string, or {title|step|content|description|text|name, status|state}. */
function normaliseStep(v: unknown): unknown {
  if (typeof v === "string") return { title: v, status: "pending" };
  if (!v || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  const title = o.title ?? o.step ?? o.content ?? o.description ?? o.text ?? o.name ?? o.task;
  const status = o.status ?? o.state ?? "pending";
  return { title, status: normaliseStatus(status), ...(typeof o.note === "string" && o.note ? { note: o.note } : {}) };
}

const StepSchema = z.object({
  title: z.string().min(1).max(200),
  status: z.enum(["pending", "active", "completed", "blocked"], { error: 'status must be pending, active, completed or blocked (in_progress/done/todo are also accepted)' }),
  note: z.string().max(300).optional(),
});

export type PlanStepArgs = z.infer<typeof StepSchema>;

export const updatePlanTool: Tool<{ steps: PlanStepArgs[]; explanation?: string }> = {
  name: "update_plan",
  description:
    "Create or update the task plan for multi-step work. Send the full list each time. Statuses: pending, active, completed, blocked. Keep exactly one step 'active' while working; mark steps 'completed' only after they are verified, 'blocked' with a note if they cannot proceed. Skip planning for simple one-step tasks.",
  version: "1.1.0",
  category: "internal",
  readOnly: false,
  schema: z.object({
    steps: z.preprocess((v) => (Array.isArray(v) ? v.map(normaliseStep) : v), z.array(StepSchema).min(1).max(30)),
    explanation: z.string().max(500).optional(),
  }) as unknown as z.ZodType<{ steps: PlanStepArgs[]; explanation?: string }>,
  describe: () => ({ tool: "update_plan", category: "internal", summary: "Update plan" }),
  async execute(a, ctx) {
    // More than one "active" step is a modelling slip, not a reason to fail: keep the first.
    let seenActive = false;
    const steps = a.steps.map((s) => {
      if (s.status !== "active") return s;
      if (seenActive) return { ...s, status: "pending" as const };
      seenActive = true;
      return s;
    });
    try {
      ctx.plan.set(steps, a.explanation);
    } catch (err) {
      return fail("invalid_arguments", (err as Error).message);
    }
    return ok(`Plan updated.\n${ctx.plan.render()}`, { steps: steps.length });
  },
};

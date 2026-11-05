export type StepStatus = "pending" | "active" | "completed" | "blocked";

export interface PlanStep {
  title: string;
  status: StepStatus;
  note?: string;
}

export interface Plan {
  steps: PlanStep[];
  explanation?: string;
  updatedAt: string;
}

type Listener = (plan: Plan | null) => void;

export class PlanStore {
  private plan: Plan | null = null;
  private listeners = new Set<Listener>();

  get(): Plan | null {
    return this.plan;
  }

  set(steps: PlanStep[], explanation?: string): Plan {
    const active = steps.filter((s) => s.status === "active").length;
    if (active > 1) throw new Error("At most one step may be active at a time");
    this.plan = { steps, updatedAt: new Date().toISOString(), ...(explanation ? { explanation } : {}) };
    for (const l of this.listeners) l(this.plan);
    return this.plan;
  }

  restore(plan: Plan | null): void {
    this.plan = plan;
  }

  clear(): void {
    this.plan = null;
    for (const l of this.listeners) l(null);
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  render(): string {
    if (!this.plan) return "No plan.";
    const mark: Record<StepStatus, string> = { pending: "[ ]", active: "[>]", completed: "[x]", blocked: "[!]" };
    return this.plan.steps.map((s, i) => `${mark[s.status]} ${i + 1}. ${s.title}${s.note ? ` — ${s.note}` : ""}`).join("\n");
  }
}

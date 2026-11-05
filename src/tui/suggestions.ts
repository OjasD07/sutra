import { COMMANDS } from "../cli/commands.js";
import type { SessionRecord } from "../memory/store.js";
import type { ModelInfo } from "../providers/types.js";

/**
 * Suggestions shown under the input box: command names while typing "/…",
 * and a dropdown of real values for commands that take one ("/model ",
 * "/permissions ", "/budget ", "/sessions ", "/resume ").
 */
export interface Suggestion {
  key: string;
  label: string;
  /** Column after the label (args, context size, date). */
  detail?: string;
  /** Muted description. */
  hint?: string;
  current?: boolean;
  /** Shown but not selectable; the text explains why. */
  disabled?: string;
  /** Enter submits this exact input. */
  submit?: string;
  /** Enter/Tab puts this in the input instead (opens the next dropdown). */
  fill?: string;
  /** Rendered dimmed (non-matching commands below the separator). */
  dim?: boolean;
}

export interface SuggestionList {
  kind: "commands" | "choices";
  title?: string;
  items: Suggestion[];
}

export interface SuggestionContext {
  models: ModelInfo[];
  currentModel: string;
  profile: string;
  budgetUsd: number | undefined;
  sessions: SessionRecord[];
  currentSessionId: string;
}

/** Commands whose value can be picked from a list. */
export const PICKABLE = new Set(["model", "permissions", "budget", "sessions", "resume", "export"]);

const BUDGET_PRESETS = [0.25, 0.5, 1, 2, 5, 10];

const PROFILE_HINT: Record<string, string> = {
  inspect: "read-only: no edits, no commands",
  confirm: "edits and commands ask first",
  flow: "routine edits and checks run; risky actions ask",
};

/** Token counts in binary units, as providers document them (1,048,576 → 1M, 393,216 → 384K). */
function compact(n: number): string {
  if (n >= 1 << 20) return `${+(n / (1 << 20)).toFixed(1)}M`;
  if (n >= 1 << 10) return `${Math.round(n / (1 << 10))}K`;
  return String(n);
}

function matches(q: string, ...fields: (string | undefined)[]): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return fields.some((f) => f?.toLowerCase().includes(needle));
}

function commandList(query: string): SuggestionList {
  const q = query.toLowerCase();
  const toItem = (c: (typeof COMMANDS)[number], dim: boolean): Suggestion => {
    const pickable = PICKABLE.has(c.name);
    return {
      key: c.name,
      label: `/${c.name}`,
      ...(pickable ? { detail: "▾" } : c.args ? { detail: c.args } : {}),
      hint: c.help,
      ...(pickable ? { fill: `/${c.name} ` } : { submit: `/${c.name}` }),
      ...(dim ? { dim: true } : {}),
    };
  };
  const hits = COMMANDS.filter((c) => c.name.startsWith(q));
  const rest = q ? COMMANDS.filter((c) => !c.name.startsWith(q)) : [];
  return { kind: "commands", items: [...hits.map((c) => toItem(c, false)), ...rest.map((c) => toItem(c, true))] };
}

function choices(cmd: string, query: string, ctx: SuggestionContext): SuggestionList | null {
  switch (cmd) {
    case "model": {
      const items = ctx.models
        .filter((m) => matches(query, m.id))
        .map<Suggestion>((m) => ({
          key: m.id,
          label: m.id,
          detail: `context ${compact(m.contextWindow)} · output ${compact(m.maxOutputTokens)}`,
          hint: [m.supportsThinking ? "thinking" : "", m.supportsTools ? "tools" : "", m.supportsVision ? "vision" : ""].filter(Boolean).join(" · "),
          submit: `/model ${m.id}`,
          ...(m.id === ctx.currentModel ? { current: true } : {}),
        }));
      // A model id Sutra has no metadata for can still be typed in full.
      if (query && !ctx.models.some((m) => m.id === query))
        items.push({ key: `custom:${query}`, label: query, hint: "use this model id (not in Sutra's list)", submit: `/model ${query}` });
      return { kind: "choices", title: "Switch model", items };
    }
    case "permissions": {
      const items = ["inspect", "confirm", "flow"]
        .filter((p) => matches(query, p))
        .map<Suggestion>((p) => ({
          key: p,
          label: p,
          hint: PROFILE_HINT[p]!,
          submit: `/permissions ${p}`,
          ...(p === ctx.profile ? { current: true } : {}),
          ...(p === "inspect" || ctx.profile === "inspect"
            ? p === ctx.profile
              ? {}
              : { disabled: p === "inspect" ? "restart with --readonly" : "restart Sutra without --readonly" }
            : {}),
        }));
      return { kind: "choices", title: "Permission profile", items };
    }
    case "budget": {
      const items: Suggestion[] = [];
      const typed = Number(query.replace(/^\$/, ""));
      if (query && Number.isFinite(typed) && typed > 0)
        items.push({ key: `custom:${typed}`, label: `$${typed}`, hint: "set this limit", submit: `/budget ${typed}` });
      for (const v of BUDGET_PRESETS) {
        if (!matches(query, String(v), `$${v}`)) continue;
        items.push({
          key: String(v),
          label: `$${v.toFixed(2)}`,
          submit: `/budget ${v}`,
          ...(ctx.budgetUsd === v ? { current: true } : {}),
        });
      }
      if (matches(query, "off", "none", "remove"))
        items.push({ key: "off", label: "off", hint: "remove the limit", submit: "/budget off", ...(ctx.budgetUsd === undefined ? { current: true } : {}) });
      return { kind: "choices", title: ctx.budgetUsd ? `Session budget (now $${ctx.budgetUsd.toFixed(2)}) · or type an amount` : "Session budget · or type an amount", items };
    }
    case "export": {
      const items: Suggestion[] = [
        { key: "md", label: "md", hint: "readable audit report: timeline, commands, cost", submit: "/export md" },
        { key: "json", label: "json", hint: "machine-readable record (sutra.session-audit/v1)", submit: "/export json" },
      ].filter((i) => matches(query, i.label));
      return { kind: "choices", title: "Export this session", items };
    }
    case "sessions":
    case "resume": {
      const items = ctx.sessions
        .filter((s) => matches(query, s.id, s.title ?? "", s.status))
        .map<Suggestion>((s) => ({
          key: s.id,
          label: s.id.slice(0, 8),
          detail: `${s.updatedAt.slice(0, 16).replace("T", " ")} · ${s.status}`,
          hint: s.title ?? "(untitled)",
          submit: `/resume ${s.id}`,
          ...(s.id === ctx.currentSessionId ? { current: true, disabled: "current session" } : {}),
        }));
      return { kind: "choices", title: items.length ? "Resume a session" : "No saved sessions in this directory", items };
    }
    default:
      return null;
  }
}

export function buildSuggestions(value: string, ctx: SuggestionContext): SuggestionList | null {
  if (!value.startsWith("/")) return null;
  const head = value.match(/^\/(\S*)$/);
  if (head) {
    const list = commandList(head[1]!);
    return list.items.some((i) => !i.dim) ? list : null;
  }
  const arg = value.match(/^\/(\S+)\s+(.*)$/s);
  if (!arg || !PICKABLE.has(arg[1]!.toLowerCase())) return null;
  return choices(arg[1]!.toLowerCase(), arg[2]!.trim(), ctx);
}

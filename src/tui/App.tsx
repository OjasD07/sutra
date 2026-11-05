import { Box, Static, Text, useApp, useInput } from "ink";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { runSlashCommand, tildify } from "../cli/commands.js";
import type { SutraConfig } from "../config/schema.js";
import type { AgentEvent, AgentStatus, ApprovalRequest, TurnResult } from "../core/events/types.js";
import type { Plan } from "../core/planning/plan.js";
import type { SessionHandle } from "../core/session.js";
import { t } from "../i18n/index.js";
import type { SessionStore } from "../memory/store.js";
import type { ApprovalChoice } from "../permissions/engine.js";
import type { Message, ModelProvider } from "../providers/types.js";
import { formatUsd } from "../telemetry/cost.js";
import type { TestCounts } from "../tools/shell/test-counts.js";
import type { ToolResult } from "../tools/types.js";
import { oneLine } from "../utils/text.js";
import {
  ApprovalCard,
  AssistantBlock,
  Footer,
  InputBox,
  NoticeBlock,
  PlanBox,
  ThreadDiff,
  ToolRow,
  TurnHeading,
  TurnSummary,
  UserLine,
  Welcome,
  contextMeter,
  useContentWidth,
  useNow,
  useSpinnerFrame,
  type PaletteState,
  type ToolGlyph,
  type UiOptions,
} from "./components.js";
import { buildSuggestions } from "./suggestions.js";
import { sandboxSummary } from "../sandbox/sandbox.js";
import { threadGlyphs } from "./theme.js";

/** Bridges the runtime's approval callback to the UI. */
export class ApprovalBridge {
  handler: ((req: ApprovalRequest) => Promise<ApprovalChoice>) | null = null;
  request = (req: ApprovalRequest): Promise<ApprovalChoice> => (this.handler ? this.handler(req) : Promise.resolve("deny"));
}

interface ToolView {
  glyph: ToolGlyph;
  name: string;
  summary: string;
  detail?: string;
  muteSummary?: boolean;
  sub?: { text: string; color?: string }[];
  diff?: string;
}

type Item =
  | { kind: "welcome"; id: number }
  | { kind: "user"; id: number; text: string }
  | { kind: "heading"; id: number; turn: number }
  | { kind: "assistant"; id: number; text: string; leadingPipe: boolean }
  | { kind: "tool"; id: number; view: ToolView }
  | { kind: "plan"; id: number; plan: Plan }
  | { kind: "notice"; id: number; level: "info" | "warn" | "error"; label?: string; text: string; hint?: string }
  | { kind: "output"; id: number; text: string }
  | { kind: "turn"; id: number; result: TurnResult; budgetUsd?: number; sessionCostUsd: number };

export interface AppProps {
  ui: UiOptions;
  config: SutraConfig;
  store: SessionStore;
  provider: ModelProvider;
  bridge: ApprovalBridge;
  initialSession: SessionHandle;
  /** Opens a fresh session, or resumes the given one. */
  newSession: (resumeId?: string) => SessionHandle;
  initialPrompt?: string;
  notices: string[];
}

let nextId = 1;

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** One-line summary of what a call targets, from its validated arguments. */
export function argSummary(name: string, args: unknown, fallback: string, data?: Record<string, unknown>): string {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (name) {
    case "read_file":
      return `${str(a.path) ?? fallback}${a.offset ? `:${a.offset}` : ""}`;
    case "list_directory":
      return str(a.path) ?? ".";
    case "glob_files":
      return str(a.pattern) ?? fallback;
    case "search_files":
      return str(a.query) ?? fallback;
    case "grep_search":
      return `${str(a.pattern) ?? fallback}${a.path ? `  in ${a.path}` : ""}`;
    case "write_file":
    case "edit_file":
      return str(a.path) ?? fallback;
    case "apply_patch":
      return Array.isArray(data?.files) ? (data.files as string[]).join(", ") : fallback.replace(/^Apply patch to /, "");
    case "execute_command":
      return str(a.command) ?? fallback;
    case "run_tests":
      return str(data?.command) ?? fallback;
    case "git_status":
      return "";
    case "git_diff":
      return [a.staged ? "--staged" : "", str(a.ref) ?? "", str(a.path) ?? ""].filter(Boolean).join(" ");
    case "update_plan":
      return Array.isArray(a.steps) ? `${a.steps.length} steps` : fallback;
    default:
      return oneLine(fallback, 100);
  }
}

function firstErrorLine(r: ToolResult): string {
  const text = r.output.split("--- stderr ---")[1] ?? r.output.split("--- stdout ---")[1] ?? "";
  return text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
}

function toolView(e: Extract<AgentEvent, { type: "tool_end" }>, approved: boolean, theme: UiOptions["theme"], plan: Plan | null): ToolView {
  const r = e.result;
  const d = r.data ?? {};
  const summary = argSummary(e.name, e.args, e.summary, d);
  if (e.outcome === "denied")
    return { glyph: "denied", name: e.name, summary, muteSummary: true, detail: e.deniedBy === "user" ? "denied by you" : "blocked by policy" };
  if (e.outcome === "cancelled") return { glyph: "cancelled", name: e.name, summary, muteSummary: true, detail: "cancelled" };
  if (e.outcome === "error" || !r.ok) {
    const code = r.error?.code ?? "error";
    return { glyph: "error", name: e.name, summary, detail: code.replace(/_/g, " "), sub: [{ text: oneLine(r.error?.message ?? r.output, 200), color: theme.error }] };
  }
  const secs = `${((Number(d.durationMs ?? e.durationMs) || 0) / 1000).toFixed(1)}s`;
  if ("exitCode" in d && "command" in d) {
    const exit = d.timedOut ? `timed out · ${secs}` : `exit ${d.exitCode ?? d.signal} · ${secs}`;
    if (e.name === "run_tests") {
      const counts = d.counts as TestCounts | undefined;
      const sub = counts
        ? counts.failed > 0
          ? [{ text: `${counts.failed} of ${counts.total} failed`, color: theme.error }]
          : [{ text: `${counts.passed} of ${counts.total} passed`, color: theme.success }]
        : undefined;
      return { glyph: "ok", name: e.name, summary, detail: exit, ...(sub ? { sub } : {}) };
    }
    if (d.exitCode !== 0) {
      const line = firstErrorLine(r);
      return { glyph: "error", name: e.name, summary, detail: exit, ...(line ? { sub: [{ text: line, color: theme.error }] } : {}) };
    }
    return { glyph: "ok", name: e.name, summary, detail: exit };
  }
  let detail: string | undefined;
  if (typeof d.added === "number") detail = `+${d.added} −${d.removed}${approved ? " · approved" : ""}`;
  else if (e.name === "read_file" && typeof d.lines === "number") detail = `${d.lines} line${d.lines === 1 ? "" : "s"}`;
  else if (e.name === "grep_search" && typeof d.matches === "number") detail = `${d.matches} matches`;
  else if (e.name === "glob_files" && typeof d.count === "number") detail = `${d.count} files`;
  else if (e.name === "search_files" && typeof d.count === "number") detail = `${d.count} matches`;
  else if (e.name === "list_directory" && typeof d.entries === "number") detail = `${d.entries} entries`;
  else if (e.name === "git_status") detail = r.output.split("\n")[0]?.replace(/^## /, "");
  let shownSummary = summary;
  if (e.name === "update_plan" && plan) {
    const done = plan.steps.filter((s) => s.status === "completed").length;
    if (done === plan.steps.length) shownSummary = `${done}/${plan.steps.length} done`;
  }
  const diff = typeof d.diff === "string" && !approved ? (d.diff as string) : undefined;
  return { glyph: "ok", name: e.name, summary: shownSummary, ...(detail ? { detail } : {}), ...(diff ? { diff } : {}) };
}

function restoredItems(messages: Message[]): Item[] {
  const items: Item[] = [];
  let tools = 0;
  let lastWasTool = false;
  const flushTools = () => {
    if (tools) items.push({ kind: "output", id: nextId++, text: `(${tools} tool call${tools > 1 ? "s" : ""})` });
    tools = 0;
  };
  for (const m of messages) {
    if (m.role === "user" && !m.content.startsWith("[Sutra:")) {
      flushTools();
      items.push({ kind: "user", id: nextId++, text: m.content });
      lastWasTool = false;
    } else if (m.role === "assistant") {
      if (m.content.trim()) {
        flushTools();
        items.push({ kind: "assistant", id: nextId++, text: m.content, leadingPipe: lastWasTool });
      }
      tools += m.toolCalls?.length ?? 0;
      lastWasTool = !!m.toolCalls?.length;
    }
  }
  flushTools();
  return items.slice(-30);
}

export function App(props: AppProps) {
  const { ui, config, store, provider, bridge } = props;
  const th = ui.theme;
  const g = threadGlyphs(ui.color);
  const app = useApp();
  const [session, setSession] = useState(props.initialSession);
  const [items, setItems] = useState<Item[]>(() => [{ kind: "welcome", id: nextId++ }, ...(props.initialSession.resumed ? restoredItems(props.initialSession.restored) : [])]);
  const [live, setLive] = useState("");
  const [running, setRunning] = useState<Map<string, { name: string; summary: string; tail: string[]; startedAt: number }>>(new Map());
  const [approval, setApproval] = useState<{ req: ApprovalRequest; resolve: (c: ApprovalChoice) => void } | null>(null);
  const [status, setStatus] = useState<AgentStatus>("idle");
  const [reasoning, setReasoning] = useState(0);
  const [busy, setBusy] = useState(false);
  const [totals, setTotals] = useState({ ...props.initialSession.usage.totals });
  const [lastInput, setLastInput] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [queue, setQueue] = useState<string[]>([]);
  const [palette, setPalette] = useState<PaletteState | null>(null);
  const [exitArmed, setExitArmed] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const approvedIds = useRef(new Set<string>());
  const liveRef = useRef("");
  const lastKind = useRef<"tool" | "text" | "other">("other");
  const pendingPlan = useRef<Plan | null>(null);
  const turnNo = useRef(0);
  const now = useNow(busy);
  const frame = useSpinnerFrame(ui);
  const width = useContentWidth();

  const push = useCallback((...it: Item[]) => setItems((xs) => [...xs, ...it]), []);
  const notice = useCallback(
    (level: "info" | "warn" | "error", text: string, label?: string, hint?: string) =>
      push({ kind: "notice", id: nextId++, level, text, ...(label ? { label } : {}), ...(hint ? { hint } : {}) }),
    [push],
  );

  // Approval bridge
  useEffect(() => {
    bridge.handler = (req) =>
      new Promise<ApprovalChoice>((resolve) => {
        setApproval({
          req,
          resolve: (c) => {
            if (c !== "deny") approvedIds.current.add(req.toolCallId);
            setApproval(null);
            resolve(c);
          },
        });
      });
    return () => {
      bridge.handler = null;
    };
  }, [bridge]);

  // Runtime events → UI. Everything rendered here comes from a real event.
  useEffect(() => {
    const flushLive = () => {
      liveRef.current = "";
      setLive("");
    };
    const off = session.runtime.on((e: AgentEvent) => {
      switch (e.type) {
        case "status":
          setStatus(e.status);
          break;
        case "turn_start":
          turnNo.current = e.turn;
          lastKind.current = "other";
          push({ kind: "heading", id: nextId++, turn: e.turn });
          break;
        case "inference_start":
          setReasoning(0);
          break;
        case "text_delta":
          liveRef.current += e.text;
          setLive(liveRef.current);
          break;
        case "reasoning_progress":
          setReasoning((r) => r + e.chars);
          break;
        case "stream_reset":
          flushLive();
          notice("warn", `interrupted (${oneLine(e.reason, 80)}); retrying the request.`, "Stream");
          break;
        case "inference_retry":
          notice("warn", `${oneLine(e.reason, 100)} — retry ${e.attempt} in ${(e.delayMs / 1000).toFixed(1)}s`, "Provider");
          break;
        case "assistant_message":
          flushLive();
          if (e.content.trim()) {
            push({ kind: "assistant", id: nextId++, text: e.content, leadingPipe: lastKind.current === "tool" });
            lastKind.current = "text";
          }
          break;
        case "tool_start":
          setRunning((m) => new Map(m).set(e.toolCallId, { name: e.name, summary: argSummary(e.name, e.args, e.summary), tail: [], startedAt: Date.now() }));
          break;
        case "tool_progress":
          setRunning((m) => {
            const cur = m.get(e.toolCallId);
            if (!cur) return m;
            const tail = [...cur.tail, ...e.chunk.split("\n")].filter((l) => l.trim()).slice(-3);
            return new Map(m).set(e.toolCallId, { ...cur, tail });
          });
          break;
        case "plan":
          pendingPlan.current = e.plan;
          break;
        case "tool_end": {
          setRunning((m) => {
            const n = new Map(m);
            n.delete(e.toolCallId);
            return n;
          });
          const view = toolView(e, approvedIds.current.has(e.toolCallId), th, pendingPlan.current);
          push({ kind: "tool", id: nextId++, view });
          if (e.name === "update_plan" && e.outcome === "ok" && pendingPlan.current) {
            push({ kind: "plan", id: nextId++, plan: pendingPlan.current });
          }
          lastKind.current = "tool";
          break;
        }
        case "usage":
          setTotals({ ...e.totals });
          if (e.usage) setLastInput(e.usage.inputTokens);
          break;
        case "budget_warning":
          notice("warn", `Spend ${formatUsd(e.spentUsd)} is approaching the session budget of ${formatUsd(e.limitUsd)}.`, "Budget", "/budget <usd> to raise it · /budget off to remove it");
          break;
        case "compaction":
          notice(
            "info",
            `compacted${e.manual ? " (manual)" : ""}: ~${e.tokensBefore.toLocaleString("en-US")} → ~${e.tokensAfter.toLocaleString("en-US")} tokens${e.usedModel ? "." : " (model unavailable; mechanical digest)."}`,
            "Context",
          );
          break;
        case "notice":
          notice(e.level, e.message, e.level === "info" ? "Info" : e.level === "warn" ? "Note" : "Error");
          break;
        case "turn_end":
          flushLive();
          setRunning(new Map());
          push({
            kind: "turn",
            id: nextId++,
            result: e.result,
            sessionCostUsd: session.usage.totals.costUsd,
            ...(config.budget.maxSessionCostUsd ? { budgetUsd: config.budget.maxSessionCostUsd } : {}),
          });
          break;
      }
    });
    return off;
  }, [session, push, notice, th, config]);

  const runTurn = useCallback(
    async (text: string) => {
      push({ kind: "user", id: nextId++, text });
      const ac = new AbortController();
      abortRef.current = ac;
      setBusy(true);
      try {
        await session.runtime.runTurn(text, ac.signal);
      } catch (err) {
        notice("error", (err as Error).message);
      } finally {
        abortRef.current = null;
        setBusy(false);
        setStatus("idle");
      }
    },
    [session, push, notice],
  );

  const runCommand = useCallback(
    async (text: string) => {
      push({ kind: "user", id: nextId++, text });
      try {
        const res = await runSlashCommand(text, { session, config, store, provider });
        if (res.output) push({ kind: "output", id: nextId++, text: res.output });
        if (res.action === "exit") app.exit();
        if (res.action === "clear") {
          const next = props.newSession();
          approvedIds.current.clear();
          setSession(next);
          setTotals({ ...next.usage.totals });
          setLastInput(0);
          notice("info", `New session ${next.record.id.slice(0, 8)}.`, "Session");
        }
        if (res.action === "resume" && res.sessionId) {
          const next = props.newSession(res.sessionId);
          approvedIds.current.clear();
          setSession(next);
          setTotals({ ...next.usage.totals });
          setLastInput(0);
          notice(
            "info",
            `Resumed ${next.record.id.slice(0, 8)}${next.record.title ? ` — ${oneLine(next.record.title, 60)}` : ""} (${next.restored.length} messages)${next.repairedToolCalls ? `; repaired ${next.repairedToolCalls} interrupted tool call(s)` : ""}.`,
            "Session",
          );
          push(...restoredItems(next.restored));
        }
      } catch (err) {
        notice("error", (err as Error).message);
      }
    },
    [session, config, store, provider, app, push, notice, props],
  );

  const suggest = useCallback(
    (value: string) =>
      buildSuggestions(value, {
        models: provider.getCapabilities().models,
        currentModel: session.runtime.model,
        profile: session.permissions.policy.profile,
        budgetUsd: config.budget.maxSessionCostUsd,
        sessions: value.startsWith("/sessions ") || value.startsWith("/resume ") ? store.listSessions(session.workspace.root, 30) : [],
        currentSessionId: session.record.id,
      }),
    [provider, session, config, store],
  );

  const submit = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (!text) return;
      setExitArmed(false);
      setHistory((h) => [...h.filter((x) => x !== text), text].slice(-100));
      if (abortRef.current) {
        // A turn is running: queue it as a follow-up.
        setQueue((q) => [...q, text]);
        return;
      }
      void (text.startsWith("/") ? runCommand(text) : runTurn(text));
    },
    [runCommand, runTurn],
  );

  // Drain queued follow-ups once the current turn ends.
  useEffect(() => {
    if (busy || queue.length === 0) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    void (next!.startsWith("/") ? runCommand(next!) : runTurn(next!));
  }, [busy, queue, runCommand, runTurn]);

  // Initial prompt from the command line
  const started = useRef(false);
  useEffect(() => {
    if (props.initialPrompt && !started.current) {
      started.current = true;
      submit(props.initialPrompt);
    }
  }, [props.initialPrompt, submit]);

  const interrupt = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      setQueue([]);
      return;
    }
    if (exitArmed) app.exit();
    else {
      setExitArmed(true);
      notice("info", t("exitHint"), "Exit");
    }
  }, [exitArmed, app, notice]);

  useInput(
    (_input, key) => {
      if (key.escape) interrupt();
    },
    { isActive: busy && !approval && !palette },
  );

  // ----------------------------------------------------------------- render

  const renderItem = (it: Item) => {
    switch (it.kind) {
      case "welcome":
        return (
          <Welcome
            key={it.id}
            ui={ui}
            provider={provider.displayName}
            model={session.runtime.model}
            workspace={tildify(session.workspace.root)}
            profile={session.permissions.policy.profile.replace(/^./, (c) => c.toUpperCase())}
            instructions={session.instructions}
            sandbox={sandboxSummary(session.sandbox)}
            {...(session.resumed ? { session: `${session.record.id.slice(0, 8)} (${t("resumed")})` } : {})}
            notices={props.notices}
          />
        );
      case "user":
        return <UserLine key={it.id} ui={ui} text={it.text} />;
      case "heading":
        return <TurnHeading key={it.id} ui={ui} turn={it.turn} />;
      case "assistant":
        return <AssistantBlock key={it.id} ui={ui} text={it.text} leadingPipe={it.leadingPipe} trailingPipe />;
      case "tool":
        return (
          <Box key={it.id} flexDirection="column">
            <ToolRow ui={ui} connector="branch" glyph={it.view.glyph} name={it.view.name} summary={it.view.summary} {...(it.view.detail ? { detail: it.view.detail } : {})} {...(it.view.muteSummary ? { muteSummary: true } : {})} {...(it.view.sub ? { sub: it.view.sub } : {})} />
            {it.view.diff ? <ThreadDiff ui={ui} diff={it.view.diff} /> : null}
          </Box>
        );
      case "plan":
        return <PlanBox key={it.id} ui={ui} plan={it.plan} />;
      case "notice":
        return (
          <Box key={it.id} marginY={0}>
            <NoticeBlock ui={ui} level={it.level} text={it.text} {...(it.label ? { label: it.label } : {})} {...(it.hint ? { hint: it.hint } : {})} />
          </Box>
        );
      case "output":
        return (
          <Box key={it.id} paddingLeft={2} marginTop={1}>
            <Text>{it.text}</Text>
          </Box>
        );
      case "turn":
        return <TurnSummary key={it.id} ui={ui} result={it.result} sessionCostUsd={it.sessionCostUsd} {...(it.budgetUsd ? { budgetUsd: it.budgetUsd } : {})} />;
    }
  };

  const runningList = [...running.entries()];
  const thinking = busy && status === "thinking" && !live && runningList.length === 0;

  // Footer
  const tokens = (totals.inputTokens + totals.outputTokens).toLocaleString("en-US");
  const budget = config.budget.maxSessionCostUsd;
  const costText = budget ? `${formatUsd(totals.costUsd)} / ${formatUsd(budget)}` : `${formatUsd(totals.costUsd)}${totals.costIncomplete ? "+" : ""}`;
  const ctxFraction = lastInput / Math.max(1, session.context.budget.limit);
  const profile = session.permissions.policy.profile;
  const model = session.runtime.model;
  let footerLeft: React.ReactNode;
  let footerRight: string;
  if (palette) {
    footerLeft =
      palette.kind === "commands"
        ? `${palette.count} match${palette.count === 1 ? "" : "es"} · ↑↓ select · Enter run (▾ opens choices) · Tab complete · Esc close`
        : `${palette.count} option${palette.count === 1 ? "" : "s"} · ↑↓ select · Enter choose · type to filter · Esc close`;
    footerRight = `${model} · ${profile}`;
  } else if (approval) {
    footerLeft = (
      <>
        <Text color={ui.color ? th.accent : undefined}>● {t("awaitingApproval")}</Text> · {model} · {profile} · {tokens} tok · {costText}
      </>
    );
    footerRight = approval.req.decision.grantable ? "y / a / N" : "y / N";
  } else if (busy) {
    const label = status === "thinking" ? (reasoning > 0 ? t("reasoning") : t("thinking")) : t("working");
    footerLeft = (
      <>
        <Text color={ui.color ? th.accent : undefined}>
          {frame} {label}
        </Text>
        {` · ${model} · ${profile} · ${tokens} tok · `}
        <Text color={budget && ui.color ? th.accent : undefined}>{costText}</Text>
        {` · ${contextMeter(ctxFraction, ui.color)}`}
        {queue.length ? ` · ${queue.length} queued` : ""}
      </>
    );
    footerRight = t("runningHint");
  } else {
    footerLeft = (
      <>
        {`${model} · ${profile} · ${tokens} tok · ${costText} · `}
        <Text color={ui.color ? th.success : undefined}>ready</Text>
      </>
    );
    footerRight = width >= 110 ? "Enter send · ⇧Enter newline · /help · Ctrl+C exit" : "/help · Ctrl+C exit";
  }

  return (
    <Box flexDirection="column" paddingX={2}>
      <Static items={items}>{(it) => renderItem(it)}</Static>
      {busy ? (
        <Box flexDirection="column">
          {live ? <AssistantBlock ui={ui} text={live} leadingPipe={lastKind.current === "tool"} /> : null}
          {runningList.map(([id, r], i) => (
            <ToolRow
              key={id}
              ui={ui}
              connector={i === runningList.length - 1 && !approval ? "end" : "branch"}
              glyph="running"
              name={r.name}
              summary={r.summary}
              detail={`${((now - r.startedAt) / 1000).toFixed(1)}s`}
              {...(r.tail.length ? { tail: r.tail } : {})}
            />
          ))}
          {approval ? (
            <>
              <ToolRow ui={ui} connector="end" glyph="waiting" name={approval.req.tool} summary={approval.req.preview?.details?.[0] && approval.req.preview.diff ? approval.req.preview.details.join(", ") : approval.req.summary} detail="waiting on you" />
              <ApprovalCard ui={ui} request={approval.req} onDecide={approval.resolve} />
            </>
          ) : null}
          {thinking ? (
            <Text>
              <Text color={ui.color ? th.accent : undefined}>{g.end}</Text>
              <Text color={ui.color ? th.accent : undefined}>{frame} </Text>
              <Text color={ui.color ? th.muted : undefined}>
                {reasoning > 0 ? `${t("reasoning")}…  ${reasoning.toLocaleString("en-US")} chars` : `${t("thinking")}…`}
              </Text>
            </Text>
          ) : null}
          {queue.map((q, i) => (
            <Text key={i} color={ui.color ? th.muted : undefined} wrap="truncate-end">
              {"   queued › " + q}
            </Text>
          ))}
        </Box>
      ) : null}
      <InputBox
        ui={ui}
        active={!approval}
        busy={busy}
        history={history}
        onSubmit={submit}
        onInterrupt={interrupt}
        onPalette={setPalette}
        suggest={suggest}
        placeholder={busy ? "Type to queue a follow-up…" : t("prompt")}
      />
      <Footer ui={ui} left={footerLeft} right={footerRight} />
    </Box>
  );
}

import { Box, Text, useInput, usePaste, useWindowSize } from "ink";
import React, { useEffect, useMemo, useState } from "react";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import type { ApprovalRequest, TurnResult } from "../core/events/types.js";
import type { Plan } from "../core/planning/plan.js";
import { t } from "../i18n/index.js";
import type { ApprovalChoice } from "../permissions/engine.js";
import { formatUsd } from "../telemetry/cost.js";
import { parseUnifiedDiff, renderMarkdown } from "./highlight.js";
import type { Suggestion, SuggestionList } from "./suggestions.js";
import { threadGlyphs, type Theme } from "./theme.js";

export interface UiOptions {
  theme: Theme;
  color: boolean;
}

/** Colour helper: returns undefined (terminal default) when colour is off. */
export const col = (ui: UiOptions, c: string | undefined) => (ui.color ? c : undefined);

/** Usable content width: the terminal minus Sutra's 2-column gutters, capped for readability. */
export function useContentWidth(): number {
  const { columns } = useWindowSize();
  return Math.max(40, Math.min(columns || 80, 124) - 4);
}

export function truncate(s: string, max: number): string {
  if (max <= 1) return "";
  if (stringWidth(s) <= max) return s;
  let out = "";
  for (const ch of s) {
    if (stringWidth(out + ch) > max - 1) break;
    out += ch;
  }
  return out + "…";
}

const fmtInt = (n: number) => n.toLocaleString("en-US");

// ------------------------------------------------------------------ spinner

export function useSpinnerFrame(ui: UiOptions): string {
  const frames = ui.color ? ["◐", "◓", "◑", "◒"] : ["-", "\\", "|", "/"];
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setI((x) => (x + 1) % frames.length), 120);
    return () => clearInterval(id);
  }, [frames.length]);
  return frames[i]!;
}

export function Spinner(props: { ui: UiOptions }) {
  const frame = useSpinnerFrame(props.ui);
  return <Text color={col(props.ui, props.ui.theme.accent)}>{frame}</Text>;
}

/** Re-renders periodically; used for elapsed-time readouts. */
export function useNow(active: boolean, ms = 250): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  return now;
}

// ------------------------------------------------------------------ welcome

/** Brand mark, terminal-safe: a headline (शिरोरेखा) with a thread that ends in a node. */
export const MARK = ["━━━┯━━━", "   ╰─╮ ", "   ╭─╯ ", "   ●   "];
const MARK_ASCII = ["---+---", "   \\_. ", "   ._/ ", "   o   "];

const PROFILE_HINT: Record<string, string> = {
  inspect: "read-only; no edits or commands",
  confirm: "writes and commands ask first",
  flow: "routine edits run; risky actions ask",
};

export function Welcome(props: {
  ui: UiOptions;
  model: string;
  provider: string;
  workspace: string;
  profile: string;
  session?: string;
  sandbox?: string;
  instructions: { path: string; scope: string }[];
  notices: string[];
}) {
  const { ui } = props;
  const width = useContentWidth();
  const accent = col(ui, ui.theme.accent);
  const muted = col(ui, ui.theme.muted);
  const valueWidth = width - 14;
  const fit = (v: string) => (stringWidth(v) > valueWidth ? "…" + v.slice(v.length - valueWidth + 1) : v);
  const row = (k: string, v: React.ReactNode) => (
    <Text wrap="truncate-end">
      <Text color={muted}>{k.padEnd(12)}</Text>
      {v}
    </Text>
  );
  const profileKey = props.profile.toLowerCase();
  const scope = (s: string) => (s === "user" ? "user" : "repository");
  return (
    <Box flexDirection="column" paddingTop={1}>
      <Box gap={4} paddingLeft={2}>
        <Box flexDirection="column">
          {(ui.color ? MARK : MARK_ASCII).map((l, i) => (
            <Text key={i} color={accent} bold>
              {l}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column">
          <Text color={accent} bold>
            सूत्र
          </Text>
          <Text bold>S U T R A</Text>
          <Text> </Text>
          <Text color={muted}>{t("tagline")}</Text>
        </Box>
      </Box>
      <Box flexDirection="column" marginTop={1} paddingLeft={2}>
        {row(t("model"), `${props.provider} · ${props.model}`)}
        {row(t("workspace"), fit(props.workspace))}
        {row(
          t("permission"),
          <>
            <Text color={accent}>●</Text> {props.profile}
            {"  "}
            <Text color={muted}>{PROFILE_HINT[profileKey] ?? ""}</Text>
          </>,
        )}
        {props.sandbox ? row("Sandbox", <Text color={/unavailable|off/.test(props.sandbox) ? muted : undefined}>{props.sandbox}</Text>) : null}
        {props.instructions.length
          ? row(
              "Instructions",
              <>
                {props.instructions.map((i) => i.path).join(", ")}
                {"  "}
                <Text color={muted}>({[...new Set(props.instructions.map((i) => scope(i.scope)))].join(", ")})</Text>
              </>,
            )
          : null}
        {props.session ? row(t("session"), props.session) : null}
      </Box>
      <Box flexDirection="column" marginTop={1} paddingLeft={2}>
        <Text color={muted}>{"─".repeat(Math.min(75, width - 2))}</Text>
        <Text wrap="truncate-end">
          <Text color={muted}>{"Try   "}</Text>
          <Text color={col(ui, ui.theme.info)}>"Explain this repository"</Text>
        </Text>
        <Text wrap="truncate-end">
          <Text color={muted}>{"      "}</Text>
          <Text color={accent}>/help</Text>
          <Text color={muted}> commands   </Text>
          <Text color={accent}>/model</Text>
          <Text color={muted}> switch model   </Text>
          <Text color={accent}>/sessions</Text>
          <Text color={muted}> resume</Text>
        </Text>
      </Box>
      {props.notices.map((n, i) => (
        <Box key={i} paddingLeft={2}>
          <Text color={col(ui, ui.theme.info)}>{n}</Text>
        </Box>
      ))}
    </Box>
  );
}

// ------------------------------------------------------------------- thread

export function UserLine(props: { ui: UiOptions; text: string }) {
  return (
    <Box marginTop={1}>
      <Text color={col(props.ui, props.ui.theme.accent)} bold>
        {"› "}
      </Text>
      <Text bold>{props.text}</Text>
    </Box>
  );
}

export function TurnHeading(props: { ui: UiOptions; turn: number; plan?: boolean }) {
  const { ui } = props;
  return (
    <Box marginTop={1}>
      <Text>
        <Text color={col(ui, ui.theme.accent)} bold>
          Sutra
        </Text>
        <Text color={col(ui, ui.theme.muted)}>{"  /  turn " + props.turn}</Text>
        {props.plan ? (
          <>
            <Text color={col(ui, ui.theme.muted)}>{"  ·  "}</Text>
            <Text color={col(ui, ui.theme.info)} bold>
              plan mode
            </Text>
            <Text color={col(ui, ui.theme.muted)}> — read-only, nothing will be changed</Text>
          </>
        ) : null}
      </Text>
    </Box>
  );
}

export function ThreadPipe(props: { ui: UiOptions }) {
  return <Text color={col(props.ui, props.ui.theme.accent)}>{threadGlyphs(props.ui.color).pipe}</Text>;
}

/** Assistant prose on the thread: every line prefixed with "│ ". */
export function AssistantBlock(props: { ui: UiOptions; text: string; leadingPipe?: boolean; trailingPipe?: boolean }) {
  const { ui } = props;
  const width = useContentWidth();
  const g = threadGlyphs(ui.color);
  const body = wrapAnsi(renderMarkdown(props.text.trim(), ui.theme, ui.color), width - 2, { hard: true, trim: false });
  const pipe = col(ui, ui.theme.accent);
  return (
    <Box flexDirection="column">
      {props.leadingPipe ? <Text color={pipe}>{g.pipe}</Text> : null}
      {body.split("\n").map((l, i) => (
        <Text key={i}>
          <Text color={pipe}>{g.pipe} </Text>
          {l}
        </Text>
      ))}
      {props.trailingPipe ? <Text color={pipe}>{g.pipe}</Text> : null}
    </Box>
  );
}

export type ToolGlyph = "ok" | "error" | "denied" | "cancelled" | "running" | "waiting";

export function ToolRow(props: {
  ui: UiOptions;
  connector: "branch" | "end";
  glyph: ToolGlyph;
  name: string;
  summary: string;
  detail?: string;
  muteSummary?: boolean;
  sub?: { text: string; color?: string }[];
  tail?: string[];
}) {
  const { ui } = props;
  const width = useContentWidth();
  const g = threadGlyphs(ui.color);
  const frame = useSpinnerFrame(ui);
  const th = ui.theme;
  const glyph: Record<ToolGlyph, [string, string | undefined]> = {
    ok: ["✓", th.success],
    error: ["✗", th.error],
    denied: ["⊘", th.muted],
    cancelled: ["–", th.muted],
    running: [frame, th.accent],
    waiting: ["●", th.accent],
  };
  const [gl, gc] = glyph[props.glyph];
  const name = props.name.padEnd(16);
  const detail = props.detail ?? "";
  const lead = 3 + 2 + stringWidth(name);
  const summary = truncate(props.summary, Math.max(8, width - lead - stringWidth(detail) - 2));
  const pad = Math.max(2, width - lead - stringWidth(summary) - stringWidth(detail));
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text color={col(ui, th.accent)}>{props.connector === "end" ? g.end : g.branch}</Text>
        <Text color={col(ui, gc)}>{gl} </Text>
        <Text color={col(ui, th.info)}>{name}</Text>
        <Text color={props.muteSummary ? col(ui, th.muted) : undefined}>{summary}</Text>
        <Text color={col(ui, th.muted)}>{" ".repeat(pad) + detail}</Text>
      </Text>
      {props.sub?.map((s, i) => (
        <Text key={i} wrap="truncate-end">
          <Text color={col(ui, th.accent)}>{g.pipe}{"  "}</Text>
          {" ".repeat(18)}
          <Text color={col(ui, s.color ?? th.muted)}>{truncate(s.text, width - 21)}</Text>
        </Text>
      ))}
      {props.tail?.map((l, i) => (
        <Text key={`t${i}`} color={col(ui, th.muted)} wrap="truncate-end">
          {" ".repeat(21)}▏ {truncate(l, width - 23)}
        </Text>
      ))}
    </Box>
  );
}

/** The plan, drawn as a small box hanging off the thread. */
export function PlanBox(props: { ui: UiOptions; plan: Plan }) {
  const { ui, plan } = props;
  const width = useContentWidth();
  const th = ui.theme;
  const g = threadGlyphs(ui.color);
  const inner = Math.min(52, width - 8);
  const done = plan.steps.filter((s) => s.status === "completed").length;
  const title = " Plan ";
  const count = ` ${done}/${plan.steps.length} `;
  const top = `┌${title}${"─".repeat(Math.max(1, inner - title.length - count.length))}${count}┐`;
  const mark = (s: Plan["steps"][number]["status"]): [string, string] =>
    s === "completed" ? ["✓", th.success] : s === "active" ? ["◐", th.accent] : s === "blocked" ? ["!", th.error] : ["○", th.muted];
  const pipe = <Text color={col(ui, th.accent)}>{g.pipe}{"  "}</Text>;
  return (
    <Box flexDirection="column">
      <Text>
        {pipe}
        <Text color={col(ui, th.muted)}>{"  " + top}</Text>
      </Text>
      {plan.steps.map((s, i) => {
        const [m, c] = mark(s.status);
        const label = truncate(s.title + (s.note ? ` — ${s.note}` : ""), inner - 4);
        const fill = " ".repeat(Math.max(0, inner - 3 - stringWidth(label)));
        return (
          <Text key={i}>
            {pipe}
            <Text color={col(ui, th.muted)}>{"  │ "}</Text>
            <Text color={col(ui, c)}>{m}</Text> <Text color={s.status === "pending" ? col(ui, th.muted) : undefined}>{label}</Text>
            <Text color={col(ui, th.muted)}>{fill}│</Text>
          </Text>
        );
      })}
      <Text>
        {pipe}
        <Text color={col(ui, th.muted)}>{"  └" + "─".repeat(inner) + "┘"}</Text>
      </Text>
    </Box>
  );
}

/** Tinted notice block (budget, context, errors). */
export function NoticeBlock(props: { ui: UiOptions; level: "info" | "warn" | "error"; label?: string; text: string; hint?: string }) {
  const { ui } = props;
  const th = ui.theme;
  const fg = props.level === "info" ? th.info : props.level === "warn" ? th.accent : th.error;
  const bg = props.level === "info" ? th.infoBg : props.level === "warn" ? th.warnBg : th.removeBg;
  const mark = props.level === "info" ? "i" : "!";
  return (
    <Box flexDirection="column" paddingX={1} marginY={0} {...(ui.color ? { backgroundColor: bg } : {})}>
      <Text>
        <Text color={col(ui, fg)} bold>
          {mark} {props.label ?? (props.level === "info" ? "Info" : props.level === "warn" ? "Warning" : "Error")}
        </Text>
        {"  "}
        {props.text}
      </Text>
      {props.hint ? <Text color={col(ui, th.muted)}>{"          " + props.hint}</Text> : null}
    </Box>
  );
}

// --------------------------------------------------------------------- diff

export function DiffPanel(props: { ui: UiOptions; diff: string; maxRows?: number }) {
  const { ui } = props;
  const th = ui.theme;
  const width = useContentWidth();
  const rows = useMemo(() => parseUnifiedDiff(props.diff), [props.diff]);
  const multiFile = rows.filter((r) => r.kind === "file").length > 1;
  const max = props.maxRows ?? 40;
  const shown = rows.filter((r) => r.kind !== "file" || multiFile).slice(0, max);
  const more = rows.length - shown.length;
  const inner = Math.max(30, width - 10);
  const num = (n?: number) => (n === undefined ? "   " : String(n).padStart(3));
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={col(ui, th.borderDim)} {...(ui.color ? { backgroundColor: th.panel } : {})} paddingX={1}>
      {shown.map((r, i) => {
        if (r.kind === "file")
          return (
            <Text key={i} bold>
              {r.text}
            </Text>
          );
        if (r.kind === "hunk")
          return (
            <Text key={i} color={col(ui, th.info)} wrap="truncate-end">
              {r.text}
            </Text>
          );
        const sign = r.kind === "add" ? "+" : r.kind === "remove" ? "−" : " ";
        const line = truncate(`${sign}  ${r.text.replace(/\t/g, "  ")}`, inner - 8);
        const padded = line + " ".repeat(Math.max(0, inner - 8 - stringWidth(line)));
        const fg = r.kind === "add" ? th.success : r.kind === "remove" ? th.error : undefined;
        const bg = r.kind === "add" ? th.addBg : r.kind === "remove" ? th.removeBg : undefined;
        return (
          <Text key={i} wrap="truncate-end">
            <Text color={col(ui, th.faint)}>{`${num(r.oldNo)} ${num(r.newNo)} `}</Text>
            <Text color={col(ui, fg)} {...(ui.color && bg ? { backgroundColor: bg } : {})}>
              {ui.color ? padded : line}
            </Text>
          </Text>
        );
      })}
      {more > 0 ? <Text color={col(ui, th.muted)}>… {more} more line{more === 1 ? "" : "s"}</Text> : null}
    </Box>
  );
}

/** A compact diff that stays on the thread (used when no approval prompt showed it). */
export function ThreadDiff(props: { ui: UiOptions; diff: string; maxRows?: number }) {
  const { ui } = props;
  const th = ui.theme;
  const width = useContentWidth();
  const g = threadGlyphs(ui.color);
  const rows = useMemo(() => parseUnifiedDiff(props.diff).filter((r) => r.kind === "add" || r.kind === "remove" || r.kind === "hunk"), [props.diff]);
  const max = props.maxRows ?? 12;
  const shown = rows.slice(0, max);
  const more = rows.length - shown.length;
  const inner = width - 13;
  const pipe = <Text color={col(ui, th.accent)}>{g.pipe}{"  "}</Text>;
  return (
    <Box flexDirection="column">
      {shown.map((r, i) => {
        if (r.kind === "hunk")
          return (
            <Text key={i} wrap="truncate-end">
              {pipe}
              <Text color={col(ui, th.faint)}>{"   " + r.text}</Text>
            </Text>
          );
        const sign = r.kind === "add" ? "+" : "−";
        const no = String((r.kind === "add" ? r.newNo : r.oldNo) ?? "").padStart(4);
        const line = truncate(`${sign}  ${r.text.replace(/\t/g, "  ")}`, inner);
        const padded = line + " ".repeat(Math.max(0, inner - stringWidth(line)));
        const fg = r.kind === "add" ? th.success : th.error;
        const bg = r.kind === "add" ? th.addBg : th.removeBg;
        return (
          <Text key={i} wrap="truncate-end">
            {pipe}
            <Text color={col(ui, th.faint)}>{no + "  "}</Text>
            <Text color={col(ui, fg)} {...(ui.color ? { backgroundColor: bg } : {})}>
              {ui.color ? padded : line}
            </Text>
          </Text>
        );
      })}
      {more > 0 ? (
        <Text>
          {pipe}
          <Text color={col(ui, th.muted)}>{`      … ${more} more line${more === 1 ? "" : "s"} (git_diff for the full change)`}</Text>
        </Text>
      ) : null}
    </Box>
  );
}

// ----------------------------------------------------------------- approval

function Key(props: { ui: UiOptions; k: string; strong?: boolean }) {
  const { ui } = props;
  if (!ui.color) return <Text bold>[{props.k}]</Text>;
  return (
    <Text backgroundColor={props.strong ? ui.theme.selectBg : ui.theme.panel} color={props.strong ? ui.theme.accent : undefined} bold>
      {` ${props.k} `}
    </Text>
  );
}

export function ApprovalCard(props: { ui: UiOptions; request: ApprovalRequest; onDecide: (c: ApprovalChoice) => void }) {
  const { ui, request } = props;
  const th = ui.theme;
  const grantable = request.decision.grantable;
  useInput((input, key) => {
    const k = input.toLowerCase();
    if (k === "y") props.onDecide("once");
    else if (k === "a" && grantable) props.onDecide("session");
    else if (k === "n" || key.return || key.escape) props.onDecide("deny");
  });
  const preview = request.preview;
  const stats = preview?.summary.match(/^\+(\d+) \/ -(\d+)/);
  const target = preview?.details?.length && preview.diff ? preview.details.join(", ") : request.summary;
  const grantLabel = request.decision.grantKey?.startsWith("exec:") ? "allow this command this session" : "allow edits this session";
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={col(ui, th.accent)} paddingX={2}>
      <Box justifyContent="space-between">
        <Text wrap="truncate-end">
          <Text {...(ui.color ? { backgroundColor: th.accent, color: th.onAccent } : {})} bold>
            {ui.color ? " APPROVE " : "[APPROVE]"}
          </Text>
          {"  "}
          <Text color={col(ui, th.info)}>{request.tool}</Text>
          {"  "}
          <Text bold>{target}</Text>
        </Text>
        {stats ? <Text color={col(ui, th.muted)}>{`+${stats[1]} −${stats[2]}`}</Text> : null}
      </Box>
      <Text color={col(ui, th.muted)}>Reason   {request.decision.reason}</Text>
      {!preview?.diff && preview?.details?.length ? (
        <Box flexDirection="column">
          {preview.details.map((d, i) => (
            <Text key={i} color={col(ui, th.muted)}>
              {"         " + d}
            </Text>
          ))}
        </Box>
      ) : null}
      {preview?.diff ? (
        <Box marginTop={1}>
          <DiffPanel ui={ui} diff={preview.diff} maxRows={30} />
        </Box>
      ) : null}
      {request.decision.warnings.map((w, i) => (
        <Text key={i} color={col(ui, th.error)}>
          ! {w}
        </Text>
      ))}
      <Box marginTop={1} gap={3} flexWrap="wrap">
        <Text>{t("approveQuestion")}</Text>
        <Text>
          <Key ui={ui} k="y" strong /> {t("approveYes")}
        </Text>
        {grantable ? (
          <Text>
            <Key ui={ui} k="a" strong /> {grantLabel}
          </Text>
        ) : null}
        <Text>
          <Key ui={ui} k="N" /> {t("approveNo")}
        </Text>
      </Box>
    </Box>
  );
}

// ------------------------------------------------------------- turn summary

export function TurnSummary(props: { ui: UiOptions; result: TurnResult; budgetUsd?: number; sessionCostUsd: number }) {
  const { ui, result } = props;
  const th = ui.theme;
  const width = useContentWidth();
  const g = threadGlyphs(ui.color);
  const label = { completed: t("complete"), failed: t("failed"), cancelled: t("cancelled"), budget_exceeded: t("paused") }[result.status];
  const color = { completed: th.success, failed: th.error, cancelled: th.muted, budget_exceeded: th.accent }[result.status];
  const secs = result.durationMs >= 60_000 ? `${Math.floor(result.durationMs / 60_000)}m ${Math.round((result.durationMs % 60_000) / 1000)}s` : `${Math.max(1, Math.round(result.durationMs / 1000))}s`;
  const meta = `  ·  ${result.iterations} iteration${result.iterations === 1 ? "" : "s"} · ${result.toolCalls} tool call${result.toolCalls === 1 ? "" : "s"} · ${secs}`;

  const last = result.testsRun[result.testsRun.length - 1];
  const cachedPct = result.inputTokens ? Math.round((result.cachedInputTokens / result.inputTokens) * 100) : 0;
  const cards: { label: string; value: string; valueColor?: string; sub: string }[] = [
    {
      label: "FILES CHANGED",
      value: String(result.filesChanged.length),
      sub: result.filesChanged.length ? result.filesChanged[0]! + (result.filesChanged.length > 1 ? ` +${result.filesChanged.length - 1} more` : "") : "none",
    },
    {
      label: "TESTS",
      value: last ? (last.passed ? "✓ passed" : "✗ failed") : "not run",
      ...(last ? { valueColor: last.passed ? th.success : th.error } : {}),
      sub: last
        ? last.counts
          ? `${last.counts.passed} of ${last.counts.total} passed${result.testsRun.length > 1 ? ` · ${result.testsRun.length} runs` : ""}`
          : `${last.command}${result.testsRun.length > 1 ? ` · ${result.testsRun.length} runs` : ""}`
        : "—",
    },
    { label: "TOKENS", value: `${fmtInt(result.inputTokens)} in`, sub: `${fmtInt(result.outputTokens)} out · ${cachedPct}% cached` },
    {
      label: "ESTIMATED COST",
      value: formatUsd(result.costUsd),
      valueColor: th.accent,
      sub: props.budgetUsd ? `budget ${formatUsd(props.budgetUsd)} · ${((props.sessionCostUsd / props.budgetUsd) * 100).toFixed(1)}%` : `session ${formatUsd(props.sessionCostUsd)}`,
    },
  ];
  const cardWidth = width >= 88 ? Math.floor((width - 3) / 4) : Math.floor((width - 1) / 2);
  return (
    <Box flexDirection="column">
      <Text color={col(ui, th.accent)}>{g.node}</Text>
      <Box marginTop={1} flexDirection="column" borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false} borderColor={col(ui, th.borderDim)}>
        <Text wrap="truncate-end">
          <Text color={col(ui, th.accent)} bold>
            Sutra
          </Text>
          <Text color={col(ui, th.muted)}>{"  /  "}</Text>
          <Text color={col(ui, color)} bold>
            {label}
          </Text>
          <Text color={col(ui, th.muted)}>{meta}</Text>
        </Text>
        {result.reason ? <Text color={col(ui, color)}>{result.reason}</Text> : null}
        <Box marginTop={1} flexWrap="wrap" columnGap={1}>
          {cards.map((c) => (
            <Box key={c.label} width={cardWidth} flexDirection="column" borderStyle="round" borderColor={col(ui, th.borderDim)} paddingX={1}>
              <Text color={col(ui, th.muted)}>{c.label}</Text>
              <Text bold color={col(ui, c.valueColor)} wrap="truncate-end">
                {c.value}
              </Text>
              <Text color={col(ui, th.muted)} wrap="truncate-end">
                {c.sub}
              </Text>
            </Box>
          ))}
        </Box>
      </Box>
    </Box>
  );
}

// -------------------------------------------------------------------- input

export interface PaletteState {
  kind: "commands" | "choices";
  count: number;
}

/** First selectable row: the current value if there is one, else the first enabled row. */
function initialSelection(list: SuggestionList | null): number {
  if (!list) return 0;
  const cur = list.items.findIndex((i) => i.current && !i.disabled);
  if (cur >= 0) return cur;
  const first = list.items.findIndex((i) => !i.disabled && !i.dim);
  return first >= 0 ? first : 0;
}

function step(list: SuggestionList, from: number, dir: 1 | -1): number {
  const n = list.items.length;
  for (let k = 1; k <= n; k++) {
    const i = (from + dir * k + n) % n;
    if (!list.items[i]!.disabled) return i;
  }
  return from;
}

export function InputBox(props: {
  ui: UiOptions;
  active: boolean;
  busy: boolean;
  history: string[];
  onSubmit: (v: string) => void;
  onInterrupt: () => void;
  onPalette: (p: PaletteState | null) => void;
  suggest: (value: string) => SuggestionList | null;
  placeholder: string;
}) {
  const { ui } = props;
  const th = ui.theme;
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [hist, setHist] = useState(-1);
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const list = useMemo(() => (dismissed ? null : props.suggest(value)), [dismissed, value, props.suggest]);
  const open = !!list && (list.items.length > 0 || list.kind === "choices");
  const selectable = !!list && list.items.some((i) => !i.disabled);

  useEffect(() => {
    props.onPalette(open ? { kind: list!.kind, count: list!.items.filter((i) => !i.dim).length } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, list?.kind, list?.items.length]);

  const set = (v: string, c = v.length) => {
    setValue(v);
    setCursor(c);
    setSel(initialSelection(props.suggest(v)));
    setDismissed(false);
  };
  const insert = (text: string) => set(value.slice(0, cursor) + text + value.slice(cursor), cursor + text.length);

  usePaste((text: string) => insert(text.replace(/\r\n?/g, "\n")), { isActive: props.active });

  const submit = (v: string) => {
    set("");
    setHist(-1);
    props.onSubmit(v);
  };

  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") {
        if (value) set("");
        else props.onInterrupt();
        return;
      }
      if (open && key.escape) {
        setDismissed(true);
        return;
      }
      if (open && selectable && (key.upArrow || key.downArrow)) {
        setSel((s) => step(list!, s, key.upArrow ? -1 : 1));
        return;
      }
      if (open && selectable && key.tab) {
        const item = list!.items[sel]!;
        if (!item.disabled) set(item.fill ?? item.submit ?? value);
        return;
      }
      if (key.return) {
        if (key.shift || key.meta) {
          insert("\n");
          return;
        }
        if (open && selectable) {
          const item = list!.items[sel]!;
          if (item.disabled) return;
          if (item.submit) submit(item.submit);
          else if (item.fill) set(item.fill);
          return;
        }
        submit(value);
        return;
      }
      if (key.backspace || key.delete) {
        if (cursor > 0) set(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
        return;
      }
      if (key.leftArrow) return setCursor((c) => Math.max(0, c - 1));
      if (key.rightArrow) return setCursor((c) => Math.min(value.length, c + 1));
      if (key.upArrow || key.downArrow) {
        const h = props.history;
        if (!h.length) return;
        const next = key.upArrow ? Math.min(h.length - 1, hist + 1) : Math.max(-1, hist - 1);
        setHist(next);
        set(next === -1 ? "" : h[h.length - 1 - next]!);
        return;
      }
      if (key.ctrl && input === "a") return setCursor(0);
      if (key.ctrl && input === "e") return setCursor(value.length);
      if (key.ctrl && input === "u") return set(value.slice(cursor), 0);
      if (key.ctrl && input === "w") {
        const before = value.slice(0, cursor).replace(/\S+\s*$/, "");
        set(before + value.slice(cursor), before.length);
        return;
      }
      if (key.ctrl || key.meta || key.escape || key.tab) return;
      if (input) insert(input);
    },
    { isActive: props.active },
  );

  const caret = props.busy ? (ui.color ? th.border : undefined) : th.accent;
  const before = value.slice(0, cursor);
  const at = value[cursor] ?? " ";
  const after = value.slice(cursor + 1);
  const cursorCell = <Text inverse>{at === "\n" ? " " : at}</Text>;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box borderStyle="round" borderColor={col(ui, props.busy ? th.borderDim : th.border)} paddingX={1}>
        <Text color={col(ui, caret)} bold>
          {"› "}
        </Text>
        {value.length === 0 ? (
          <Text>
            {props.active && !props.busy ? <Text inverse> </Text> : null}
            <Text color={col(ui, th.muted)}>{props.placeholder}</Text>
          </Text>
        ) : (
          <Text>
            {before}
            {props.active ? cursorCell : at}
            {at === "\n" ? "\n" : ""}
            {after}
          </Text>
        )}
      </Box>
      {open ? <Palette ui={ui} list={list!} selected={sel} /> : null}
    </Box>
  );
}

const MAX_ROWS = 9;

function Palette(props: { ui: UiOptions; list: SuggestionList; selected: number }) {
  const { ui, list } = props;
  const th = ui.theme;
  const width = useContentWidth();
  const inner = width - 4;
  const labelW = Math.min(22, Math.max(10, ...list.items.map((i) => stringWidth(i.label) + 2)));
  const detailW = Math.min(30, Math.max(0, ...list.items.map((i) => (i.detail ? stringWidth(i.detail) + 2 : 0))));

  // Keep the selection in view.
  const n = list.items.length;
  const start = n <= MAX_ROWS ? 0 : Math.min(Math.max(0, props.selected - Math.floor(MAX_ROWS / 2)), n - MAX_ROWS);
  const visible = list.items.slice(start, start + MAX_ROWS);
  const firstDim = list.items.findIndex((i) => i.dim);

  const row = (item: Suggestion, index: number) => {
    const selected = index === props.selected;
    const mark = selected ? "▸ " : "  ";
    const cur = item.current ? (ui.color ? "● " : "* ") : "  ";
    const label = truncate(item.label, labelW - 1).padEnd(labelW);
    const detail = truncate(item.detail ?? "", Math.max(0, detailW - 1)).padEnd(detailW);
    const hint = item.disabled ? `${item.disabled}` : (item.hint ?? "");
    const text = truncate(`${mark}${cur}${label}${detail}${hint}`, inner);
    if (selected && !item.disabled) {
      const padded = text + " ".repeat(Math.max(0, inner - stringWidth(text)));
      return (
        <Text key={item.key} color={col(ui, th.accent)} bold {...(ui.color ? { backgroundColor: th.selectBg } : {})}>
          {ui.color ? padded : text}
        </Text>
      );
    }
    const muted = item.dim || item.disabled;
    return (
      <Text key={item.key} wrap="truncate-end">
        <Text color={col(ui, muted ? th.muted : undefined)}>{mark}</Text>
        <Text color={col(ui, item.current ? th.accent : th.muted)}>{cur}</Text>
        <Text color={col(ui, muted ? th.muted : undefined)} bold={!muted && list.kind === "choices"}>
          {label}
        </Text>
        <Text color={col(ui, th.muted)}>{detail}</Text>
        <Text color={col(ui, muted ? th.faint : th.muted)}>{truncate(hint, Math.max(0, inner - 4 - labelW - detailW))}</Text>
      </Text>
    );
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderTop={false} borderColor={col(ui, th.border)} {...(ui.color ? { backgroundColor: th.panel } : {})} paddingX={1}>
      {list.title ? <Text color={col(ui, th.muted)}>{list.title}</Text> : null}
      {start > 0 ? <Text color={col(ui, th.faint)}>{`  ↑ ${start} more`}</Text> : null}
      {visible.map((item, i) => {
        const index = start + i;
        return (
          <React.Fragment key={item.key}>
            {index === firstDim && firstDim > 0 ? <Text color={col(ui, th.faint)}>{"  " + "─".repeat(Math.max(10, inner - 4))}</Text> : null}
            {row(item, index)}
          </React.Fragment>
        );
      })}
      {start + MAX_ROWS < n ? <Text color={col(ui, th.faint)}>{`  ↓ ${n - start - MAX_ROWS} more`}</Text> : null}
    </Box>
  );
}

// ------------------------------------------------------------------- footer

export function Footer(props: { ui: UiOptions; left: React.ReactNode; right: string }) {
  const muted = col(props.ui, props.ui.theme.muted);
  return (
    <Box paddingX={1}>
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        <Text color={muted} wrap="truncate-end">
          {props.left}
        </Text>
      </Box>
      <Box flexShrink={0} marginLeft={2}>
        <Text color={muted}>{props.right}</Text>
      </Box>
    </Box>
  );
}

export function contextMeter(fraction: number, color: boolean): string {
  const cells = 8;
  const filled = Math.min(cells, Math.round(Math.max(0, fraction) * cells));
  const [on, off] = color ? ["▰", "▱"] : ["#", "."];
  return `ctx ${on.repeat(filled)}${off.repeat(cells - filled)} ${Math.round(fraction * 100)}%`;
}

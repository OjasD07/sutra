import { Box, Text } from "ink";
import React from "react";
import type { CostData, StatusData } from "../cli/commands.js";
import type { Plan } from "../core/planning/plan.js";
import { formatUsd } from "../telemetry/cost.js";
import { col, truncate, useContentWidth, type UiOptions } from "./components.js";

const n = (v: number) => v.toLocaleString("en-US");

/** 1,048,576 → "1M", 167,232 → "167K", 2,553 → "2.6K". */
export function compactNumber(v: number): string {
  if (v >= 1_000_000) return `${+(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`;
  if (v >= 10_000) return `${Math.round(v / 1000)}K`;
  if (v >= 1000) return `${+(v / 1000).toFixed(1)}K`;
  return String(v);
}

/** A horizontal bar; `marker` (0..1) draws a tick, e.g. the compaction threshold. */
export function bar(fraction: number, width: number, color: boolean, marker?: number): string {
  const f = Math.max(0, Math.min(1, fraction));
  // Any non-zero amount shows at least one cell, so "a little" never looks like "none".
  const filled = f > 0 ? Math.max(1, Math.round(f * width)) : 0;
  const [on, off, tick] = color ? ["━", "─", "┃"] : ["#", "-", "|"];
  const cells = Array.from({ length: width }, (_, i) => (i < filled ? on : off));
  if (marker !== undefined) {
    const at = Math.min(width - 1, Math.max(0, Math.round(marker * width)));
    if (at >= filled) cells[at] = tick;
  }
  return cells.join("");
}

function Header(props: { ui: UiOptions; title: string; right?: string }) {
  const { ui } = props;
  const width = useContentWidth();
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box justifyContent="space-between" width={width}>
        <Text>
          <Text color={col(ui, ui.theme.accent)} bold>
            Sutra
          </Text>
          <Text color={col(ui, ui.theme.muted)}>{"  /  "}</Text>
          <Text bold>{props.title}</Text>
        </Text>
        {props.right ? <Text color={col(ui, ui.theme.muted)}>{props.right}</Text> : null}
      </Box>
      <Text color={col(ui, ui.theme.borderDim)}>{"─".repeat(width)}</Text>
    </Box>
  );
}

function Row(props: { ui: UiOptions; label: string; children: React.ReactNode }) {
  return (
    <Text wrap="truncate-end">
      <Text color={col(props.ui, props.ui.theme.muted)}>{props.label.padEnd(14)}</Text>
      {props.children}
    </Text>
  );
}

function Dot(props: { ui: UiOptions; color: string }) {
  return <Text color={col(props.ui, props.color)}>{props.ui.color ? "●" : "*"}</Text>;
}

const PROFILE_HINT: Record<string, string> = {
  inspect: "read-only; no edits or commands",
  confirm: "writes and commands ask first",
  flow: "routine edits and checks run; risky actions ask",
};

export function StatusView(props: { ui: UiOptions; data: StatusData }) {
  const { ui, data: d } = props;
  const th = ui.theme;
  const width = useContentWidth();
  const m = col(ui, th.muted);
  const meterWidth = Math.max(12, Math.min(32, width - 52));
  const used = d.contextTokens / Math.max(1, d.contextBudget);
  const usedColor = used >= d.compactAt ? th.error : used >= d.compactAt * 0.8 ? th.accent : th.success;
  const profile = d.profile.replace(/^./, (c) => c.toUpperCase());
  return (
    <Box flexDirection="column">
      <Header ui={ui} title="status" right={`session ${d.sessionId.slice(0, 8)}${d.resumed ? " · resumed" : ""}`} />
      <Row ui={ui} label="Model">
        <Text bold>{d.model}</Text>
        <Text color={m}>{`  ${d.provider}${d.thinking ? ` · thinking ${d.thinking}` : ""}`}</Text>
      </Row>
      <Row ui={ui} label="Context">
        <Text color={col(ui, usedColor)}>{bar(used, meterWidth, ui.color, d.compactAt)}</Text>
        <Text>{`  ${compactNumber(d.contextTokens)}`}</Text>
        <Text color={m}>{` / ${compactNumber(d.contextBudget)} · compacts at ${Math.round(d.compactAt * 100)}% · window ${compactNumber(d.contextWindow)}`}</Text>
      </Row>
      <Row ui={ui} label="Permission">
        <Dot ui={ui} color={th.accent} /> <Text bold>{profile}</Text>
        <Text color={m}>{`  ${PROFILE_HINT[d.profile] ?? ""}`}</Text>
      </Row>
      <Row ui={ui} label="Quality">
        <Dot ui={ui} color={d.quality === "fast" ? th.muted : th.success} /> <Text bold>{d.quality}</Text>
        <Text color={m}>{`  ${{ fast: "evidence labels only", balanced: "finish gate · review · counterexamples", deep: "+ competing patches" }[d.quality] ?? ""}`}</Text>
      </Row>
      <Row ui={ui} label="Sandbox">
        <Dot ui={ui} color={d.sandbox.active ? th.success : th.muted} /> <Text color={d.sandbox.active ? undefined : m}>{d.sandbox.text}</Text>
      </Row>
      <Row ui={ui} label="Index">
        <Dot ui={ui} color={d.index ? th.success : th.muted} />{" "}
        {d.index ? (
          <>
            <Text>{`${n(d.index.files)} files · ${n(d.index.symbols)} symbols`}</Text>
            <Text color={m}>{`  ${d.index.mode}`}</Text>
          </>
        ) : (
          <Text color={m}>disabled</Text>
        )}
      </Row>
      <Row ui={ui} label="Instructions">
        {d.instructions.length ? <Text>{d.instructions.join(", ")}</Text> : <Text color={m}>none · add AGENTS.md or .sutra/AGENTS.md</Text>}
      </Row>
      <Row ui={ui} label="Workspace">
        <Text>{truncate(d.workspace, width - 14)}</Text>
      </Row>
      <Row ui={ui} label="Spend">
        <Text color={col(ui, th.accent)} bold>
          {formatUsd(d.spendUsd)}
          {d.costIncomplete ? "+" : ""}
        </Text>
        <Text color={m}>{d.budgetUsd ? `  of ${formatUsd(d.budgetUsd)} budget (${Math.round((d.spendUsd / d.budgetUsd) * 100)}%)` : "  no budget · /budget to set one"}</Text>
      </Row>
    </Box>
  );
}

function Card(props: { ui: UiOptions; width: number; label: string; value: string; valueColor?: string; sub: string }) {
  const { ui } = props;
  return (
    <Box width={props.width} flexDirection="column" borderStyle="round" borderColor={col(ui, ui.theme.borderDim)} paddingX={1}>
      <Text color={col(ui, ui.theme.muted)}>{props.label}</Text>
      <Text bold color={col(ui, props.valueColor)} wrap="truncate-end">
        {props.value}
      </Text>
      <Text color={col(ui, ui.theme.muted)} wrap="truncate-end">
        {props.sub}
      </Text>
    </Box>
  );
}

const perM = (v: number) => `$${v < 0.1 ? v.toFixed(3) : v.toFixed(2)}`;

export function CostView(props: { ui: UiOptions; data: CostData }) {
  const { ui, data: d } = props;
  const th = ui.theme;
  const t = d.totals;
  const width = useContentWidth();
  const m = col(ui, th.muted);
  const cachedPct = t.inputTokens ? t.cachedInputTokens / t.inputTokens : 0;
  const cardWidth = width >= 88 ? Math.floor((width - 3) / 4) : Math.floor((width - 1) / 2);
  const meterWidth = Math.max(12, Math.min(40, width - 40));
  const price = d.price;
  const rates = price ? (d.peakNow || !price.offPeak ? price : { ...price, ...price.offPeak }) : null;
  return (
    <Box flexDirection="column">
      <Header ui={ui} title="cost" right={price?.asOf ? `${d.model} · prices as of ${price.asOf}` : d.model} />
      <Box flexWrap="wrap" columnGap={1}>
        <Card ui={ui} width={cardWidth} label="INPUT" value={`${n(t.inputTokens)} tokens`} sub={`${Math.round(cachedPct * 100)}% from cache`} />
        <Card ui={ui} width={cardWidth} label="OUTPUT" value={`${n(t.outputTokens)} tokens`} sub={`${n(t.reasoningTokens)} reasoning`} />
        <Card ui={ui} width={cardWidth} label="ACTIVITY" value={`${n(t.requests)} request${t.requests === 1 ? "" : "s"}`} sub={`${n(t.toolCalls)} tool call${t.toolCalls === 1 ? "" : "s"}`} />
        <Card
          ui={ui}
          width={cardWidth}
          label="ESTIMATED COST"
          value={`${formatUsd(t.costUsd)}${t.costIncomplete ? "+" : ""}`}
          valueColor={th.accent}
          sub={d.budgetUsd ? `${Math.round((t.costUsd / d.budgetUsd) * 100)}% of ${formatUsd(d.budgetUsd)} budget` : "no budget set"}
        />
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Row ui={ui} label="Cache">
          <Text color={col(ui, th.success)}>{bar(cachedPct, meterWidth, ui.color)}</Text>
          <Text>{`  ${Math.round(cachedPct * 100)}%`}</Text>
          <Text color={m}>{`  ${n(t.cachedInputTokens)} of ${n(t.inputTokens)} input tokens`}</Text>
        </Row>
        {d.budgetUsd ? (
          <Row ui={ui} label="Budget">
            <Text color={col(ui, t.costUsd / d.budgetUsd >= 0.8 ? th.error : th.accent)}>{bar(t.costUsd / d.budgetUsd, meterWidth, ui.color)}</Text>
            <Text>{`  ${formatUsd(t.costUsd)} of ${formatUsd(d.budgetUsd)}`}</Text>
          </Row>
        ) : null}
        {d.compiler && (d.compiler.charsSaved > 0 || d.compiler.rerunsSkipped > 0) ? (
          <Row ui={ui} label="Compiler">
            <Text>{`~${n(Math.round(d.compiler.charsSaved / 4))} tokens kept out`}</Text>
            <Text color={m}>{`  ${d.compiler.testDeltas} test deltas · ${d.compiler.readsDeduped} unchanged re-reads · ${d.compiler.rerunsSkipped} re-runs skipped`}</Text>
          </Row>
        ) : null}
        <Row ui={ui} label="Time">
          <Text>{`model ${(t.modelLatencyMs / 1000).toFixed(1)}s`}</Text>
          <Text color={m}>{" · "}</Text>
          <Text>{`tools ${(t.toolLatencyMs / 1000).toFixed(1)}s`}</Text>
        </Row>
        <Row ui={ui} label="Prices">
          {rates ? (
            <>
              <Text>{`${perM(rates.inputCacheMiss)} in · ${perM(rates.inputCacheHit)} cached · ${perM(rates.output)} out`}</Text>
              <Text color={m}>{` per 1M tokens${price!.offPeak ? (d.peakNow ? " · peak now (off-peak is half)" : " · off-peak now") : ""}`}</Text>
            </>
          ) : (
            <Text color={m}>{`no price configured for ${d.model} · add pricing.${d.model} to ~/.sutra/config.json`}</Text>
          )}
        </Row>
        {t.costIncomplete ? <Text color={col(ui, th.accent)}>! Some requests had no known price, so the total is a lower bound.</Text> : null}
      </Box>
    </Box>
  );
}

export function PlanView(props: { ui: UiOptions; plan: Plan | null; hint: string }) {
  const { ui, plan } = props;
  const th = ui.theme;
  const width = useContentWidth();
  const m = col(ui, th.muted);
  if (!plan) {
    return (
      <Box flexDirection="column">
        <Header ui={ui} title="plan" right="no plan yet" />
        <Text>
          <Text color={m}>{"Try  "}</Text>
          <Text color={col(ui, th.accent)}>/plan</Text>
          <Text color={col(ui, th.info)}> add dark mode to the settings page</Text>
        </Text>
        <Text color={m}>{props.hint}</Text>
      </Box>
    );
  }
  const done = plan.steps.filter((s) => s.status === "completed").length;
  const total = plan.steps.length;
  const glyph = (s: Plan["steps"][number]["status"]): [string, string] =>
    s === "completed" ? ["✓", th.success] : s === "active" ? ["◐", th.accent] : s === "blocked" ? ["!", th.error] : ["○", th.muted];
  return (
    <Box flexDirection="column">
      <Header ui={ui} title="plan" right={`${done} of ${total} done`} />
      <Text>
        <Text color={col(ui, th.success)}>{bar(total ? done / total : 0, Math.max(12, Math.min(40, width - 30)), ui.color)}</Text>
        <Text color={m}>{`  ${Math.round((done / Math.max(1, total)) * 100)}%`}</Text>
      </Text>
      {plan.explanation ? (
        <Box marginTop={1}>
          <Text color={m}>{plan.explanation}</Text>
        </Box>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {plan.steps.map((s, i) => {
          const [g, c] = glyph(s.status);
          return (
            <Text key={i} wrap="truncate-end">
              <Text color={col(ui, c)}>{`${g} `}</Text>
              <Text color={m}>{`${String(i + 1).padStart(2)}. `}</Text>
              <Text color={s.status === "pending" ? m : undefined} bold={s.status === "active"}>
                {s.title}
              </Text>
              {s.note ? <Text color={m}>{`  — ${s.note}`}</Text> : null}
            </Text>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={m}>{props.hint}</Text>
      </Box>
    </Box>
  );
}

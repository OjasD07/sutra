import type { PermissionDecision } from "../../permissions/engine.js";
import type { FinishReason, TokenUsage } from "../../providers/types.js";
import type { UsageTotals } from "../../telemetry/cost.js";
import type { ToolPreview, ToolResult } from "../../tools/types.js";
import type { Plan } from "../planning/plan.js";
import type { TestCounts } from "../../tools/shell/test-counts.js";

export type AgentStatus =
  | "idle"
  | "thinking"
  | "executing"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "budget_exceeded";

export type TerminalStatus = Extract<AgentStatus, "completed" | "failed" | "cancelled" | "budget_exceeded">;

export interface TurnResult {
  status: TerminalStatus;
  reason?: string;
  iterations: number;
  toolCalls: number;
  filesChanged: string[];
  finalText: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  durationMs: number;
  testsRun: { command: string; passed: boolean; counts?: TestCounts }[];
}

export interface ApprovalRequest {
  toolCallId: string;
  tool: string;
  summary: string;
  decision: PermissionDecision;
  preview?: ToolPreview;
}

/** Every event corresponds to something that actually happened in the runtime. */
export type AgentEvent =
  | { type: "status"; status: AgentStatus }
  | { type: "turn_start"; turn: number; input: string }
  | { type: "inference_start"; iteration: number; estimatedInputTokens: number }
  | { type: "text_delta"; text: string }
  | { type: "reasoning_progress"; chars: number }
  | { type: "tool_call_streaming"; name: string }
  | { type: "stream_reset"; reason: string }
  | { type: "inference_retry"; attempt: number; delayMs: number; reason: string }
  | { type: "assistant_message"; content: string; toolCalls: { id: string; name: string }[]; finishReason: FinishReason }
  | { type: "tool_start"; toolCallId: string; name: string; summary: string; args: unknown }
  | { type: "tool_progress"; toolCallId: string; chunk: string }
  | {
      type: "tool_end";
      toolCallId: string;
      name: string;
      summary: string;
      args: unknown;
      result: ToolResult;
      durationMs: number;
      outcome: "ok" | "error" | "denied" | "cancelled";
      /** For denials: who denied it. */
      deniedBy?: "user" | "policy";
    }
  | { type: "usage"; usage: TokenUsage | null; costUsd: number | null; latencyMs: number; totals: UsageTotals }
  | { type: "budget_warning"; spentUsd: number; limitUsd: number }
  | { type: "compaction"; tokensBefore: number; tokensAfter: number; usedModel: boolean; manual: boolean }
  | { type: "plan"; plan: Plan | null }
  | { type: "notice"; level: "info" | "warn" | "error"; message: string }
  | { type: "turn_end"; result: TurnResult };

export type AgentListener = (e: AgentEvent) => void;

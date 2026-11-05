import type { SutraConfig } from "../config/schema.js";
import { ContextManager } from "../context/manager.js";
import { AgentRuntime } from "../core/agent/runtime.js";
import type { AgentListener, TurnResult } from "../core/events/types.js";
import { PlanStore } from "../core/planning/plan.js";
import { RepoIndexService } from "../index/service.js";
import type { SessionStore } from "../memory/store.js";
import { PermissionEngine } from "../permissions/engine.js";
import { Workspace } from "../permissions/paths.js";
import { SecretRedactor } from "../permissions/sensitive.js";
import type { ModelProvider } from "../providers/types.js";
import { createSandbox } from "../sandbox/sandbox.js";
import { UsageTracker, type UsageTotals } from "../telemetry/cost.js";
import { FileStateTracker } from "../tools/file-state.js";
import { createDefaultRegistry } from "../tools/registry.js";
import { paths } from "../config/paths.js";

export interface IsolatedRun {
  result: TurnResult;
  sessionId: string | null;
  totals: UsageTotals;
}

/**
 * Run an unattended agent in a disposable workspace copy: Flow profile inside
 * the copy, every approval denied, its own sandbox rooted at the copy, an
 * explicit iteration and spend budget, and a fresh context (it sees only its
 * brief). If a store is given, the run is saved as its own session so
 * `sutra replay` can show exactly what it did.
 */
export async function runIsolatedAgent(o: {
  workspaceRoot: string;
  label: string;
  systemPrompt: string;
  prompt: string;
  config: SutraConfig;
  provider: ModelProvider;
  model: string;
  store: SessionStore | null;
  maxIterations: number;
  maxCostUsd: number;
  signal?: AbortSignal;
  onEvent?: AgentListener;
}): Promise<IsolatedRun> {
  const config: SutraConfig = structuredClone(o.config);
  config.model = o.model;
  config.permissions.profile = "flow";
  config.permissions.protectedPaths = [];
  config.budget.maxIterationsPerTurn = o.maxIterations;
  config.budget.maxSessionCostUsd = o.maxCostUsd;
  config.tools.retainFullLogs = false;

  const workspace = new Workspace(o.workspaceRoot);
  const info = o.provider.getModelInfo(o.model);
  const window = Math.min(info.contextWindow, config.context.maxContextTokens ?? Number.POSITIVE_INFINITY);
  const reserve = Math.min(config.maxOutputTokens ?? info.defaultOutputTokens, Math.floor(window / 4));
  const record = o.store?.createSession({ workspace: workspace.root, provider: o.provider.id, model: o.model, profile: "flow" }) ?? null;
  if (record) o.store!.updateSession(record.id, { title: o.label });
  const repoIndex = config.index.enabled ? new RepoIndexService(workspace.root, { maxFiles: config.index.maxFiles, cacheDir: paths.indexCache() }) : null;
  repoIndex?.refresh(true);
  const usage = new UsageTracker();
  const runtime = new AgentRuntime({
    provider: o.provider,
    tools: createDefaultRegistry(),
    permissions: new PermissionEngine({ ...config.permissions, routineCommands: config.tools.testCommand ? [config.tools.testCommand] : [] }),
    context: new ContextManager({ limit: Math.max(4096, window - reserve), threshold: config.context.compactThreshold, keepRecentTurns: config.context.keepRecentTurns }),
    store: o.store,
    sessionId: record?.id ?? `isolated-${Date.now().toString(36)}`,
    workspace,
    fileState: new FileStateTracker(),
    plan: new PlanStore(),
    redactor: new SecretRedactor(),
    usage,
    config,
    approve: async () => "deny",
    sandbox: createSandbox(config.sandbox.mode === "off" ? "off" : "auto", { workspace: workspace.root, allowWrite: [], network: false }),
    repoIndex,
    toolLogDir: paths.toolLogs(record?.id ?? "isolated"),
    systemPrompt: () => o.systemPrompt,
  });
  if (o.onEvent) runtime.on(o.onEvent);
  const result = await runtime.runTurn(o.prompt, o.signal);
  return { result, sessionId: record?.id ?? null, totals: { ...usage.totals } };
}

import { existsSync } from "node:fs";
import { join } from "node:path";
import { platform, release } from "node:os";
import { paths } from "../config/paths.js";
import type { SutraConfig } from "../config/schema.js";
import { loadInstructions, type InstructionSource } from "../context/instructions.js";
import { ContextManager, type ContextEntry } from "../context/manager.js";
import { buildSystemPrompt } from "../context/system-prompt.js";
import type { SessionRecord, SessionStore } from "../memory/store.js";
import { PermissionEngine, type ApprovalChoice } from "../permissions/engine.js";
import { Workspace } from "../permissions/paths.js";
import { SecretRedactor } from "../permissions/sensitive.js";
import type { Message, ModelProvider } from "../providers/types.js";
import { UsageTracker } from "../telemetry/cost.js";
import { FileStateTracker } from "../tools/file-state.js";
import { createDefaultRegistry, type ToolRegistry } from "../tools/registry.js";
import { detectTestCommand } from "../tools/shell/shell-tools.js";
import { AgentRuntime } from "./agent/runtime.js";
import { createSandbox, type SandboxStatus } from "../sandbox/sandbox.js";
import { RepoIndexService } from "../index/service.js";

const INDEX_TOOLS = new Set(["repo_map", "find_symbol", "code_search"]);
import type { ApprovalRequest } from "./events/types.js";
import { PlanStore } from "./planning/plan.js";

export interface SessionHandle {
  runtime: AgentRuntime;
  record: SessionRecord;
  workspace: Workspace;
  permissions: PermissionEngine;
  plan: PlanStore;
  usage: UsageTracker;
  context: ContextManager;
  tools: ToolRegistry;
  instructions: InstructionSource[];
  resumed: boolean;
  /** Messages restored from the store (for transcript replay in the UI). */
  restored: Message[];
  repairedToolCalls: number;
  sandbox: SandboxStatus;
  repoIndex: RepoIndexService | null;
}

export interface OpenSessionOptions {
  config: SutraConfig;
  provider: ModelProvider;
  store: SessionStore;
  workspaceRoot: string;
  approve: (req: ApprovalRequest) => Promise<ApprovalChoice>;
  resumeId?: string;
  tools?: ToolRegistry;
  /** Override sandbox detection (tests). */
  sandbox?: SandboxStatus;
}

export function contextBudget(config: SutraConfig, provider: ModelProvider, model: string) {
  const info = provider.getModelInfo(model);
  const window = Math.min(info.contextWindow, config.context.maxContextTokens ?? Number.POSITIVE_INFINITY);
  const reserve = Math.min(config.maxOutputTokens ?? info.defaultOutputTokens, Math.floor(window / 4));
  return { limit: Math.max(4096, window - reserve), threshold: config.context.compactThreshold, keepRecentTurns: config.context.keepRecentTurns };
}

/**
 * Wire all layers together for one session: a new one, or a resumed one whose
 * model-visible history is rebuilt from SQLite (after the last compaction)
 * and repaired so it is protocol-valid.
 */
export function openSession(o: OpenSessionOptions): SessionHandle {
  const workspace = new Workspace(o.workspaceRoot);
  const { config, store } = o;
  let record: SessionRecord;
  let resumed = false;
  if (o.resumeId) {
    const r = store.getSession(o.resumeId);
    if (!r) throw new Error(`No session matching "${o.resumeId}"`);
    if (r.workspace !== workspace.root) throw new Error(`Session ${r.id.slice(0, 8)} belongs to ${r.workspace}; run Sutra from that directory to resume it.`);
    record = r;
    resumed = true;
    if (!config.model || config.model === r.model) config.model = r.model;
  } else {
    record = store.createSession({ workspace: workspace.root, provider: o.provider.id, model: config.model!, profile: config.permissions.profile });
  }

  const testCommand = config.tools.testCommand ?? detectTestCommand(workspace.root);
  const permissions = new PermissionEngine({
    profile: config.permissions.profile,
    allowCommands: config.permissions.allowCommands,
    sensitivePaths: config.permissions.sensitivePaths,
    protectedPaths: config.permissions.protectedPaths,
    routineCommands: testCommand ? [testCommand] : [],
  });

  let tools = o.tools ?? createDefaultRegistry();
  if (config.permissions.profile === "inspect") tools = tools.subset((t) => t.category === "read" || t.category === "internal");
  if (!config.index.enabled) tools = tools.subset((t) => !INDEX_TOOLS.has(t.name));

  const plan = new PlanStore();
  const usage = new UsageTracker(resumed ? store.usageTotals(record.id) : undefined);
  const context = new ContextManager(contextBudget(config, o.provider, config.model!));
  let fileState = new FileStateTracker();
  let restored: Message[] = [];
  let repaired = 0;

  if (resumed) {
    const compaction = store.latestCompaction(record.id);
    const stored = store.loadMessages(record.id, compaction?.boundarySeq ?? 0);
    const entries: ContextEntry[] = stored.map((s) => ({ seq: s.seq, message: s.message }));
    context.load(entries, compaction?.summary ?? null, store.lastSeq(record.id));
    for (const c of context.unresolvedToolCalls()) {
      const msg: Message = { role: "tool", toolCallId: c.id, name: c.name, content: "Error (cancelled): the session was interrupted before this tool call completed. Check the workspace state before retrying." };
      context.append(msg, store.appendMessage(record.id, msg));
      repaired++;
    }
    restored = context.messages();
    plan.restore(store.loadPlan(record.id));
    const cp = store.latestCheckpoint(record.id);
    if (cp?.fileState) fileState = FileStateTracker.fromJSON(cp.fileState as never);
  }

  const sandbox =
    o.sandbox ??
    createSandbox(config.sandbox.mode, {
      workspace: workspace.root,
      allowWrite: config.sandbox.allowWrite.map((d) => workspace.resolve(d).absolute),
      network: config.sandbox.network,
    });

  // Index the repository once at session start; tools refresh it incrementally.
  let repoIndex: RepoIndexService | null = null;
  let repoMap: string | null = null;
  if (config.index.enabled) {
    const e = config.index.embeddings;
    repoIndex = new RepoIndexService(workspace.root, {
      maxFiles: config.index.maxFiles,
      cacheDir: paths.indexCache(),
      ...(e
        ? { embeddings: { baseUrl: e.baseUrl, model: e.model, ...(e.apiKeyEnv && process.env[e.apiKeyEnv] ? { apiKey: process.env[e.apiKeyEnv]! } : {}), ...(e.maxChunks ? { maxChunks: e.maxChunks } : {}) } }
        : {}),
    });
    const stats = repoIndex.refresh(true);
    if (config.index.mapTokens > 0 && stats.files > 0) repoMap = repoIndex.index.map({ maxTokens: config.index.mapTokens });
  }

  const redactor = new SecretRedactor();
  redactor.add(config.providers.deepseek.apiKey);
  const instructions = loadInstructions(workspace.root);
  const isGitRepo = existsSync(join(workspace.root, ".git"));
  const date = new Date().toISOString().slice(0, 10);

  const runtime = new AgentRuntime({
    provider: o.provider,
    tools,
    permissions,
    context,
    store,
    sessionId: record.id,
    workspace,
    fileState,
    plan,
    redactor,
    usage,
    config,
    approve: o.approve,
    sandbox,
    repoIndex,
    toolLogDir: paths.toolLogs(record.id),
    // Kept stable within a session so the provider's prefix cache stays warm;
    // the plan reaches the model through update_plan results instead.
    systemPrompt: () =>
      buildSystemPrompt({
        workspace: workspace.root,
        platform: `${platform()} ${release()}`,
        date,
        model: runtime.model,
        profile: permissions.policy.profile,
        isGitRepo,
        testCommand,
        instructions,
        plan: null,
        summary: context.getSummary(),
        toolNames: tools.list().map((t) => t.name),
        repoMap,
      }),
  });

  return { runtime, record, workspace, permissions, plan, usage, context, tools, instructions, resumed, restored, repairedToolCalls: repaired, sandbox, repoIndex };
}

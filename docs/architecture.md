# Architecture

Sutra is a single TypeScript package (strict mode, ESM, Node ≥ 22.13). Its layers talk to each other through typed interfaces. The agent runtime knows nothing about DeepSeek, and the DeepSeek adapter knows nothing about tools or permissions.

```
src/
  cli/          argument parsing, `sutra init`, slash commands, non-interactive mode
  tui/          Ink/React terminal UI, theme, syntax-highlighted diffs
  core/
    agent/      AgentRuntime (the loop), loop detector
    events/     AgentEvent / AgentStatus / TurnResult types
    planning/   PlanStore
    session.ts  wires all layers into a session (new or resumed)
    delegate.ts delegated-task interface (subagent foundation)
  providers/    ModelProvider interface, errors, retry wrapper, registry
    deepseek/   wire format, SSE parser, streaming adapter, model metadata
  tools/        Tool interface, registry, filesystem / shell / git / plan tools
  context/      ContextManager (history, budget, compaction), token estimator,
                instruction loading, system prompt
  memory/       SessionStore (node:sqlite)
  permissions/  PermissionEngine, workspace path canonicalisation,
                command classifier, secret handling
  config/       zod schema, loader with precedence, default pricing
  telemetry/    usage + cost tracking, pino logger
  i18n/         English / Hindi interface strings
```

## The turn loop

`AgentRuntime.runTurn(input, signal)`:

```
user message ──► budget check ──► (compact if over threshold)
     ▲                                   │
     │                          build request (system + history + tools)
     │                                   │
     │                    provider.generate() via generateWithRetry
     │                                   │
     │                 assistant message persisted (with reasoning)
     │                                   │
     │                      no tool calls? ──► completed / failed
     │                                   │
     │      prepare: parse JSON, zod-validate, unknown tool → error result
     │      batch:   consecutive read-only calls run in parallel;
     │               writes/commands run alone, in issue order
     │      for each call: loop check → permission engine → approval
     │               (sequential, so prompts never overlap) → execute
     │               with timeout + abort
     │                                   │
     └──── exactly one tool result per call id, in issue order ◄─┘
```

Invariants (all covered by tests):

- Every tool call ID gets exactly one result message. This includes unknown tools, invalid JSON, schema failures, denials, user rejections, timeouts, crashes and cancellations.
- Every turn ends in exactly one terminal state: `completed`, `failed`, `cancelled` or `budget_exceeded`.
- Partial streamed output is never persisted. If a stream breaks mid-response, the UI is told (`stream_reset`), the partial text is discarded, and the request is sent again (at most twice).
- Retries happen only before the first byte arrives. They use exponential backoff with jitter, or `Retry-After` when the server sends it.
- Loop detection compares each call's signature: tool name, canonical arguments, and a "workspace epoch" that advances after every successful write or command. So re-reading a file after editing it is fine, but a fourth identical call with nothing changed in between is refused. After three refusals the turn fails.

## Provider interface

```ts
interface ModelProvider {
  id: string;
  getCapabilities(): ModelCapabilities;
  getModelInfo(model: string): ModelInfo;
  generate(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent>;
  listModels?(signal?: AbortSignal): Promise<string[]>;
}
```

`ModelEvent` is one of `text_delta`, `reasoning_delta` (a character count only, so reasoning text never reaches UIs), `tool_call_start`, `tool_call_delta`, or a single final `message_complete` carrying the assembled `AssistantMessage`, the finish reason and usage. Providers throw `ProviderError` with a `kind` (`rate_limited`, `authentication`, …), from which `retryable` is derived.

New providers register a factory with `registerProvider(id, (config) => provider)`.

### DeepSeek specifics

- The adapter is built on `fetch` plus a spec-conformant SSE parser, not an SDK. This keeps `reasoning_content`, `thinking`, `reasoning_effort` and `prompt_cache_hit_tokens` exactly as documented, and keeps retry decisions inside Sutra.
- Thinking is requested with `thinking: {type}` and `reasoning_effort`. `temperature` is only sent in non-thinking mode, where it has an effect.
- When a request includes `tools`, every earlier assistant message is sent back with its `reasoning_content`. The API requires this and returns 400 otherwise. Without tools it is omitted, since the API ignores it.
- `stream_options.include_usage` is set, and usage is read from the final chunk. `: keep-alive` comments are ignored. An idle watchdog fails a stream that goes silent.

## Context management

`ContextManager` holds the messages after the last compaction boundary. The full raw history always stays in SQLite. Before each inference it estimates the request size with a heuristic, calibrated after every response using the provider's reported `prompt_tokens`. If the estimate exceeds `compactThreshold × limit`, where the limit is the model window capped by `context.maxContextTokens` minus an output reserve, it compacts:

1. It picks a cut point that leaves no tool call dangling. Normally that is before the N most recent user turns. Inside one long turn, it cuts before a recent assistant step.
2. It summarises the dropped part with the model (no tools, thinking disabled) into fixed sections: requirements, task state, decisions, files, errors/verification, pending steps.
3. It appends facts recorded by the harness that the model cannot forget: files modified, recent commands with exit codes, unresolved errors, and the plan.
4. The summary goes into the system prompt. If the remaining messages start with an assistant message, a synthetic user message re-anchors the conversation, so the rebuilt history is protocol-valid.

If the summarisation request fails, a mechanical digest is used instead. The UI is always told when compaction happens.

The system prompt stays stable within a session. The plan reaches the model through `update_plan` results, not by editing the prompt, which keeps DeepSeek's prefix cache warm.

## Persistence

`SessionStore` (`~/.sutra/sutra.db`, mode 600) has these tables: `sessions`, `messages` (full JSON, including reasoning, which is needed for a protocol-correct resume), `tool_invocations`, `checkpoints` (status plus file-state snapshots), `plans`, `compactions` and `usage`. Migrations are versioned with `PRAGMA user_version`. When you resume, Sutra loads the messages after the latest compaction boundary along with its summary, then repairs any dangling tool calls with explicit "interrupted" results. It also restores the plan, the file-state tracker and the usage totals.

## Extension points

- **Tools:** implement `Tool<A>` (name, description, version, zod schema, category, `readOnly`, `describe()` for the permission engine, optional `preview()` for approval diffs, `execute()`), then `registry.register(tool)`.
- **Providers:** `registerProvider()`.
- **Delegated tasks:** `runDelegatedTask({ kind, brief, allowTool, profile, maxIterations, maxCostUsd }, env)` runs an isolated runtime with no user approvals. It is not exposed to the model yet.
- **MCP:** not implemented. The intended shape is an MCP client that wraps remote tools as `Tool` objects with category `execute`, so they go through the same permission engine.

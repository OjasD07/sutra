# Token economy: more verified tasks per token

Research and design proposal, 5 November 2026. These are proposed changes, not implemented behavior.

## Objective

Optimize **independently verified tasks solved per million billed tokens**, subject to a fixed time and spend budget. Also report verified tasks per dollar and per minute: cached input tokens can be billed differently from uncached input and output tokens. Report the pass rate alongside every efficiency number. A smaller prompt that causes more searches, retries, or failed tasks is a regression.

This distinction is empirically important. In paired coding-agent runs, [Token Reduction Is Not Cost Reduction](https://arxiv.org/abs/2607.12161) found a setup that removed 38.4% of delivered tool-output tokens but raised billed cost by 6.8%. A separate [context-compression study](https://arxiv.org/abs/2609.32961) found that aggressive compression could reduce tokens yet lengthen agent execution. Neither result transfers automatically to Sutra; they define what we must measure.

## Where Sutra currently spends tokens

- The 2,000-token repository map is placed in the system prompt by default on every model request. Prefix caching discounts repeated copies, but the first copy and cache misses still count. Sutra's own three-question navigation A/B test found no answer-quality gain on its roughly 100-file repository.
- The quality engine's `balanced` mode makes a short contract call, two alignment-review calls, and a finish-gate judge call for a changed task; it may judge again after counterexamples. On the four bundled live tasks, `fast` and `balanced` both solved 4/4, while `balanced` cost 32% more. Those four tasks are too easy to estimate the quality benefit.
- `read_file` defaults to 2,000 lines, and tool output may contribute up to 30,000 characters to the next model request. The full conversation and tool results remain in context until the configured 75%-of-200K-token compaction threshold.
- All tool definitions are sent on every inference request. A growing tool catalog increases the prompt and may complicate tool choice.
- The current usage ledger records input, cached input, output, reasoning, and cost, but does not attribute tokens to the map, evidence packet, tool schemas, file reads, test logs, contract, review, judge, or branch stage.

## Proposed changes

### 1. Add a token and outcome profiler before optimizing

For every request, record token counts by **stable instructions, tool schemas, repository map, evidence packet, active task state, old conversation, file excerpts, test output, and model output**. Attribute auxiliary calls to `contract`, `review`, `judge`, `verifier`, and `candidate`. Track cache-hit tokens and the number of model round trips. Exact per-segment tokenization may require provider-specific tokenizers; use estimates for segments and reconcile them to provider-reported totals. Never present an estimate as a provider measurement.

Add `sutra cost --explain` with a per-stage waterfall and a per-turn comparison: “this packet cost 1,300 input tokens and avoided two search rounds” only when the counterfactual has been measured, not inferred from one run. Report `solved / billed tokens`, `solved / uncached-equivalent cost`, and `solved / wall time` in benchmark JSON.

**Code:** `src/telemetry/cost.ts`, `src/core/agent/runtime.ts`, `src/quality/aux.ts`, `src/bench/bench.ts`.

### 2. Replace fixed context with a task-specific context compiler

At each model step, assemble a small **working set** from the task contract and evidence ledger: the current acceptance criteria, active hypotheses, relevant code spans, latest failing checks, and decisions that remain valid. Give each item a file hash/edit epoch and a reason for inclusion. Invalidate stale code and test observations after edits. Keep the full source, logs, and audit in local storage, retrievable on demand.

Use progressive disclosure: begin with signatures and small relevant spans; expand to full functions or adjacent files when the model asks or when tests point there. Preserve exact line numbers and verbatim edit anchors. Do not blindly cap every read at a tiny number of lines. [Agent Retrieval Bench](https://arxiv.org/abs/2607.24882) found that retrieval methods win on different tasks and that agents fail to touch any gold file in a substantial fraction of runs; context selection needs a recall guard as well as a token limit.

Make the current 2,000-token map **conditional**: small repos or tasks with an explicit path may need no map; ambiguous cross-file tasks may benefit from a focused map or evidence packet. Compare map, packet, both, and neither at a fixed budget. [The Physical Cost of Context](https://arxiv.org/abs/2610.34763) found that good initial retrieval reduced model calls in a localization workload, while destructive history masking harmed cache reuse.

**Code:** `src/context/manager.ts`, `src/index/service.ts`, `src/quality/localize.ts`, `src/core/session.ts`.

### 3. Make tool results progressive and loss-aware

Parse test/build output into structured observations: exact failing test names, assertion and stack frames, counts, exit code, changed status since the previous run, and a pointer to the raw log. For the next request, show the **new information**: “same 2 failures; one new stack frame; 18 unchanged passes.” The model can fetch the full log if needed.

Do the same for repeated file reads and searches: return content once with a stable `file@hash:lines` identifier; later results can say “unchanged since observation 17” and provide a way to expand. This is deduplication, not lossy paraphrase. Preserve exact code hunks, compiler diagnostics, and assertion text, because aggressive output compression has been shown to corrupt edit anchors and reduce solves in [Token Reduction Is Not Cost Reduction](https://arxiv.org/abs/2607.12161).

**Code:** `src/tools/shell/`, `src/tools/filesystem/read-tools.ts`, `src/core/agent/runtime.ts`, `src/memory/store.ts`.

### 4. Reduce model round trips with agent-native inspection tools

Add a small number of focused composite tools:

- `inspect_symbol(name)`: definition, bounded body, callers, tests, and file version in one observation;
- `diagnose_failure(command)`: run the targeted check, parse its failure, map the relevant stack frames to source symbols, and return one bounded report;
- `check_patch()`: diff, targeted test, type check, and changed-failure summary under the normal permission rules.

The aim is to replace search → read → search → read cycles with one high-information observation, not to hide capabilities behind an opaque mega-tool. The [SWE-agent interface study](https://arxiv.org/abs/2405.15793) established that agent-facing tool design can materially affect coding performance. Keep tool descriptions and schemas stable for prefix caching, and ablate each new tool against the current primitives.

**Code:** `src/tools/`, `src/index/`, `src/tools/registry.ts`.

### 5. Preserve prompt-cache continuity

Keep the stable system instructions and tool definitions byte-stable and ordered. Put per-task evidence after that stable prefix. Compact at explicit checkpoints rather than rewriting the earliest messages whenever the prompt gets long. Compare the provider's actual cache-hit fraction before and after each policy change. DeepSeek documents automatic prefix-based caching and reports `prompt_cache_hit_tokens`; hits are best-effort, not guaranteed. [DeepSeek context caching](https://api-docs.deepseek.com/guides/kv_cache/) · [TokenPilot](https://arxiv.org/abs/2606.17016)

Avoid a naive “last five messages only” mode. It can remove cheap cached context, force rediscovery, and worsen effective compute, as shown in [The Physical Cost of Context](https://arxiv.org/abs/2610.34763). When a segment truly expires, move it out at a checkpoint and keep an evidence pointer so it can be restored.

**Code:** `src/context/manager.ts`, `src/context/system-prompt.ts`, `src/providers/`.

### 6. Spend quality-engine calls only when they change a decision

Keep `fast` as the low-overhead baseline. In `balanced`, skip contract extraction when the task is a simple explicit change with a deterministic acceptance check. Skip the two-call alignment review when the patch is narrow, the changed behavior is covered by a baseline-fail/head-pass test, and no instruction or test has been weakened. Skip an LLM judge when a criterion maps unambiguously to a fresh structured check. If evidence conflicts, the patch crosses a subsystem boundary, or the user request is ambiguous, pay for the independent calls.

These skips are hypotheses, not automatic wins: the review can catch errors tests miss. Measure false completions, regressions, and solve rate under the same budget. [Scaling Inference-Time Compute with Teams of Coding Agents](https://arxiv.org/abs/2610.17471) found that where extra compute is spent matters greatly, and that additional workers can be costly.

**Code:** `src/quality/engine.ts`, `src/quality/review.ts`, `src/quality/types.ts`.

### 7. Allocate a per-task information budget

Treat each optional action as a proposed experiment with an estimated token cost and a question it could resolve. Prefer an action that distinguishes live hypotheses or checks an unmet criterion. Stop paying for more reads when the current location is confirmed; stop paying for more reviewers when evidence is decisive. Route narrow planning or classification calls to a cheaper or local model only after checking that they preserve solve rate; keep the main implementation model strong when needed. A recent [coding-agent team study](https://arxiv.org/abs/2610.17471) found cheap planners useful but cheap implementers harmful in its setting.

Start with transparent rules and stage budgets. Learn thresholds only after enough held-out task data exists. The controller's target is **marginal verified-success gain per additional billed token**, not the solver's self-reported confidence.

**Code:** `src/quality/engine.ts`, `src/config/schema.ts`, `src/telemetry/`.

## Rollout and measurement

1. **Instrument:** stage-attributed token and cache metrics, plus a held-out suite of harder repository tasks. The current four-task suite is saturated at 4/4 and cannot show an improvement in solve rate.
2. **Ablate cheap changes:** conditional map, smaller/focused reads, structured test deltas, and deterministic judge bypass. Ship only changes that improve the verified-solve/token frontier without a material rise in false completions.
3. **Add composite tools and context compiler:** compare each against the current tool loop on the same tasks, models, and budgets.
4. **Tune adaptive allocation:** include fast, balanced, and deep outcomes at fixed token and dollar caps; report the trade-off curve, not one “best” score.

Paired repeated trials should report pass rate, billed input/cache-hit/output/reasoning tokens, cost, latency, model calls, tool calls, and false-verification rate. A policy wins if it solves more tasks at the same token budget, or uses fewer tokens at a non-inferior solve rate. Do not ship a compression layer merely because its isolated compression ratio looks good.

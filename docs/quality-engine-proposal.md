# Sutra Quality Engine: counterexample-driven coding

Status: research proposal (5 November 2026). This document proposes harness changes; none of the behavior below is implemented yet.

## Goal

Increase the chance that Sutra's **first delivered patch** satisfies the user's task, while keeping cost, time, permissions, and uncertainty visible. The primary metric is independently verified task resolution at a fixed budget, not the number of agent attempts or the model's opinion of its own work.

The design is a harness around the existing agent loop. It helps the model find relevant evidence, decide what to try next, test competing explanations, and stop when the evidence supports a result. Simple tasks should remain simple.

## The central mechanism

Treat each coding task as a search over explanations and patches, driven by executable counterexamples:

```text
request
  → task contract and repository evidence
  → baseline and candidate fault locations
  → one initial patch
  → verification and counterexample search
  → branch only if evidence is weak or conflicting
  → select, repair, or report uncertainty
```

This combines the localization/repair/validation structure of [Agentless](https://arxiv.org/abs/2407.01489) and [PatchPilot](https://arxiv.org/abs/2502.02747) with graph-guided localization from [LocAgent](https://arxiv.org/abs/2503.09089), selective inference-time search from [SWE-Replay](https://arxiv.org/abs/2601.22129) and [Scaling Test-Time Compute for Agentic Coding](https://arxiv.org/abs/2604.16529), and independently checked patch alignment from [RETRACE](https://arxiv.org/abs/2608.08950). These are research results on particular benchmarks, not predicted Sutra gains.

## Upgrade the four-step solve flow

### 1. Reproduce and localize with an evidence packet

Before the first model edit, the harness should assemble a small, versioned packet:

- the exact user request and explicit constraints;
- relevant source symbols, callers, tests, configuration, and recent errors, with file hashes and line references;
- the baseline result of a targeted check when one is safe and available;
- known pre-existing failures and missing test setup.

Use multiple retrieval signals: symbol definitions and references, lexical search, import/call edges, stack traces, test names, and changed files. Give the model concise evidence with paths, not an entire repository dump. Allow it to request more. Code localization is a measurable bottleneck: [LocAgent](https://arxiv.org/abs/2503.09089) and [RGFL](https://arxiv.org/abs/2601.18044) report downstream repair gains from better localization.

The in-progress `src/index/` index supplies lexical search, symbols, and a file graph, but is not yet wired into Sutra's tool registry. Its symbol extraction is regex-based; treat graph edges as hints and verify them in source. Add `code_search`, `find_symbol`, `find_references`, and a token-limited `repo_map` as read-only tools. Do not push a static map into every prompt.

For a bug, attempt a baseline reproduction before editing. For a feature or refactor, record the current behavior and constraints instead. If reproduction is infeasible, mark it as unavailable; do not manufacture a failure or block all progress.

### 2. Use experiments to narrow hypotheses

For a nontrivial task, maintain at most three current hypotheses in a harness-owned ledger. Each has a suspected location, supporting observation, contradicting observation, and next distinguishing check. A test run, trace, file read, or small probe should eliminate or strengthen a hypothesis. The ledger is evidence storage, not a mandatory model essay.

Prefer a cheap discriminating probe before an expensive second full attempt. For example, if two candidate fixes disagree on whether an expiry boundary is inclusive, run one boundary case. This adapts the execution-guided verifier idea from [Scaling Agentic Verifier](https://arxiv.org/abs/2602.04254): target inputs on which plausible solutions differ.

The harness should detect unproductive motion from objective signals: repeated failing test signatures, repeated edits to the same hunk, unchanged evidence after several reads, or a patch that passes only tests it created. Those trigger a new probe or a branch, rather than another generic “think harder” message.

### 3. Generate and challenge patches

Start with one candidate. Create another only when verification fails, the first candidate's behavior is ambiguous, or two plausible explanations remain. Fork from a snapshot of the **same initial workspace**, including uncommitted and untracked files, into isolated workspaces. Keep each candidate's tool permissions, sandbox, budget, and audit trail independent. Preserve the user's existing checkout until a candidate is selected.

Avoid duplicate attempts with the same context and hypothesis. Give each branch a distinct, evidence-backed question or failure mode. Summarize the useful findings of failed branches so a later attempt can reuse them, as suggested by [Scaling Test-Time Compute for Agentic Coding](https://arxiv.org/abs/2604.16529) and [SWE-Replay](https://arxiv.org/abs/2601.22129).

Run validation in this order: syntax/type/build checks; targeted existing tests; relevant broader suite; focused new tests; task-specific checks. A verifier can propose tests, but its tests are provisional. Check that a bug regression test fails on the baseline and passes on the candidate, and run it against other candidates where useful. Protect the original test suite from candidate edits during final verification, following Sutra's current benchmark runner.

Generated tests are **not an oracle**. [SWE-Mutation](https://arxiv.org/abs/2605.22175) finds substantial weaknesses in LLM-generated suites. Require independent existing tests or a clear user contract where possible; use mutation and metamorphic checks selectively to challenge a generated test's discriminatory power. If no trustworthy oracle exists, report the gap.

### 4. Select by evidence, then answer precisely

Candidate selection should apply deterministic gates first: policy compliance, no unexplained test removal or weakening, clean build, baseline behavior, and test results. A fresh-context reviewer can then check whether the patch's actual behavior matches the request and whether it introduces an obvious regression. The reviewer must not be the sole judge; [RETRACE](https://arxiv.org/abs/2608.08950) provides evidence that independent semantic alignment checks can help, while [SWE-Mutation](https://arxiv.org/abs/2605.22175) cautions against trusting generated tests alone.

The final response should carry a compact evidence table: requested behavior, observed check, code version/hash, result (`passed`, `failed`, or `unverified`), and limitations. Never turn “all available tests passed” into “correct.” No invented confidence percentage.

## Additional harness innovations

### Evidence-directed compute allocation

Add `fast`, `balanced`, and `deep` modes with explicit time, token, and dollar caps. The controller chooses among **read, probe, repair, branch, review, stop** using observable evidence: whether a baseline exists, whether locations agree, test failures, patch divergence, and remaining budget. It should not rely on the solver's self-reported confidence. Use one candidate for a clear one-file fix; spend more only when an experiment can distinguish possibilities. Research on adaptive test-time computation and coding-agent search supports this direction, but the policy must be measured in Sutra rather than copied unchanged from another setting. [Adaptive allocation](https://arxiv.org/abs/2604.14853) · [SWE-Replay](https://arxiv.org/abs/2601.22129)

### Context that preserves decisions, not transcripts

Keep an append-only, structured evidence ledger separate from model conversation: original requirements, file versions, hypotheses, observed test results, rejected approaches, and unresolved questions. When context is compacted, rebuild a concise state from this ledger and current file hashes. Stale test results must be invalidated after edits. This gives branches shared facts without sharing one another's speculative reasoning.

### Task-specific verification adapters

Treat verification as a typed tool result, not a chunk of terminal text: test cases and status, duration, changed files, command, exit code, environment, and tree hash. Start with Node test runners because Sutra is already a Node package; add Python, Go, Rust, and browser adapters after the core abstraction works. If an adapter cannot parse a runner, retain the raw exit code and say what could not be established.

### Counterexample bank for the current task

Keep successful distinguishing probes and failed candidate behaviors in a temporary task-local bank. Run these against every later candidate. A newly found counterexample should be minimized before it enters the bank, so the solver receives a small, actionable failure. Keep provisional generated tests separate from committed project tests.

### Honest stop rule

Stop when every explicit acceptance criterion has a recent supporting check, the relevant existing suite has no new failure, and no outstanding counterexample survives. If evidence is unavailable, finish with an `unverified` criterion instead of cycling until the budget expires. A completed task is an evidence judgment, not merely a model response with no tool calls.

## Implementation in this repository

| Order | Change | Existing foundation |
| --- | --- | --- |
| 1 | Wire the repository index into read-only tools; add tests for localization precision and ignored/sensitive paths | `src/index/`, `src/tools/registry.ts` |
| 2 | Add task contract, baseline, and evidence ledger; make `completed` pass through a completion gate | `src/core/agent/runtime.ts`, `src/memory/store.ts` |
| 3 | Add structured test results and a targeted-check planner | `src/tools/shell/`, `src/bench/bench.ts` |
| 4 | Add snapshot/branch manager with isolated workspace, sandbox, permissions, budgets, and candidate audit | `src/core/delegate.ts`, `src/sandbox/`, `src/audit/` |
| 5 | Add counterexample generation and cross-candidate test execution; mark generated checks provisional | new verifier module |
| 6 | Add adaptive controller and `fast`/`balanced`/`deep` policy | `src/config/schema.ts`, new orchestrator around `AgentRuntime` |

The first useful release is steps 1–3: better context, baseline evidence, and a completion gate. Branching comes after snapshots and isolation are reliable. The current `runDelegatedTask` has a restricted context but shares the workspace and does not provide a complete branch sandbox; do not use it unchanged for competing patches. Current SQLite checkpoints store file-state metadata, not a restorable source snapshot.

## How to know whether it is actually better

Sutra's four bundled tasks are smoke tests. Build a held-out suite of real repository tasks, with frozen starting trees and checks that the solver cannot edit. Compare the same model, budget, and task set across these ablations: current harness; +retrieval; +baseline/evidence; +counterexamples; +selective branching; +fresh-context review. Run repeated trials where model nondeterminism matters.

Report independently verified resolve rate at a fixed cost and time budget, cost per solved task, median time, regressions, false completion claims, and frequency of `unverified` outcomes. Keep a separate set of tasks that were never used to tune prompts or controller thresholds. [SetUpAgent](https://arxiv.org/abs/2503.07701) shows why setup and task distribution matter; public benchmark gains alone should not be presented as gains on Sutra users' repositories.

## Guardrails and limits

- Keep the existing permission engine authoritative. A verifier, test generator, or candidate branch gets no wider access than the user granted.
- Execute generated tests as untrusted code in the same OS sandbox as other commands; prohibit network by default and preserve the original checkout.
- Snapshot only workspace files needed for the task, respecting ignore rules and sensitive paths. Record whether uncommitted or untracked content was included.
- Never select a patch solely because an LLM reviewer likes it, a self-generated test passes, or candidates agree with one another.
- Measure whether each layer improves quality. More orchestration can worsen latency, cost, and even outcomes when evidence is weak.

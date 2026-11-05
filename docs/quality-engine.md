# Quality engine

Sutra's quality engine is a harness around the agent loop. It helps the model find the right code, test competing explanations, and stop only when the evidence supports the result. The goal is the first delivered patch being right, judged by independent checks rather than by the model's opinion of its own work, while cost, time, permissions and uncertainty stay visible.

```text
request
  → evidence packet (localization signals + baseline + task contract)
  → one patch
  → finish gate: change record, independent review, judge with freshness rules
  → counterexample search when criteria lack evidence (provisional tests, re-run by Sutra)
  → competing patches from the initial snapshot only if the fix still fails (deep)
  → verified / partial / unverified / failed, with the check behind each criterion
```

The design draws on [Agentless](https://arxiv.org/abs/2407.01489), [PatchPilot](https://arxiv.org/abs/2502.02747), [LocAgent](https://arxiv.org/abs/2503.09089), [SWE-Replay](https://arxiv.org/abs/2601.22129), [Scaling Test-Time Compute for Agentic Coding](https://arxiv.org/abs/2604.16529), [RETRACE](https://arxiv.org/abs/2608.08950) and [SWE-Mutation](https://arxiv.org/abs/2605.22175). Those papers report results on their own benchmarks; they say nothing about gains in Sutra. What has been measured in Sutra is listed at the end.

## Modes

| | `fast` | `balanced` (default) | `deep` |
| --- | --- | --- | --- |
| Extra model calls | none | contract, review, judge (≈3–4 short calls) | same, plus sub-agents |
| Evidence packet and baseline | — | ✓ | ✓ |
| Finish gate | labels only | sends work back once | sends work back twice |
| Counterexample search | — | 1 round, only if a criterion still lacks evidence | 2 rounds, always |
| Competing patches | — | — | up to 2, only if the fix still fails |
| Per-turn ceiling for harness spend | $0 | $0.10 | $0.50 |

Set the mode with `/quality`, `--quality`, `SUTRA_QUALITY` or `quality.mode` in config. All harness calls and sub-agent spend are counted in `/cost` and the session's spend limit.

## 1. Evidence packet (localization)

Before the first model call, `src/quality/localize.ts` builds a short packet (about 1,500 tokens at most) and appends it to the request. It combines:

- file paths, `file:line` references and stack frames from the request, each resolved to the enclosing function;
- code identifiers (backticked, camelCase, snake_case, calls), with their definitions and the files that use them;
- failing test names from the baseline and quoted test names, located in test files;
- ranked code search over the request text;
- dependency edges for each likely file (what it uses, what uses it).

The packet labels itself as hints: the symbol index is pattern-based, so the model is told to verify in source and to expand with `find_symbol`, `code_search` and `read_file`.

**Baseline.** For a bug, Sutra runs the project's test command before any edit. It does so only when the run is allowed without asking: inside the OS sandbox, or under the Flow profile. Otherwise the packet says the baseline was not run and why, so `run_tests` establishes it under the normal approval rules. The harness never runs commands you'd otherwise have to approve.

**Task contract.** One short model call turns the request into 1–5 acceptance criteria, each marked as needing execution or not. The criteria are shown to the model at the start and checked at the end.

## 2. Hypothesis ledger and stall detection

The `hypotheses` tool holds at most three open explanations. Each has a location, the evidence for and against it, and the cheapest check that would distinguish it from the others. It is evidence storage, not a required essay.

The harness watches objective signals rather than the model's confidence:

- **the same failing-test signature** (failing test names, or failed/total counts) after an edit;
- **the same file edited three or more times** while tests still fail.

When either happens, Sutra adds a note before the next model call. The note asks for competing explanations and one distinguishing check (a single assertion, a log line, a minimal input), not another edit on a guess.

## 3. Counterexample verifier

`src/quality/verifier.ts` runs an isolated verifier agent in a disposable copy of the patched workspace. It gets the request and the diff, and writes up to three small tests under `.sutra-provisional/`, aimed at boundaries and cases where plausible fixes would disagree. It reports the ones that fail.

Sutra trusts none of that report. It re-runs each claimed counterexample itself, in a fresh copy, inside the sandbox, and keeps only the ones that really fail. Confirmed counterexamples go into a **bank** for the turn, are shown to the main agent as **provisional** ("decide whether each reflects the request"), and are re-run against every later version of the patch. Provisional tests never enter your workspace. A criterion supported only by provisional tests is marked that way.

In `balanced` mode the hunt runs only when a criterion still lacks evidence after judging, so a fix the project's tests already cover stays cheap.

## 4. Competing patches (deep)

When the fix still fails after the bounces, `src/quality/branches.ts`:

1. takes up to two distinct explanations from the hypothesis ledger, or asks for alternatives that differ from the failed attempt;
2. runs one candidate per explanation, each in its **own copy of the initial snapshot** taken before the first edit (uncommitted and untracked files included; dependency directories linked, not copied), with its own sandbox, budget and saved session;
3. gives each candidate what the failed attempt learned: its diff, the test results, surviving counterexamples, and the hypotheses;
4. judges candidates by deterministic gates, with your original tests restored: the tests pass, no existing test was modified, banked counterexamples now pass, and the smallest diff wins;
5. hands the winning patch to the main agent, which applies it with `apply_patch`. That goes through the normal permission engine, so in Confirm you approve it like any other edit, and the edit then has to pass the gate again.

Each candidate is a normal saved session; `sutra replay <id>` shows what it did.

## 5. Independent alignment review

`src/quality/review.ts` makes two short calls:

1. **With only the diff and the check results**, describe what problem this patch solves.
2. **Compare that description with the user's request**: aligned, partial or misaligned, plus the specific gaps.

The review is recorded as a check. It can send work back with its gaps, but it can **never** pass a criterion on its own.

## 6. Harness-owned finish gate

A turn used to be "completed" whenever the model stopped calling tools. Now, when the model stops, `src/quality/engine.ts`:

1. **Records what changed**, from Sutra's own bookkeeping: which files changed, and whether any test files did. This is authoritative; no model is asked.
2. Runs the **independent review** (balanced and deep).
3. **Judges each criterion** against the listed checks, with a strict judging prompt. Then Sutra itself enforces the rules: a criterion is `passed` only if a cited check passed, ran **after the last edit**, and isn't a review or the pre-edit baseline. `failed` requires a cited failing check. Everything else is `unverified`, with the reason.
4. **Sends work back** (`[Sutra finish gate]`) with the exact gaps, within the mode's limit. If a criterion can't be verified, the model is asked to say why rather than claim it.
5. Finishes with an overall label: `verified` (every criterion passed), `partial`, `unverified` or `failed`. The label comes with the version (a hash of the changed files' contents), every check, the review, the counterexamples and the candidates.

The result appears in the turn summary, in `sutra -p` output, in `sutra export` audit reports, and per task in `sutra bench`. In bench it sits next to the independent test result, so you can see when the gate's verdict and reality disagree. Turns that change nothing and run nothing (questions, explanations) skip the gate.

## Guardrails

- The permission engine stays authoritative. Sub-agents (the verifier and candidates) run unattended, so they run only when the OS sandbox is active, or when you chose the Flow profile. Otherwise the stage is skipped and the reason is shown.
- Sub-agents work only in disposable copies. Their commands are sandboxed with no network, and they are killed by timeouts and budgets.
- Generated tests are provisional and re-run by Sutra; they are never treated as the oracle.
- Patches are never selected because an LLM reviewer likes them or because candidates agree. Selection uses deterministic gates on your original tests.
- `balanced` keeps well-covered fixes cheap. Every layer's cost appears in `/cost`.

## What has been measured

On 2026-11-05, with the live DeepSeek API (`deepseek-flash`) and the 4 bundled benchmark tasks:

| Mode | Pass rate (independent) | Gate verdict | Total cost | Total time |
| --- | --- | --- | --- | --- |
| `fast` | 4/4 | partial × 4 (no mapping without a judge) | $0.0056 | 41 s |
| `balanced` | 4/4 | verified × 4 | $0.0074 | 59 s |
| `deep` (2 tasks) | 2/2 | 1 verified, 1 partial | $0.05 | 488 s |

What this shows, and doesn't:

- **The finish gate agrees with the independent test check** on all four tasks in `balanced` mode, for about 32% more than `fast`.
- An earlier version of `balanced` cost 9× and labelled 3 correct fixes "partial". The judge was too strict, and the gate didn't use Sutra's own change record. Both were fixed using that data.
- **In deep mode the live verifier found a real boundary bug** the project's tests didn't cover ("a session expiring exactly now"). Sutra confirmed it, and the agent fixed it. Deep mode is slow and several times more expensive.
- **The bundled tasks are too easy to show pass-rate gains**: every mode solves all of them. Showing whether the engine raises resolve rates needs a held-out suite of harder, real-repository tasks, comparing ablations at a fixed budget: no packet, +packet, +gate, +counterexamples, +competing patches. That hasn't been done yet.

## Code

| File | Role |
| --- | --- |
| `src/quality/engine.ts` | per-turn controller: begin (packet, contract, baseline, snapshot), observe (checks, edit epochs, stalls), finish (gate) |
| `src/quality/localize.ts` | localization signals and the evidence packet |
| `src/quality/verifier.ts` | counterexample search, confirmation and bank re-runs |
| `src/quality/branches.ts` | competing patches and deterministic selection |
| `src/quality/review.ts` | two-step alignment review |
| `src/quality/isolated.ts` | unattended agents in disposable copies |
| `src/quality/snapshot.ts` | workspace snapshots and tree hashes |
| `src/quality/ledger.ts`, `src/tools/agent/hypotheses-tool.ts` | the hypothesis ledger |

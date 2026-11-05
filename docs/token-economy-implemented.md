# Token economy: what is implemented

This page describes what Sutra now does to spend fewer tokens per verified task, and what has been measured. The original research proposal, with its rationale and sources, is [token-economy.md](token-economy.md). It is kept unchanged.

The target remains **verified tasks per billed token**, not raw compression. Every change below is lossless: the full text is always one call away. Wherever a lossless result can't be guaranteed, Sutra falls back to sending the full output.

## 1. Conditional repository map

`src/context/focus-map.ts`, config `index.mapMode` (`auto` | `always` | `never`), CLI `--map`.

- **Before:** a 2,000-token static map sat in the system prompt on every request.
- **`auto` (the new default):** for each request, Sutra decides:
  - **No map** when the request names an indexed file, quotes a test that resolves to one file, or names an identifier with a single definition. Also no map for short follow-ups (three words or fewer), for follow-ups that name no code, and when every file it would focus on was already mapped this session.
  - **A focused map** (about 1,200 tokens) when the request is ambiguous, or spans files (for example "rename … everywhere", "where is …", or two named files). It is centred on the named files, their definitions, related tests and the top search hits. It is appended after the request, so the cached prefix stays unchanged.
- **`always`:** the old static map in the system prompt. **`never`:** no map at all; `repo_map` remains available as a tool.
- **Record:** every turn records its decision (`TurnResult.contextMap`), and `sutra bench` reports it per task.

## 2. Context compiler

`src/context/compiler.ts` and `src/context/test-report.ts`, config `context.compile` (default `true`).

Each tool result is compiled once, at the moment it enters history. Earlier messages are never rewritten.

- **Repeated test runs become deltas.** A run of the same command as before is compared with the previous run, failure by failure. The model receives:
  - unchanged failures, by name, pointing at the call that last showed their exact text;
  - changed or new failures, with their exact assertion and stack block;
  - tests that now pass;
  - pass counts compared with the previous run;
  - `get_output {"call_id": …}` for the full log.

  Failure blocks are parsed from node:test (spec and TAP), vitest/jest and pytest output. If any failing test can't be isolated, the log was truncated, or the run crashed, the full output is sent instead.
- **Unchanged re-reads become pointers.** A `read_file` of a range already shown, with the same content hash, returns a pointer to the earlier call. Edits stay allowed, because the file really was read.
- **Edits mark old reads as stale.** A successful edit names the earlier reads of that file that are now out of date, and forgets them. Edit anchors always come from the current text.
- **Compaction resets the records.** After compaction, nothing points at results that are no longer in context. The summary gains harness facts: the latest result of each test command, with failure excerpts, and the current content hash of every edited file.
- **`get_output`** (new tool) returns the exact recorded output of an earlier call, with optional line ranges. `diagnose_failure` stores the raw runner output there.

## 3. Identical re-runs are skipped

`ContextCompiler.preempt` runs before the permission check. It answers a `run_tests` (or `diagnose_failure`) call identical to the previous one with "not re-run — nothing changed since call N", in these conditions:

- No edit, no other command and no new user turn has happened since. Any of these advances the compiler's epoch.
- The call does not pass `force: true`. `run_tests` accepts it, for example for flaky tests.

Skipped runs are not counted as tests and are not checks for the finish gate.

## 4. Focused tools

- **`inspect_symbol`** (`src/tools/index/inspect-tools.ts`) returns, for one symbol:
  - the definition, with its exact body line-numbered like `read_file`. The body's end is found by matching braces, or by indentation for Python-like languages. Bodies are capped at 80 lines by default; a longer body says where it continues.
  - callers, each with the function the call sits in;
  - tests that mention the symbol.

  The file is recorded as read, so it can be edited directly.
- **`diagnose_failure`** (`src/tools/shell/diagnose-tool.ts`) runs the tests, targeted by an optional `filter`. For each failure (up to 3) it returns:
  - the exact assertion, with runtime-internal stack frames dropped;
  - the top stack frame in your source code, with ±5 lines and the enclosing function;
  - the assertion line in the test;
  - when no source frame exists, the source definitions called on that line.

  It falls back to the raw output if failures can't be isolated. It is an `execute` tool under the same approval rules as `run_tests`, and the quality engine counts it as a test check.

## 5. Quality checks that earn their tokens (experiment)

Config `quality.economy` (default `false`), CLI `--economy`, in `src/quality/engine.ts`.

- **When there is a failing baseline.** For a bug whose baseline run has named failing tests, the acceptance criteria come from that baseline instead of a contract call:
  1. the previously failing tests pass;
  2. the full suite passes;
  3. no test files are modified.
- **At the finish gate.** If the latest full-suite run is fresh and passes, the harness's change record shows no test file changed, and no banked counterexample fails, then the criteria are settled without the model. The review and judge calls are skipped.
- **Otherwise, the normal path.** This includes a targeted run that isn't the full suite, a feature request with no failing baseline, or any doubt.
- **What gets recorded.** Skipped calls are listed in `Verification.economy`. Counterexample rules are unchanged: `balanced` hunts only when a criterion is open, and `deep` always hunts.

This trades the independent review for cost on well-covered bug fixes. The review can catch problems tests miss, which is why it is off by default.

## 6. Prompt-cache continuity

- **Stable prefix.** The system prompt and tool list are now byte-stable within a session: the map moved out, and tool order is fixed. Per-request evidence (packet, focused map) is appended after the request, and tool results are never rewritten after the fact.
- **Checkpoint compaction.** Config `context.checkpointThreshold`, default 0.5. When tests pass after edits and context is above that fraction of `maxContextTokens`, Sutra compacts at that settled point. Otherwise compaction happens later, at 75%, in the middle of an investigation. Compaction changes the prefix once, deliberately.
- **Measured cache hits.**
  - `sutra bench` reports the provider-reported cache-hit fraction (`summary.cacheHitRate`) and the harness settings for each run.
  - `/cost` shows the cache-hit meter. It also shows a **Compiler** row: test deltas, unchanged re-reads, skipped re-runs and approximate tokens kept out.

## 7. Budget by information gained

**This is rule-based, not a learned or general value-of-information controller.** Each rule spends only when the action could resolve an open question:

- a test re-run with nothing changed is skipped;
- a re-read of unchanged text becomes a pointer;
- a map is sent only when the request is ambiguous or spans files;
- with `--economy`, review and judge are skipped when deterministic checks settle every criterion;
- `balanced` runs the counterexample hunt only when a criterion still lacks evidence. This rule predates this work.

There is no per-action estimate of expected information gain. Thresholds have not been tuned on held-out data.

## What has been measured

These runs used the live DeepSeek API (`deepseek-flash`) on 5 November 2026, with one run per setting.

### Bundled benchmark (4 tasks)

| Setting | Pass | Gate verdict | Cost | Time | Input tokens | Cache hits |
| --- | --- | --- | --- | --- | --- | --- |
| `fast` | 4/4 | partial × 4 | $0.0059 | 40 s | 116,471 | 82% |
| `balanced` | 4/4 | verified × 4 | $0.0065 | 46 s | 86,650 | 70% |
| `balanced --economy` | 4/4 | verified × 4 | $0.0055 | 31 s | 84,370 | 74% |
| `balanced --map always` | 4/4 | verified × 4 | $0.0064 | 45 s | 87,314 | 71% |

For comparison, before this work (same day, same tasks): `fast` cost $0.0056 in 41 s, and `balanced` $0.0074 in 59 s.

**What this shows:**

- **Economy.** It was 15% cheaper and 33% faster than `balanced`, with the same verdicts. On three of four tasks it used 4 model requests instead of 8: the contract, review and judge calls were skipped. On the fourth (slugify) it took the normal path.
- **Map.** In `auto`, three of the four tasks named their file and got no map. The fourth (session-expiry, "the request is ambiguous") got a focused map. The cost difference against `--map always` is within run-to-run noise on these tasks.
- **Compiler.** It barely triggered: one test delta in one task, 142 characters saved. These tasks take 4–8 requests and rarely re-run or re-read anything. The compiler's savings would show on long debugging sessions, which this suite doesn't contain.
- **Limits of this suite.** All settings solve 4/4, so this suite cannot show solve-rate gains or losses. One run per setting cannot separate small cost differences from noise. The comparison with the earlier runs mixes this work with other changes made on the same day.

### Navigation A/B on Sutra's own repository

Three read-only questions, `--quality fast`, map `auto` against map `always` (the static map in the system prompt):

| Question | Map (`auto`) | `auto`: input tokens / tools / cost | `always`: input tokens / tools / cost |
| --- | --- | --- | --- |
| Where network access is decided and what the sandbox does | focused (spans files) | 109,373 / 12 / $0.0056 | 96,386 / 10 / $0.0050 |
| How the finish gate decides a criterion passed | focused (spans files) | 29,446 / 3 / $0.0020 | 39,959 / 4 / $0.0026 |
| Which function in `test-counts.ts` parses pytest failures | none (file named) | 12,901 / 3 / $0.0007 | 10,580 / 1 / $0.0006 |
| **Total** | | **151,720 / 18 / $0.0084** | **146,925 / 15 / $0.0082** |

**Result: a wash.** `auto` was cheaper on one question and slightly more expensive on two; the totals are within 3%. All six answers located the right code. On the third question, the `auto` answer named `parseFailingTests` as the pytest failure parser. The `always` answer said there was no dedicated function, and pointed at the inline pytest handling in `parseTestCounts`. The `auto` answer is the more precise of the two.

This matches the earlier finding: on a repository of about 100 files, a map neither helps nor hurts much. Whether the focused map pays off on large repositories, where grep stops being enough, has not been measured.

### Next steps for measurement

- **A harder held-out suite.** It should have long debugging tasks, where test deltas, read dedupe and skipped re-runs actually trigger.
- **Repeated paired runs.** Run each setting several times, comparing solve rate, billed tokens, cache hits and false "verified" verdicts.
- **Measure economy's risk.** Check how often the skipped review would have caught a real gap.

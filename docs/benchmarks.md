# Benchmarks

`sutra bench` answers two practical questions about a provider and model: **does it actually solve coding tasks in Sutra, and what does each solved task cost?**

```bash
sutra bench                                    # every bundled task, current provider and model
sutra --model deepseek-v4-pro bench            # compare models
sutra --provider ollama --model qwen3-coder bench
sutra bench --only slugify --max-cost 0.25     # one task, tighter spend limit
sutra bench --tasks ./my-tasks --out results.json
```

The exit code is 0 only if every task passed.

## How a task is judged

For each task, Sutra:

1. copies the task's `repo/` into a fresh temporary directory;
2. runs **one** agent turn with the task's prompt, using the Flow profile, the OS sandbox, a per-task spend limit (`--max-cost`, default $0.50) and a timeout. No one is there to approve anything, so actions that need approval are denied;
3. restores the task's **protected** paths (usually `test/`) from the pristine copy;
4. runs the task's `verify` command, sandboxed, and records **pass if and only if it exits 0**.

What the agent *says* doesn't matter. An agent that deletes or edits the tests to make them pass still fails at step 4. The suite has a test that checks exactly this.

Each run is a normal saved session. The results include its session ID, so you can see exactly what happened:

```bash
sutra replay <session-id>
sutra export <session-id> --format md
```

## Results

Results are printed as a table, and saved to `~/.sutra/bench/<timestamp>.json` with a Markdown table alongside, ready to paste into an issue:

```
  ✓ pass  session-expiry        $0.0015     0.4s    5 req    5 tools  completed · 1deead71

Sutra / bench  deepseek · deepseek-flash · sandbox seatbelt
  Passed          1/1 (100%)
  Total cost      $0.0015
  Cost per pass   $0.0015
```

<sub>From a run against a local mock server, so the cost and time here are not real model numbers.</sub>

The JSON (`schema: "sutra.bench/v1"`) records, per task: pass/fail, how the agent's turn ended, cost (and whether every request had a known price), tokens in, cached and out, requests, tool calls, duration, files changed, the session ID, and the last lines of the verification output.

**No results have been published yet.** If you run the suite against a real provider, please share the JSON along with the Sutra version, model and date.

## The bundled tasks

| Task | Kind | What it takes |
| --- | --- | --- |
| `session-expiry` | bugfix | Spot that a timestamp in seconds is compared with `Date.now()` in milliseconds |
| `pagination` | bugfix | Fix two off-by-one errors (1-based pages, rounding up the page count) |
| `csv-quotes` | bugfix | Rewrite a naive `split(",")` into a quote-aware CSV field parser |
| `slugify` | feature | Implement a function from its doc comment and tests (accents, separators, word-boundary truncation) |

They are deliberately small, use only Node's built-in test runner (no installs, no network), and each one ships a reference solution. The test suite checks that every baseline fails and every reference solution passes, so the tasks can't silently break.

Four small tasks are a smoke test, not a leaderboard. They tell you whether a model handles Sutra's tool loop reliably and roughly what it costs. Larger, more realistic task sets are on the roadmap.

## Writing a task

```
my-tasks/
  fix-the-thing/
    task.json
    repo/          # the starting repository the agent sees
    solution/      # optional: files that, copied over repo/, make verify pass
```

`task.json`:

```json
{
  "title": "Fix the thing",
  "kind": "bugfix",
  "prompt": "The tests fail. Fix the bug in src/. Do not modify the tests.",
  "verify": "node --test test/",
  "protected": ["test"],
  "timeoutMs": 600000
}
```

| Field | |
| --- | --- |
| `prompt` | exactly what the agent is asked |
| `verify` | command run after the agent finishes; exit 0 = pass. It also serves as the agent's `run_tests` command |
| `protected` | paths restored from `repo/` before verifying, so tests can't be edited into passing |
| `kind` | `bugfix`, `feature` or `refactor` (informational) |
| `timeoutMs` | per-task limit for the agent's turn (default 10 minutes) |

Good tasks fail at baseline, have a single objective check, and don't need the network: the agent's commands run in the sandbox with no network access.

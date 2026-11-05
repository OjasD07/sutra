# Harness benchmark: Sutra vs other coding agents

This runs the same coding tasks through several agent harnesses, on the same DeepSeek model with the same key, and measures them the same way:

| Harness | Command used | How it reaches DeepSeek |
| --- | --- | --- |
| Sutra (`sutra`, `sutra-fast`) | `sutra -p --profile flow --quality balanced\|fast` | `DEEPSEEK_BASE_URL` |
| Claude Code (`claude-code`) | `claude --print --dangerously-skip-permissions` | DeepSeek's Anthropic-compatible endpoint (`ANTHROPIC_BASE_URL`) |
| Codex CLI (`codex`) | `codex exec --dangerously-bypass-approvals-and-sandbox` | custom `model_providers` entry (Chat Completions) |
| Aider (`aider`) | `aider --message … --yes --no-auto-commits` | `OPENAI_API_BASE`, model `openai/<model>` |
| OpenCode (`opencode`) | `opencode run --format json` | custom `@ai-sdk/openai-compatible` provider |
| Goose (`goose`) | `goose run --no-session -t …` | `GOOSE_PROVIDER=openai`, `OPENAI_HOST` |
| Qwen Code (`qwen-code`) | `qwen -p … --yolo` | `OPENAI_BASE_URL`, `OPENAI_MODEL` |

## Quick start

```bash
cd benchmarks/harnesses
./run.sh setup              # lists install commands; ./run.sh setup --install runs them
./run.sh check              # installed? are the flags we rely on still in each CLI's --help?
./run.sh selftest           # offline: checks the proxy, scoring and tamper detection (no API spend)
./run.sh run --trials 3 --max-cost 5
```

The key comes from `$DEEPSEEK_API_KEY`, or from `~/.sutra/credentials.json` if you ran `sutra init`. It is passed to each harness only through environment variables, is never written to disk, and is scrubbed from the saved logs.

## How it measures

- **One metering proxy.** Every harness talks to DeepSeek through a local proxy (`proxy.mjs`). It counts requests, input tokens, cache-hit tokens, output and reasoning tokens from the provider's own usage fields, for the OpenAI and Anthropic formats, streaming or not. So the numbers don't depend on what each harness reports about itself. The one change it makes: on a streaming chat request that didn't ask for usage, it adds `stream_options.include_usage`, so the provider reports tokens.
- **Isolation.** Each run gets a fresh copy of the task repository (a git repo with one commit) and an **empty HOME**. No harness sees your settings, memory, plugins, MCP servers or instruction files, and nothing it writes touches yours.
- **Judging.** When the harness exits (or hits the timeout), the protected paths (the tests) are compared with the originals, then restored, and the task's `verify` command decides pass or fail.
- **Fairness.** All harnesses get the same prompt, model, timeout and key. Runs are interleaved (trial 1 of every harness on task A, then task B, …), so time-of-day effects such as load or peak pricing hit all of them alike. Sutra's OS sandbox is off by default, because the others run unsandboxed; `--sandbox-sutra` turns it on.

## Metrics

| Metric | Meaning |
| --- | --- |
| Pass | Share of runs whose tests pass, ± the standard deviation across trials |
| pass@k / pass^k | Tasks solved in at least one trial / in every trial (consistency) |
| False success | The harness exited 0, but the tests fail |
| Tamper | Runs that modified the tests (restored before judging) |
| Median time | Wall-clock per run, and model time (summed request latency) in the JSON |
| Cost / run, Cost / pass | From the metered tokens at DeepSeek's peak or off-peak price at the time of each request |
| Passes per 1M tokens | Solved runs per million billed (input + output) tokens |
| Input / output / reasoning tokens, cache hit | Per run, from the provider's usage fields |
| Requests | Model round trips per run; failed requests and requests with no usage data are counted too |
| Lines / files changed | Size of the final diff, excluding the restored tests |

Outputs go to `results/<timestamp>/`: `report.md` (tables), `report.json` (everything), `results.csv` (one row per run), and `logs/<harness>/<task>-t<trial>.*` with stdout, stderr, the verify output, every metered request and the diff.

## Options

```
./run.sh run [options]
  --harnesses a,b,c   which to run (default: all installed): sutra, sutra-fast, claude-code, codex, aider, opencode, goose, qwen-code
  --tasks <dir>       task directory (default: ../tasks); same format as `sutra bench`
  --only a,b          only these task ids
  --trials N          runs per harness per task (default 3)
  --model <id>        deepseek-flash (default) or deepseek-v4-pro
  --timeout <sec>     per run (default: the task's timeoutMs, else 600)
  --max-cost <usd>    stop starting new runs after this total spend
  --prices <file>     JSON price table to use instead of the built-in DeepSeek prices
  --keep              keep each run's workspace for inspection
  --sandbox-sutra     run Sutra inside its OS sandbox
```

## Caveats, read before trusting a number

- **These harnesses run with every approval granted**, executing whatever the model asks in a temp directory under your user account. Only Sutra's sandbox (opt-in here) restricts that. Run on a machine you're comfortable with.
- **Adapters for fast-moving CLIs.** `check` greps each CLI's `--help` for the flags used, and `adapters.mjs` says where each adapter's settings came from. The Claude Code flags were checked against its `--help`. The Aider and OpenCode settings come from their docs. The Codex, Goose and Qwen Code settings could not be fully confirmed from docs when this was written. If a harness's runs all show `errors` in the report, look at its `logs/` first: the cause is usually a changed flag or provider setting, not the model. Recent Codex versions may only support the Responses API, which DeepSeek doesn't offer.
- **The tasks.** The bundled four tasks are small; every capable harness may solve all of them, so differences will show up mostly in cost, time and tokens. For pass-rate differences, add harder tasks under `--tasks` (same `task.json` format: `prompt`, `verify`, `protected`, `repo/`).
- **Out-of-the-box behaviour is being compared.** Each harness uses its own system prompt, tools and defaults with the same model; nothing is tuned per harness. DeepSeek through an Anthropic-compatible or OpenAI-compatible shim is not how most of these tools are usually run, so their results here may differ from their results on their home models.
- **Variance.** Model output is not deterministic. Use at least 3 trials and look at the ± and pass^k before calling a winner.

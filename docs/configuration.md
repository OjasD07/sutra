# Configuration

## Files

| Path | Purpose | Trust |
| --- | --- | --- |
| `~/.sutra/config.json` | user settings | trusted |
| `~/.sutra/credentials.json` | API keys (mode 600), written by `sutra init` | trusted |
| `~/.sutra/AGENTS.md` | personal instructions for every project | guidance |
| `<repo>/AGENTS.md`, `<repo>/.sutra/AGENTS.md` | project instructions | guidance, lower trust |
| `<repo>/.sutra/config.json` | `model`, `tools.testCommand`, extra `protectedPaths` / `sensitivePaths` only | lower trust |
| `~/.sutra/sutra.db` | sessions (SQLite, mode 600) | |
| `~/.sutra/logs/` | `sutra.log` (structured), `tools/<session>/*.log` (full command output) | |

Set `SUTRA_HOME` to relocate `~/.sutra`.

**Precedence**, highest first: CLI flags > environment variables > user config > project config > defaults.

## Environment

| Variable | |
| --- | --- |
| `DEEPSEEK_API_KEY` | API key (takes precedence over credentials.json) |
| `DEEPSEEK_BASE_URL` | default `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | e.g. `deepseek-flash`, `deepseek-v4-pro` (DeepSeek only) |
| `SUTRA_PROVIDER` | `deepseek` (default), `ollama` or `openai-compatible` |
| `SUTRA_MODEL` | model for any provider |
| `SUTRA_QUALITY` | `fast` / `balanced` / `deep` |
| `OPENAI_BASE_URL` / `OPENAI_API_KEY` | endpoint and key for `openai-compatible` |
| `OLLAMA_HOST` | Ollama address, e.g. `127.0.0.1:11434` (Sutra adds `/v1`) |
| `SUTRA_PROFILE` | `inspect` / `confirm` / `flow` |
| `SUTRA_LANG` | `en` / `hi` |
| `SUTRA_HOME` | state directory |
| `NO_COLOR` | disable colour |

Sutra does not read `.env` files. See [security.md](security.md) for why.

## Example `~/.sutra/config.json`

```json
{
  "provider": "deepseek",
  "model": "deepseek-flash",
  "thinking": "enabled",
  "reasoningEffort": "high",
  "permissions": {
    "profile": "confirm",
    "allowCommands": ["make verify", "pnpm lint"],
    "protectedPaths": ["vendor/", "src/generated/**"],
    "sensitivePaths": ["config/prod.yaml"]
  },
  "budget": {
    "maxSessionCostUsd": 1.0,
    "warnAtFraction": 0.8,
    "maxIterationsPerTurn": 60,
    "maxToolCallsPerTurn": 200
  },
  "context": {
    "maxContextTokens": 200000,
    "compactThreshold": 0.75,
    "keepRecentTurns": 2
  },
  "tools": {
    "commandTimeoutMs": 120000,
    "maxOutputChars": 30000,
    "retainFullLogs": true,
    "testCommand": "npm test",
    "scrubEnv": true
  },
  "ui": { "theme": "auto", "language": "en" }
}
```

`allowCommands` adds prefixes that `flow` treats as routine. Destructive, network and compound commands still ask.

## Providers

| `provider` | Endpoint | Key | Cost |
| --- | --- | --- | --- |
| `deepseek` | `providers.deepseek.baseUrl` (default `https://api.deepseek.com`) | `DEEPSEEK_API_KEY` or `sutra init` | DeepSeek prices (below) |
| `ollama` | `providers.ollama.baseUrl` (default `http://localhost:11434/v1`) | none | $0 |
| `openai-compatible` | `providers.openai.baseUrl` (default `https://api.openai.com/v1`) | `OPENAI_API_KEY`; optional for `localhost` | `pricing.<model>` if set; $0 when `providers.openai.freeOfCharge` is true; otherwise "unknown" |

For Ollama and OpenAI-compatible servers there is no built-in default model. Sutra uses `model` from your config or `--model`; if neither is set, it uses the first model the server lists and tells you so.

```json
{
  "provider": "ollama",
  "model": "qwen3-coder",
  "providers": { "ollama": { "contextWindow": 32768 } }
}
```

```json
{
  "provider": "openai-compatible",
  "model": "Qwen/Qwen3-Coder-30B-A3B-Instruct",
  "providers": {
    "openai": {
      "baseUrl": "http://localhost:8000/v1",
      "freeOfCharge": true,
      "contextWindow": 65536
    }
  }
}
```

**Context windows for local models.** Sutra can't reliably learn a local server's context length, so it assumes `providers.ollama.contextWindow` (default 32768) or `providers.openai.contextWindow` (default 128000) for models without metadata. Make these match your server. Ollama in particular **silently truncates** prompts longer than its configured context (`OLLAMA_CONTEXT_LENGTH`, or the model's `num_ctx`), which shows up as the agent "forgetting" the task.

The OpenAI-compatible adapter sends standard Chat Completions (streaming, `tools`, `stream_options.include_usage`). It reads streamed reasoning from `reasoning_content` or `reasoning` (Ollama, OpenRouter) for progress display, but doesn't send it back, because generic servers don't expect it.

## Quality

```json
{ "quality": { "mode": "balanced" } }
```

`fast`, `balanced` or `deep`. Also `--quality <mode>`, `SUTRA_QUALITY` and `/quality`. See [quality-engine.md](quality-engine.md) for what each mode does and costs.

## Repository index

```json
{
  "index": {
    "enabled": true,
    "mapTokens": 2000,
    "maxFiles": 5000,
    "embeddings": { "baseUrl": "http://localhost:11434/v1", "model": "nomic-embed-text" }
  }
}
```

| Key | |
| --- | --- |
| `enabled` | Build the index at session start and offer `repo_map`, `find_symbol` and `code_search`. `--no-index` turns it off for one run |
| `mapTokens` | Size of the repository map placed in the system prompt; `0` keeps the tools but leaves the map out of the prompt |
| `maxFiles` | Stop indexing after this many source files (the map then says so) |
| `embeddings` | Optional. Any OpenAI-compatible `/embeddings` endpoint. `code_search` then fuses BM25 with embedding similarity (reciprocal-rank fusion). Use `apiKeyEnv` to name an environment variable holding the key; keys are never stored in config. `maxChunks` caps how much code is embedded (default 4,000 chunks) |

With embeddings configured, code chunks are sent to that endpoint. Use a local server (for example `ollama pull nomic-embed-text`) to keep code on your machine. Vectors are cached in `~/.sutra/index/` by content hash, so unchanged code is embedded only once. Embedding requests are not included in `/cost`. If the endpoint fails, `code_search` says so and falls back to BM25.

## Sandbox

```json
{ "sandbox": { "mode": "auto", "network": false, "allowWrite": [] } }
```

| Key | |
| --- | --- |
| `mode` | `auto` (default): use the OS sandbox when available. `required`: refuse to run commands without it. `off`: approvals only. Also `--sandbox <mode>` |
| `network` | `true` allows outbound network for every command. Default `false`: only commands approved as network commands get it |
| `allowWrite` | extra directories (relative to the workspace, or absolute) commands may write to |

See [security.md](security.md) for what the sandbox enforces.

## Models

Sutra ships metadata for `deepseek-flash` and `deepseek-v4-pro` (1M-token context, up to 384K output), taken from DeepSeek's documentation on 2026-11-05. Both support tool calls in thinking mode. To add or adjust a model:

```json
{ "providers": { "deepseek": { "models": { "my-model": { "contextWindow": 131072, "maxOutputTokens": 8192, "supportsThinking": false } } } } }
```

Models Sutra doesn't know about get conservative defaults (128K context, no thinking).

`context.maxContextTokens` defaults to 200,000, below the 1M window. Every request re-sends the context, so the cap keeps the cost per request predictable. Raise it if you need longer uncompacted sessions.

## Pricing

Costs are estimates, calculated as `cache-hit input × hit price + cache-miss input × miss price + output × output price`, using usage reported by the provider. The defaults are DeepSeek's published prices as of 2026-11-05, including the UTC weekday peak windows and the off-peak rates. Override or add prices (USD per 1M tokens):

```json
{
  "pricing": {
    "deepseek-flash": {
      "inputCacheHit": 0.006,
      "inputCacheMiss": 0.3,
      "output": 1.2,
      "offPeak": { "inputCacheHit": 0.003, "inputCacheMiss": 0.15, "output": 0.6 },
      "peakWindowsUtc": [
        { "days": [1, 2, 3, 4, 5], "start": "01:00", "end": "04:00" },
        { "days": [1, 2, 3, 4, 5], "start": "06:00", "end": "10:00" }
      ],
      "asOf": "2026-11-05"
    }
  }
}
```

If a model has no price, `/cost` marks the total as incomplete instead of guessing.

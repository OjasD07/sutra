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
| `DEEPSEEK_MODEL` | e.g. `deepseek-flash`, `deepseek-v4-pro` |
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

# Contributing to Sutra

Thanks for helping. Sutra's value is that it is reliable and honest, so contributions are judged on correctness first.

## Setup

```bash
npm install
npm run typecheck
npm test
```

Node 22.13 or later is required. Tests need no network and no API key. Live API checks are opt-in: `DEEPSEEK_API_KEY=... npm run test:smoke`.

## Ground rules

- **No fake behaviour.** UI output must come from real runtime events. Tools must really do what they report. Tests may script the *model* (see `tests/helpers/scripted-provider.ts` and `mock-deepseek-server.ts`), but tools, permissions and persistence run for real.
- **Protocol invariants are sacred.** Every tool call gets exactly one result. Turns end in an explicit state. Reasoning content stays out of logs and the UI.
- **Security decisions belong in the harness** (`src/permissions`). They never belong in prompts. Anything that loosens a default needs a test and a note in `docs/security.md`.
- Keep layers decoupled. The runtime must not import a specific provider. Tools must not import the UI.
- Strict TypeScript. Prefer small, explicit code over clever abstractions.

## Adding a tool

Implement `Tool<A>` in `src/tools/…`: a zod schema, a `category`, `readOnly`, `describe()` returning the paths and commands it touches, an optional `preview()`, and `execute()` returning `ok()` or `fail()`. Register it in `createDefaultRegistry()` and add unit tests for success, bad arguments and permission behaviour.

## Adding a provider

Implement `ModelProvider` and register it with `registerProvider()`. Follow the provider's documentation exactly, especially for reasoning fields and tool-call history. Add wire-format and streaming tests with a mocked `fetch`.

## Commits and PRs

Keep each PR to one topic. Describe what changed and how you verified it. Include test output when behaviour changes.

## Security issues

Please report vulnerabilities privately to the maintainers instead of opening a public issue.

By contributing, you agree that your contributions are licensed under the Apache License 2.0.

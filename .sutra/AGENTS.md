# Sutra — instructions for agents working on this repository

## Commands
- Type check: `npm run typecheck`
- Tests: `npm test` (no network, no API key)
- Build: `npm run build`

## Conventions
- Strict TypeScript, ESM, `.js` import suffixes.
- Layers stay decoupled: `core/agent` must not import `providers/deepseek`; tools must not import `tui`.
- Every tool call gets exactly one result; every turn ends in an explicit status. Add a test when touching the runtime.
- Security decisions live in `src/permissions`, never in prompts.

## Restricted
- Do not edit `LICENSE` or `NOTICE` without being asked.

# session-expiry (Sutra example)

A tiny project with a real bug: `isExpired` compares a timestamp in seconds
with `Date.now()` in milliseconds, so every session looks expired.

```bash
cd examples/session-expiry
npm test          # 2 of 4 tests fail
sutra "The session tests fail. Find and fix the bug."
```

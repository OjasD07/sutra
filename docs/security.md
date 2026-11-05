# Security model

Sutra runs a language model that proposes actions on your machine. This page explains what Sutra enforces, what it does not, and why.

## Approval gate vs. sandbox

Sutra provides an **application-level approval gate**. Before any tool runs, the harness (not the model) decides whether to allow it, ask you, or refuse it. Sutra does **not** provide OS-level sandboxing: an approved shell command runs as your user, with your filesystem, network and credentials. A command that looks harmless, like `npm test`, runs whatever the project's scripts contain.

| | Approval gate (what Sutra has) | Sandbox (what Sutra does not have yet) |
| --- | --- | --- |
| Stops the model from writing outside the workspace via file tools | yes | yes |
| Stops an approved command from doing anything | **no** | yes, within the sandbox policy |
| Protects against a malicious test script you approve | **no** | partially |

Treat approving a command like running it yourself.

## Threats and mitigations

**Path traversal and symlink escapes.** File-tool paths are resolved against the workspace and canonicalised with `realpath`. For paths that don't exist yet, the nearest existing ancestor is canonicalised. Containment is then checked with `path.relative`, not with string prefixes. A symlink inside the workspace that points outside it resolves outside, and is treated that way. The directory walker does not follow symlinked directories.

**Prompt injection through repository content.** File contents, tool output and `AGENTS.md` files are data. The system prompt tells the model to treat embedded instructions as data and to report them. More importantly, nothing the model reads can change the permission policy, which lives in harness code. Repository `.sutra/config.json` is restricted to non-security keys and can only add restrictions. It cannot set the profile, allowlists, API endpoint or keys. Sutra does not auto-load a workspace `.env`, because a hostile repository could otherwise set `DEEPSEEK_BASE_URL` and capture your key.

**Accidental destructive operations.** Commands are split on `;`, `&&`, `||`, `|` and `&` (quote-aware), and substitutions and redirections are detected. Each segment is classified as `routine`, `unknown`, `network`, `destructive` or `privileged`. Only `routine` commands are auto-approved, and only in `flow`. Destructive, network, privileged and out-of-workspace actions always ask, and "allow for this session" is never offered for them. File deletion through `apply_patch` always asks. Writes into `.git/` are refused. `git_status` and `git_diff` run without a shell, with argument validation (refs may not start with `-`). Sutra never pushes, publishes or deploys on its own. Those commands are classified as destructive or network and need your approval.

**Silent overwrites.** Sutra records a hash of each file when it reads or writes it. Writing to an existing file fails if the agent never read it, or if its content changed since then. Multi-file patches are checked in full before anything is written.

**Secret leakage.**
- API keys are read from the environment or `~/.sutra/credentials.json` (mode 600). They are never printed. `sutra init` reads the key with hidden input.
- Subprocesses get an environment with secret-looking variables removed (`*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, …). You can turn this off with `tools.scrubEnv: false`.
- Tool output is redacted before it reaches the model, the UI or the database: the configured API key, `sk-…` key shapes and PEM private keys.
- Reading `.env`, key files, `.npmrc`, `.aws/credentials` and similar files asks for approval in `confirm` and `flow`, and is refused in `inspect`.
- The debug log redacts key and reasoning fields. Reasoning content is never logged or displayed. It is stored only in the local database, because DeepSeek requires it to resume tool-using conversations.

**Unapproved external data transfer.** Network-capable commands (`curl`, `wget`, `ssh`, `git push/fetch/clone`, package installs, `gh`, …) are classified as network and always ask. Sutra has no built-in tool that sends data anywhere except to the configured model provider. Note that the model provider receives the content of files the agent reads.

**Unbounded subprocesses.** Each command runs in its own process group with a timeout (default 120 s, capped at 30 min). On timeout or cancellation, the whole group gets SIGTERM, then SIGKILL two seconds later. Captured output is bounded in memory (head and tail), bounded again before it reaches the model, and written in full to `~/.sutra/logs/tools/<session>/` when `tools.retainFullLogs` is on. Commands get no stdin.

**Runaway agents.** Per-turn limits on iterations and tool calls, a per-session spend budget, and repeated-call loop detection all stop a turn with an explicit status.

## Known gaps

- There is no OS sandbox (see above).
- Command classification is heuristic and conservative. Unknown programs always ask, but a routine-looking command such as `npm test` executes project code.
- Approvals are per action. The `flow` profile trusts routine workspace edits by design.
- Sutra cannot prevent the provider from seeing what the agent reads. Use `inspect` and your own judgement for confidential code.

Report vulnerabilities privately to the maintainers (see CONTRIBUTING.md), not in public issues.

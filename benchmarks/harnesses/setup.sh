#!/usr/bin/env bash
# Install the harnesses the benchmark compares against.
# Without --install this only prints the commands; nothing is installed.
set -euo pipefail
install=0
[ "${1:-}" = "--install" ] && install=1

cmds=(
  "claude|npm install -g @anthropic-ai/claude-code"
  "codex|npm install -g @openai/codex"
  "aider|python3 -m pip install --user aider-install && aider-install"
  "opencode|npm install -g opencode-ai"
  "goose|curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | CONFIGURE=false bash"
  "qwen|npm install -g @qwen-code/qwen-code@latest"
)

for entry in "${cmds[@]}"; do
  bin="${entry%%|*}"; cmd="${entry#*|}"
  if command -v "$bin" >/dev/null 2>&1; then
    printf '  %-9s installed (%s)\n' "$bin" "$(command -v "$bin")"
  elif [ "$install" = 1 ]; then
    printf '  %-9s installing: %s\n' "$bin" "$cmd"
    bash -c "$cmd" || printf '  %-9s install FAILED; install it by hand and re-run ./run.sh check\n' "$bin"
  else
    printf '  %-9s missing    %s\n' "$bin" "$cmd"
  fi
done
[ "$install" = 1 ] || echo $'\nRe-run with --install to run these commands (they install global npm/pip packages and a binary).'

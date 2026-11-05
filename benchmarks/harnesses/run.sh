#!/usr/bin/env bash
# Cross-harness benchmark: Sutra vs other coding agents on DeepSeek.
#
#   ./run.sh setup            # show install commands for the other harnesses (add --install to run them)
#   ./run.sh check            # which harnesses are installed; are the flags we use still there?
#   ./run.sh selftest         # offline test of the pipeline, no API calls
#   ./run.sh run [options]    # the benchmark (see README.md for options)
#
# The DeepSeek key is read from $DEEPSEEK_API_KEY, or from ~/.sutra/credentials.json.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$node_major" -lt 22 ]; then echo "Node.js 22 or newer is required." >&2; exit 1; fi
if [ ! -d "$ROOT/node_modules/tsx" ]; then echo "Run 'npm install' in $ROOT first (Sutra runs from source)." >&2; exit 1; fi

cmd="${1:-help}"
[ $# -gt 0 ] && shift
case "$cmd" in
  setup) exec "$HERE/setup.sh" "$@" ;;
  check|selftest|run|help) exec node "$HERE/bench.mjs" "$cmd" "$@" ;;
  *) echo "usage: $0 setup|check|selftest|run [options]" >&2; exit 2 ;;
esac

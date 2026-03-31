#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PACKAGE_DIR"

echo "=== Building package ===" >&2
pnpm run build >&2

RESULTS_DIR="$SCRIPT_DIR/results"
mkdir -p "$RESULTS_DIR"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

echo "" >&2
echo "=== Running WASM echo benchmark ===" >&2
npx tsx benchmarks/echo.bench.ts \
  > "$RESULTS_DIR/echo_${TIMESTAMP}.json" \
  2> >(tee "$RESULTS_DIR/echo_${TIMESTAMP}.log" >&2)

echo "" >&2
echo "=== Running memory benchmark (sleep workload) ===" >&2
npx tsx --expose-gc benchmarks/memory.bench.ts --workload=sleep --count=10 \
  > "$RESULTS_DIR/memory_sleep_${TIMESTAMP}.json" \
  2> >(tee "$RESULTS_DIR/memory_sleep_${TIMESTAMP}.log" >&2)

echo "" >&2
echo "=== Running memory benchmark (PI session workload) ===" >&2
npx tsx --expose-gc benchmarks/memory.bench.ts --workload=pi --count=5 \
  > "$RESULTS_DIR/memory_pi_${TIMESTAMP}.json" \
  2> >(tee "$RESULTS_DIR/memory_pi_${TIMESTAMP}.log" >&2)

echo "" >&2
echo "=== Done. Results in $RESULTS_DIR ===" >&2

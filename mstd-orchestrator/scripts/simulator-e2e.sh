#!/usr/bin/env bash
# Feishu multi-bot simulator e2e gate.
# Red lines: never kill foreign daemon/consumer; no skip/pending fake green; A requires probe.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TRANSPORT="${1:-}"
if [[ "${1:-}" == "--transport" ]]; then
  TRANSPORT="${2:-}"
fi
TRANSPORT="${TRANSPORT:-synthetic}"

if [[ "${MSTD_E2E:-0}" != "1" ]]; then
  echo "[sim-e2e] MSTD_E2E=1 required" >&2
  exit 2
fi

if [[ -z "${MSTD_SIM_CHAT_ID:-${MSTD_SIMULATOR_CHAT_IDS:-}}" ]]; then
  echo "[sim-e2e] MSTD_SIM_CHAT_ID or MSTD_SIMULATOR_CHAT_IDS required" >&2
  exit 2
fi

if [[ "$TRANSPORT" == "synthetic" && -z "${MSTD_SIMULATOR_SECRET:-}" ]]; then
  echo "[sim-e2e] MSTD_SIMULATOR_SECRET required for synthetic" >&2
  exit 2
fi

# Detect existing daemon/consumer — reuse, never kill.
EXISTING="$(pgrep -af '[n]ode .*server/index.mjs|[l]ark-cli .*event.*consume' || true)"
STARTED_PID=""
if [[ -n "$EXISTING" ]]; then
  echo "[sim-e2e] reuse existing daemon/consumer (will not start or kill)"
  # Health check if port is up
  if ! curl -sf "http://127.0.0.1:${PORT:-8787}/api/health" >/dev/null; then
    echo "[sim-e2e] existing process found but /api/health not ready — operator must fix; refusing second consumer" >&2
    exit 3
  fi
else
  echo "[sim-e2e] no daemon found — starting owned daemon"
  node server/index.mjs &
  STARTED_PID=$!
  trap 'if [[ -n "${STARTED_PID}" ]]; then kill "$STARTED_PID" 2>/dev/null || true; fi' EXIT
  for i in $(seq 1 30); do
    if curl -sf "http://127.0.0.1:${PORT:-8787}/api/health" >/dev/null; then break; fi
    sleep 0.5
  done
fi

# A plain /api/health is insufficient: a daemon started before the simulator
# implementation can be healthy while silently lacking message IDs and traces.
CAPS="$(curl -sf "http://127.0.0.1:${PORT:-8787}/api/health/simulator" || true)"
if ! echo "$CAPS" | grep -Eq '"contractVersion"[[:space:]]*:[[:space:]]*1' \
  || ! echo "$CAPS" | grep -Eq '"traceEnabled"[[:space:]]*:[[:space:]]*true'; then
  echo "[sim-e2e] daemon is stale or trace capability is unavailable — restart current code before sending" >&2
  exit 8
fi
if [[ "$TRANSPORT" == "synthetic" ]] \
  && ! echo "$CAPS" | grep -Eq '"ingressEnabled"[[:space:]]*:[[:space:]]*true'; then
  echo "[sim-e2e] simulator ingress is disabled on the running daemon" >&2
  exit 9
fi

if [[ "$TRANSPORT" == "bot" ]]; then
  echo "[sim-e2e] running P0 probe for A mode"
  PROBE_OUT="$(npm run -s sim:probe || true)"
  echo "$PROBE_OUT"
  if ! echo "$PROBE_OUT" | grep -q '"nativeEligible":true'; then
    echo "[sim-e2e] nativeEligible!=true — refuse A mode" >&2
    exit 4
  fi
fi

SCENARIO="${SIM_SCENARIO:-simulator/scenarios/01-routing-core.yaml}"
# 按本次 run 的 runId 定位结果目录——"最新目录"启发式必然命中 locks/（其 mtime 恒最新），
# 会让下面全部门禁变成永久 no-op / 永不可达。
SIM_OUT="$(npm run -s sim:run -- --scenario "$SCENARIO" --transport "$TRANSPORT")" || SIM_STATUS=$?
echo "$SIM_OUT"
RESULTS="$(node -e '
  try {
    const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
    process.stdout.write(j.results ?? "");
  } catch { /* empty */ }
' <<<"$SIM_OUT")"
if [[ -z "$RESULTS" || ! -f "$RESULTS/report.json" ]]; then
  echo "[sim-e2e] no report for this run (results=$RESULTS)" >&2
  exit 5
fi
if grep -Eiq 'pending|todo|skip' "$RESULTS/report.json"; then
  echo "[sim-e2e] report contains skip/pending/todo — fail" >&2
  exit 6
fi
# 顶层 status 精读（grep 会误匹配嵌套的 grade.status）
TOP_STATUS="$(node -e '
  const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(String(j.status ?? ""));
' "$RESULTS/report.json")"
if [[ "$TOP_STATUS" != "passed" ]]; then
  echo "[sim-e2e] report not passed (status=$TOP_STATUS): $RESULTS" >&2
  exit 7
fi
if [[ "${SIM_STATUS:-0}" != 0 ]]; then
  echo "[sim-e2e] sim:run exited ${SIM_STATUS} — fail" >&2
  exit "${SIM_STATUS}"
fi

echo "[sim-e2e] ok report=$RESULTS"

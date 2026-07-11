#!/usr/bin/env bash
# 真机验收门禁(Task 13 固化):五套 E2E 串行 + Vitest JSON 统计双校验。
# 任何 failed/pending/todo 都判失败;passed 必须 >0 且 == total——skip 假绿在这里现形。
# 前置:独占 event consumer(存在未知 daemon/consumer 时打印清单退出,绝不代杀)。
set -euo pipefail
cd "$(dirname "$0")/.."

existing=$(pgrep -af '[n]ode .*server/index.mjs|[l]ark-cli .*event.*consume' || true)
if [ -n "$existing" ]; then
  echo "已有 daemon/event consumer,不代杀;请在独占维护窗口重跑:"
  echo "$existing"
  exit 2
fi

set -a; . ./.env; set +a
export MSTD_E2E=1 MSTD_ENABLE_WRITE=1 MSTD_SESSION_SECRET=${MSTD_SESSION_SECRET:-$(openssl rand -hex 16)}
export MSTD_TEST_OPEN_IDS=${MSTD_TEST_OPEN_IDS:-ou_aca75bd11914b20bda06e2462a569593}
export MSTD_TEST_CHAT_IDS=${MSTD_TEST_CHAT_IDS:-oc_11b72bc3d3bdedff7c86f3c4c61560fc,oc_b67c4510743e68be6a9a91f3906e7f97}

reports=$(mktemp -d "${TMPDIR:-/tmp}/mstd-e2e.XXXXXX")
trap 'rm -rf "$reports"' EXIT INT TERM
for t in e2e-persona e2e-write e2e-p2p e2e-group e2e-full; do
  report="$reports/$t.json"
  if ! npx vitest run "test/$t.test.mjs" --reporter=json --outputFile="$report"; then
    [ -f "$report" ] && cat "$report"
    exit 1
  fi
  node -e '
    const fs = require("node:fs");
    const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const ok = r.success === true && r.numPassedTests > 0 &&
      r.numPassedTests === r.numTotalTests && r.numFailedTests === 0 &&
      (r.numPendingTests ?? 0) === 0 && (r.numTodoTests ?? 0) === 0;
    if (!ok) { console.error(JSON.stringify(r, null, 2)); process.exit(1); }
  ' "$report" || exit 1
  echo "PASS $t"
done
echo "五套 E2E 串行全绿(JSON 门禁通过)"

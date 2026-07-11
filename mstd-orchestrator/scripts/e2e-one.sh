#!/usr/bin/env bash
# 单套 E2E + JSON 门禁(e2e-serial.sh 的单套形态,供长跑拆分;门禁语义一致)
set -euo pipefail
cd "$(dirname "$0")/.."
t="$1"
existing=$(pgrep -af '[n]ode .*server/index.mjs|[l]ark-cli .*event.*consume' || true)
if [ -n "$existing" ]; then echo "已有 daemon/consumer,不代杀:"; echo "$existing"; exit 2; fi
set -a; . ./.env; set +a
export MSTD_E2E=1 MSTD_ENABLE_WRITE=1 MSTD_SESSION_SECRET=${MSTD_SESSION_SECRET:-$(openssl rand -hex 16)}
export MSTD_TEST_OPEN_IDS=${MSTD_TEST_OPEN_IDS:-ou_aca75bd11914b20bda06e2462a569593}
export MSTD_TEST_CHAT_IDS=${MSTD_TEST_CHAT_IDS:-oc_11b72bc3d3bdedff7c86f3c4c61560fc,oc_b67c4510743e68be6a9a91f3906e7f97}
report=$(mktemp "${TMPDIR:-/tmp}/mstd-e2e-$t.XXXXXX.json")
trap 'rm -f "$report"' EXIT INT TERM
npx vitest run "test/$t.test.mjs" --reporter=json --outputFile="$report" || { [ -f "$report" ] && cat "$report"; exit 1; }
node -e '
  const fs = require("node:fs");
  const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const ok = r.success === true && r.numPassedTests > 0 &&
    r.numPassedTests === r.numTotalTests && r.numFailedTests === 0 &&
    (r.numPendingTests ?? 0) === 0 && (r.numTodoTests ?? 0) === 0;
  if (!ok) { console.error(JSON.stringify(r, null, 2)); process.exit(1); }
' "$report"
echo "PASS $t (JSON 门禁通过)"

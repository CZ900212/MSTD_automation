import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, migrate } from "./db/index.mjs";
import { loadServerConfig } from "./config.mjs";
import { createApp } from "./app.mjs";
import { createSemaphore } from "./jobs/semaphore.mjs";
import { createEventBus } from "./jobs/event-bus.mjs";
import { createEventBuffer } from "./jobs/event-buffer.mjs";
import { createRuntimeRegistry } from "./jobs/runtime.mjs";
import { makeFeishuClient } from "./auth/feishu-client.mjs";
import { makeRunLark, DEFAULT_LARK_CLI } from "./execute/run-lark.mjs";
import { testTargetFromEnv } from "./execute/write-target.mjs";
import { startPi } from "../supervisor/pi-client.mjs";
import { reconcileOnBoot } from "./execute/reconcile-startup.mjs";
import { createJobLauncher } from "./jobs/launcher.mjs";
import { startMinutesConsumer } from "./triggers/minutes-consumer.mjs";
import { backfillMinutes } from "./triggers/backfill.mjs";
import { startLarkHealth, makeDmAlert } from "./health/lark-profile.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = loadServerConfig(process.env);

if (config.enableWrite && !process.env.MSTD_SESSION_SECRET) {
  console.error("[mstd] 致命：MSTD_ENABLE_WRITE=1 时必须配置 MSTD_SESSION_SECRET（否则重启丢会话且审批链不可信）");
  process.exit(1);
}

const dbPath = process.env.MSTD_DB_PATH || join(ROOT, "db", "mstd.sqlite");
const db = openDb(dbPath);
migrate(db);

const semaphore = createSemaphore(config.maxConcurrentPi);
const bus = createEventBus();
const buffer = createEventBuffer(db);
buffer.start();
const registry = createRuntimeRegistry();
const feishu = makeFeishuClient(config.feishu);

const bootLark = config.larkProfile ? makeRunLark({ profile: config.larkProfile }) : null;
const boot = await reconcileOnBoot(db, { runLark: config.enableWrite ? bootLark : null });
console.error(`[mstd] boot reconcile: ${JSON.stringify(boot)}`);

const extensions = [
  join(ROOT, "pi-ext", "providers.ts"),
  join(ROOT, "pi-ext", "lark-read.ts"),
  join(ROOT, "pi-ext", "draft.ts"),
];
const launcher = createJobLauncher({
  db,
  config,
  startPi,
  semaphore,
  bus,
  buffer,
  registry,
  extensions,
  piCwd: ROOT,
});

let larkHealth = null;
if (config.larkProfile && bootLark) {
  larkHealth = startLarkHealth({
    runLark: bootLark,
    alert: makeDmAlert({ runLark: bootLark, openId: config.alertOpenId }),
  });
  larkHealth.checkOnce().catch(() => {});
}

if (config.enableTrigger && config.larkProfile) {
  startMinutesConsumer({
    db,
    launcher,
    larkCli: DEFAULT_LARK_CLI,
    profile: config.larkProfile,
  });
  console.error(`[mstd] trigger consumer on (${config.larkProfile})`);
  if (config.backfill && bootLark) {
    backfillMinutes({ db, launcher, runLark: bootLark }).catch((e) =>
      console.error(`[backfill] ${e}`)
    );
  }
}

const app = createApp({
  db,
  config,
  feishu,
  startPi,
  semaphore,
  bus,
  buffer,
  registry,
  extensions,
  piCwd: ROOT,
  launcher,
  larkHealth,
  writeDeps: {
    runLark: makeRunLark({ profile: config.larkProfile }),
    testTarget: testTargetFromEnv(process.env),
    dbPath,
    writeExtensions: [join(ROOT, "pi-ext", "providers.ts"), join(ROOT, "pi-ext", "lark-execute.ts")],
    piCwd: ROOT,
  },
});

const port = config.port;
app.listen(port, () => {
  console.error(
    `[mstd] listening on :${port} (enableWrite=${config.enableWrite}, enableTrigger=${config.enableTrigger}, maxPi=${config.maxConcurrentPi})`
  );
});

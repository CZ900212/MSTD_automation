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
import { makeRunLark } from "./execute/run-lark.mjs";
import { testTargetFromEnv } from "./execute/write-target.mjs";
import { startPi } from "../supervisor/pi-client.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = loadServerConfig(process.env);
const dbPath = process.env.MSTD_DB_PATH || join(ROOT, "db", "mstd.sqlite");
const db = openDb(dbPath);
migrate(db);

const semaphore = createSemaphore(config.maxConcurrentPi);
const bus = createEventBus();
const buffer = createEventBuffer(db);
buffer.start();
const registry = createRuntimeRegistry();
const feishu = makeFeishuClient(config.feishu);

const app = createApp({
  db,
  config,
  feishu,
  startPi,
  semaphore,
  bus,
  buffer,
  registry,
  extensions: [
    join(ROOT, "pi-ext", "providers.ts"),
    join(ROOT, "pi-ext", "lark.ts"),
  ],
  piCwd: ROOT,
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
  console.error(`[mstd] listening on :${port} (enableWrite=${config.enableWrite}, maxPi=${config.maxConcurrentPi})`);
});

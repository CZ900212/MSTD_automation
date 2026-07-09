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
import { wireGateway } from "./gateway/wire.mjs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createModelCaller } from "./models/caller.mjs";
import { createBudget } from "./models/budget.mjs";
import { createTriage } from "./models/triage.mjs";
import { createBrain } from "./models/brain.mjs";
import { renderReply } from "./models/reply.mjs";
import { createOutbound } from "./gateway/outbound.mjs";
import { createTurnHandler } from "./gateway/turn-handler.mjs";
import { createSessionStore } from "./sessions/store.mjs";
import { createMemoryFiles } from "./memory/files.mjs";
import { createSessionSearch } from "./sessions/search.mjs";
import { createMemoryTool } from "./memory/tool.mjs";
import { buildMemorySnapshot } from "./memory/inject.mjs";
import { createCompactor } from "./memory/compact.mjs";
import { createJournal } from "./memory/journal.mjs";
import { createConfirmFlow } from "./cards/confirm-flow.mjs";
import { createBackgroundJobs } from "./jobs/background.mjs";
import { createReinjector } from "./jobs/reinjector.mjs";
import { createActorPool } from "./sessions/actor.mjs";
import { createTicker } from "./ticker/ticker.mjs";
import { createCronStore } from "./ticker/cron-jobs.mjs";
import { createCronRunner } from "./ticker/cron-runner.mjs";
import { createHeartbeat } from "./ticker/heartbeat.mjs";
import { createDreaming } from "./ticker/dreaming.mjs";
import { createSessionExpiry } from "./ticker/session-expiry.mjs";
import { createProactiveLimiter } from "./gateway/rate-limit.mjs";
import { createObserveReport } from "./gateway/observe-report.mjs";

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
let agentOnActionsReady = null;   // enableAgent 时由 Phase E 装配段赋值（E7 卡片确认链路）
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
  onActionsReady: config.enableAgent ? (args) => agentOnActionsReady?.(args) : null,
});

let larkHealth = null;
if (config.larkProfile && bootLark) {
  larkHealth = startLarkHealth({
    runLark: bootLark,
    alert: makeDmAlert({ runLark: bootLark, openId: config.alertOpenId }),
    // enableAgent 时巡检改挂单 ticker（E6），不再自带 interval
    setIntervalFn: config.enableAgent ? () => ({ unref() {} }) : setInterval,
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

let internal = null;
let adminDeps = null;
if (config.enableAgent && config.botOpenId) {
  const internalToken = process.env.MSTD_INTERNAL_TOKEN || randomUUID();
  const caller = createModelCaller({ env: process.env });
  const agentStore = createSessionStore(db);
  const alert = config.alertOpenId && bootLark ? makeDmAlert({ runLark: bootLark, openId: config.alertOpenId }) : null;
  const budget = createBudget(db, {
    dailyLimit: config.dailyTokenBudget,
    sessionLimit: config.sessionTokenBudget,
    onExceed: (x) => {
      console.error(`[budget] 超限 scope=${x.scope} session=${x.sessionKey}`);
      alert?.(`[mstd-agent] token 预算超限：${x.scope} (${x.sessionKey})`).catch(() => {});
    },
  });
  const memoryFiles = createMemoryFiles({ rootDir: process.env.MSTD_MEMORY_DIR || join(ROOT, "agent-memory") });
  const memoryTool = createMemoryTool({ files: memoryFiles });
  const snapshotFn = ({ sessionKey }) => buildMemorySnapshot({ files: memoryFiles, sessionKey });
  const triage = createTriage({ caller, store: agentStore });
  const brain = createBrain({
    startPi,
    store: agentStore,
    semaphore,
    extensions: [
      join(ROOT, "pi-ext", "providers.ts"),
      join(ROOT, "pi-ext", "reply.ts"),
      join(ROOT, "pi-ext", "memory.ts"),
      join(ROOT, "pi-ext", "session-search.ts"),
      join(ROOT, "pi-ext", "propose-actions.ts"),
      join(ROOT, "pi-ext", "background-job.ts"),
      join(ROOT, "pi-ext", "lark-read.ts"),
    ],
    piCwd: ROOT,
    piEnv: {
      MSTD_INTERNAL_URL: `http://127.0.0.1:${config.port}`,
      MSTD_INTERNAL_TOKEN: internalToken,
    },
  });
  const outbound = createOutbound({ runLark: makeRunLark({ profile: config.larkProfile }) });
  const turnHandler = createTurnHandler({
    triage,
    brain,
    caller,
    renderReply,
    outbound,
    store: agentStore,
    budget,
    snapshotFn,
    compactor: createCompactor({ caller, store: agentStore }),
    journal: createJournal({ caller, files: memoryFiles }),
    limiter: createProactiveLimiter(db),
    db,
    onEvent: (e) => { if (e.type === "triage") console.error(`[agent] triage session=${e.sessionKey} action=${e.verdict.action}`); },
  });
  // ---- Phase D：写路径卡片 + 后台 job + 回注 ----
  const agentActors = createActorPool();
  const reinjector = createReinjector({ store: agentStore, actors: agentActors, brain, outbound });
  const backgroundJobs = createBackgroundJobs({
    db,
    semaphore,
    // 后台 job 执行体：起 job 专属脑回合（新鲜上下文，产出文本结果）
    runJob: async ({ jobId, sessionKey, brief, params }) => {
      const jobSessionKey = `cron:job-${jobId}`;
      const session = agentStore.getOrCreate(jobSessionKey, { kind: "cron", title: brief });
      const r = await brain.turn({
        session, sessionKey: jobSessionKey,
        brief: `【后台任务】${brief}\n参数: ${JSON.stringify(params ?? {})}\n完成后把结果要点作为最终文本输出（不要调用 reply，结果会自动回注发起会话）。`,
        snapshot: snapshotFn({ sessionKey }),
      });
      return r.finalText;
    },
    onComplete: (x) => reinjector.onJobComplete(x),
  });
  const confirmFlow = createConfirmFlow({
    db,
    outbound,
    renderCardCopy: ({ brief }) => renderReply({ caller, soul: "", context: "", brief, kind: "card_copy" }).then((r) => r.text),
    runLark: config.enableWrite ? makeRunLark({ profile: config.larkProfile }) : async () => ({ exitCode: 1, stdout: "", stderr: "MSTD_ENABLE_WRITE 未开" }),
    testTarget: testTargetFromEnv(process.env),
    onExecuted: ({ jobId, sessionKey, resultsMd, ok }) => {
      reinjector.onJobComplete({ jobId, sessionKey, sessionVersion: 0, ok, result: `写操作执行结果：\n${resultsMd}` });
    },
  });
  internal = {
    token: internalToken,
    handleReply: turnHandler.handleReply,
    memoryTool,
    searchTool: createSessionSearch(db),
    spawnBackground: ({ sessionKey, kind, brief, params }) => {
      const session = agentStore.getOrCreate(sessionKey);
      return backgroundJobs.spawn({ sessionKey, sessionVersion: session.version ?? 0, kind, brief, params });
    },
    proposeActions: ({ sessionKey, title, intents }) => {
      const initiator = sessionKey.startsWith("feishu:p2p:") ? sessionKey.split(":")[2] : (config.alertOpenId || config.botOpenId);
      return confirmFlow.startConfirmFlow({ sessionKey, intents, initiatorOpenId: initiator, title });
    },
  };
  wireGateway({
    db,
    config: { ...config, larkCliPath: DEFAULT_LARK_CLI },
    spawnFn: spawn,
    handleTurn: (turn) => {
      console.error(`[agent] turn kind=${turn.kind} session=${turn.sessionKey ?? "-"} mode=${turn.mode ?? "-"} items=${turn.items?.length ?? 0}`);
      if (turn.kind === "card_action") {
        return confirmFlow.handleCardAction(turn.evt.raw ?? turn.evt)
          .then((r) => console.error(`[agent] card_action 处理完成: ${JSON.stringify(r).slice(0, 120)}`))
          .catch((e) => console.error(`[agent] card_action 失败: ${e?.message ?? e}`));
      }
      return turnHandler.handleTurn(turn);
    },
  });
  // ---- Phase E：主动层（单 ticker 多周期）----
  const memoryDir = process.env.MSTD_MEMORY_DIR || join(ROOT, "agent-memory");
  const ticker = createTicker({ intervalMs: 60_000 });
  const cronStore = createCronStore(db);
  const cronRunner = createCronRunner({ brain, agentStore, cronStore, snapshotFn });
  ticker.register("cron", 1, () => cronRunner.runDue());
  const heartbeat = createHeartbeat({ rootDir: memoryDir, caller, brain, agentStore, snapshotFn });
  ticker.register("heartbeat", 5, () => heartbeat.tick());          // 5 分钟一扫（activeHours 内）
  internal.heartbeat = heartbeat;
  const dreaming = createDreaming({ db, files: memoryFiles, caller });
  let lastDreamDay = null;
  ticker.register("dreaming", 1, () => {
    const bj = new Date(Date.now() + 8 * 3600_000);
    const day = bj.toISOString().slice(0, 10);
    if (bj.getUTCHours() === 3 && bj.getUTCMinutes() >= 30 && lastDreamDay !== day) {
      lastDreamDay = day;
      return dreaming.run();
    }
  });
  const expiry = createSessionExpiry({
    db, agentStore, brain, snapshotFn,
    hasActiveJob: (key) => !!db.prepare(
      "SELECT 1 FROM orch_jobs WHERE status IN ('running','queued','running_readonly','awaiting_confirm') AND params_json LIKE ? LIMIT 1"
    ).get(`%${key}%`),
  });
  ticker.register("session-expiry", 10, () => expiry.sweep());
  if (larkHealth) ticker.register("lark-health", 10, () => larkHealth.checkOnce().catch(() => {}));
  // 观察期周报：每周一北京 09:00 DM 管理员
  const observeReport = createObserveReport({ db, outbound, adminOpenId: config.alertOpenId });
  let lastObsWeek = null;
  ticker.register("observe-report", 1, () => {
    const bj = new Date(Date.now() + 8 * 3600_000);
    const week = `${bj.getUTCFullYear()}-w${Math.floor(bj.getTime() / (7 * 86_400_000))}`;
    if (bj.getUTCDay() === 1 && bj.getUTCHours() === 9 && lastObsWeek !== week) {
      lastObsWeek = week;
      return observeReport.sendWeekly();
    }
  });
  ticker.start();
  internal.cronStore = cronStore;
  internal.dreaming = dreaming;

  // E7：妙记等事件源的 job 抽取完成 → 卡片确认（不再产生 awaiting_approval）
  agentOnActionsReady = async ({ job, actions }) => {
    const params = JSON.parse(job.params_json ?? "{}");
    const initiator = params.host_open_id || config.alertOpenId;
    if (!initiator) return console.error(`[agent] job ${job.id} 无确认人（缺 host_open_id/alertOpenId），跳过发卡`);
    await confirmFlow.startConfirmFlowForJob({
      jobId: job.id, actions, initiatorOpenId: initiator, deliverTo: initiator, title: job.title ?? "会议纪要确认",
    });
  };

  // ---- Phase G：调试台管理面 ----
  adminDeps = {
    files: memoryFiles,
    agentStore,
    cronStore,
    dreaming,
    debugTurn: async ({ debugId, text, operator }) => {
      const sessionKey = `debug:${debugId}`;
      const session = agentStore.getOrCreate(sessionKey, { kind: "debug", title: `[debug] ${operator}` });
      await turnHandler.handleTurn({
        kind: "message", session, sessionKey,
        items: [{ content: text, senderOpenId: operator, senderName: "管理员", ts: Date.now() }],
        mode: "addressed",
      });
      return { ok: true, sessionId: session.id };
    },
  };

  console.error(`[mstd] agent gateway on (bot=${config.botOpenId}) + ticker on`);
}

const app = createApp({
  internal,
  admin: adminDeps,
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

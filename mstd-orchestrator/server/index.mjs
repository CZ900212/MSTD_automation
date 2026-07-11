import { existsSync, statSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, migrate } from "./db/index.mjs";
import { buildResidentExtensions } from "./pi/resident-extensions.mjs";
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
import { resolveMinutesInitiator, makeFetchMinutesOwner, createMinutesBroadcast } from "./triggers/minutes-agent.mjs";
import { backfillMinutes } from "./triggers/backfill.mjs";
import { startLarkHealth, makeDmAlert } from "./health/lark-profile.mjs";
import { wireGateway } from "./gateway/wire.mjs";
import { spawn } from "node:child_process";
import { createModelCaller } from "./models/caller.mjs";
import { createBudget } from "./models/budget.mjs";
import { createModelLog } from "./models/model-log.mjs";
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
import { createDebugTurn } from "./sessions/debug-turn.mjs";
import { createTicker } from "./ticker/ticker.mjs";
import { createCronStore } from "./ticker/cron-jobs.mjs";
import { createCronRunner } from "./ticker/cron-runner.mjs";
import { createHeartbeat } from "./ticker/heartbeat.mjs";
import { createHeartbeatStore } from "./ticker/heartbeat-store.mjs";
import { createDeliverGrants } from "./sessions/deliver-grants.mjs";
import { createDreaming } from "./ticker/dreaming.mjs";
import { createSessionExpiry } from "./ticker/session-expiry.mjs";
import { hasActiveJobForSession } from "./store/jobs.mjs";
import { createSessionTokenRegistry } from "./http/session-tokens.mjs";
import { createProactiveLimiter } from "./gateway/rate-limit.mjs";
import { createObserveReport } from "./gateway/observe-report.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// 注意：loadServerConfig 里的 sessionSecret() 缺配时会往 process.env 写临时密钥，先记录原始状态
const hasSessionSecret = Boolean(String(process.env.MSTD_SESSION_SECRET ?? "").trim());
const config = loadServerConfig(process.env);

// H2 启动 fail-fast：缺关键 env 一次性报全清单再退出，不让半残配置上线。
{
  const fatal = [];
  if ((config.enableWrite || config.enableAgent) && !hasSessionSecret) {
    fatal.push("MSTD_ENABLE_WRITE/MSTD_ENABLE_AGENT=1 时必须配置 MSTD_SESSION_SECRET（否则重启丢会话且审批链不可信）");
  }
  if (config.enableAgent) {
    if (!config.botOpenId) fatal.push("MSTD_ENABLE_AGENT=1 时必须配置 MSTD_BOT_OPEN_ID（自回环判定依赖）");
    if (!config.botName) fatal.push("MSTD_ENABLE_AGENT=1 时必须配置 MSTD_BOT_NAME（扁平事件无 mentions，点名判定依赖）");
    if (!config.larkProfile) fatal.push("MSTD_ENABLE_AGENT=1 时必须配置 LARK_PROFILE（收发消息通道）");
    if (!process.env.CZ_GPT_KEY) fatal.push("MSTD_ENABLE_AGENT=1 时必须配置 CZ_GPT_KEY（reason 链主脑）");
    if (!process.env.CZ_CLAUDE_KEY) fatal.push("MSTD_ENABLE_AGENT=1 时必须配置 CZ_CLAUDE_KEY（respond 链出口）");
    if (!process.env.DEEPSEEK_KEY) fatal.push("MSTD_ENABLE_AGENT=1 时必须配置 DEEPSEEK_KEY（fast 链分诊）");
  }
  if (config.enableWrite) {
    const hasTarget = String(process.env.MSTD_TEST_OPEN_IDS ?? "").trim() || String(process.env.MSTD_TEST_CHAT_IDS ?? "").trim();
    if (!hasTarget) fatal.push("MSTD_ENABLE_WRITE=1 时必须配置 MSTD_TEST_OPEN_IDS 或 MSTD_TEST_CHAT_IDS（写目标白名单 fail-closed，空=全拒）");
  }
  if (fatal.length) {
    console.error("[mstd] 致命：启动配置不完整——");
    for (const m of fatal) console.error(`  - ${m}`);
    process.exit(1);
  }
  if (config.enableAgent && config.adminOpenIds.size === 0) {
    console.warn("[mstd] 提醒：未配置 MSTD_ADMIN_OPEN_IDS，web 调试台 /api/admin/* 将全部 403");
  }
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
  // C1:SOUL fail-fast——只 stat 不读(内容由每个 Pi 进程的 persona hook 读一次)
  const soulPath = join(process.env.MSTD_MEMORY_DIR || join(ROOT, "agent-memory"), "SOUL.md");
  if (!existsSync(soulPath) || statSync(soulPath).size === 0) {
    console.error(`[mstd] SOUL.md 缺失或为空(${soulPath}),拒绝以空人格启动 agent`);
    process.exit(1);
  }
  // C1:中枢 bash/文件工具的工作目录迁出源码树(S1 纵深缓解)
  const agentWorkspace = process.env.MSTD_AGENT_WORKSPACE || join(ROOT, "agent-workspace");
  mkdirSync(agentWorkspace, { recursive: true });
  // C0.3：内部通道改会话绑定 token(per-spawn 签发,吊销随 Pi 生命周期),废除静态共享 token
  const sessionTokens = createSessionTokenRegistry();
  const actors = createActorPool();
  const modelLog = createModelLog(db);   // 模型链路可观测：降级/重试/预算命中落库，调试台消费
  const caller = createModelCaller({ env: process.env, onEvent: modelLog.record });
  const agentStore = createSessionStore(db);
  const alert = config.alertOpenId && bootLark ? makeDmAlert({ runLark: bootLark, openId: config.alertOpenId }) : null;
  const budget = createBudget(db, {
    dailyLimit: config.dailyTokenBudget,
    sessionLimit: config.sessionTokenBudget,
    onExceed: (x) => {
      console.error(`[budget] 超限 scope=${x.scope} session=${x.sessionKey}`);
      modelLog.record({ type: "budget_exceeded", sessionKey: x.sessionKey, detail: x.scope });
      alert?.(`[mstd-agent] token 预算超限：${x.scope} (${x.sessionKey})`).catch(() => {});
    },
  });
  const memoryFiles = createMemoryFiles({ rootDir: process.env.MSTD_MEMORY_DIR || join(ROOT, "agent-memory") });
  const memoryTool = createMemoryTool({ files: memoryFiles });
  const snapshotFn = ({ sessionKey }) => buildMemorySnapshot({ files: memoryFiles, sessionKey });
  // 分诊上下文:2048-token 预算窗口(末条不截断),自然参与判定的依据
  const triage = createTriage({ caller, store: agentStore, windowTokens: Number(process.env.MSTD_TRIAGE_WINDOW_TOKENS ?? 2048) });
  const brain = createBrain({
    startPi,
    store: agentStore,
    semaphore,
    // 闲置 Pi 占并发位直到回收；默认 10min，E2E/低并发环境可调小避免饿死后续会话
    idleMs: Number(process.env.MSTD_PI_IDLE_MS ?? 600_000),
    // 回合超时后沿 reason 链降级重跑；provider 挂起型故障的止损上限
    turnTimeoutMs: Number(process.env.MSTD_TURN_TIMEOUT_MS ?? 240_000),
    extensions: buildResidentExtensions(ROOT),   // C1:production source of truth,persona 第一
    piCwd: agentWorkspace,                       // C1:bash/文件工具迁出源码树
    piEnv: {
      MSTD_INTERNAL_URL: `http://127.0.0.1:${config.port}`,
      MSTD_SOUL_PATH: soulPath,                  // persona hook 每 Pi 进程读一次
    },
    onEvent: modelLog.record,
    tokens: sessionTokens,
  });
  const outbound = createOutbound({ runLark: makeRunLark({ profile: config.larkProfile }), onEvent: modelLog.record });
  // C0.4：reply.target 投递授权表（默认只许本会话;cron 执行窗口临时 grant）
  const deliverGrants = createDeliverGrants();
  const turnHandler = createTurnHandler({
    triage,
    brain,
    caller,
    renderReply,
    outbound,
    store: agentStore,
    budget,
    grants: deliverGrants,
    snapshotFn,
    compactor: createCompactor({ caller, store: agentStore }),
    journal: createJournal({ caller, files: memoryFiles }),
    limiter: createProactiveLimiter(db),
    db,
    onEvent: (e) => { if (e.type === "triage") console.error(`[agent] triage session=${e.sessionKey} action=${e.verdict.action}`); },
  });
  // ---- Phase D：写路径卡片 + 后台 job + 回注 ----
  const reinjector = createReinjector({ store: agentStore, actors, brain, outbound });
  // 迭代二 T2.1：妙记派发执行完 → 指定群播报（未配置 MSTD_MINUTES_BROADCAST_CHAT 则静默跳过）
  const minutesBroadcast = createMinutesBroadcast({
    db,
    handleReply: (args) => turnHandler.handleReply(args),
    chatKey: config.minutesBroadcastChat ? `feishu:group:${config.minutesBroadcastChat}` : "",
  });
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
  // C0.4：heartbeat 改 owner-bound 结构化队列——DB due picker 逐项受信直投,
  // 遗留 HEARTBEAT.md 启动即整文件隔离,不再作为活跃数据源。
  // Task 4B：同一 store 也是 confirmFlow 的 schedule_reminder 已确认写 adapter。
  const heartbeatStore = createHeartbeatStore(db);
  heartbeatStore.releaseStale();   // 进程崩溃遗留的超时 delivering claim 放回 pending
  const confirmFlow = createConfirmFlow({
    db,
    outbound,
    renderCardCopy: ({ brief }) => renderReply({ caller, soul: "", context: "", brief, kind: "card_copy" }).then((r) => r.text),
    runLark: config.enableWrite ? makeRunLark({ profile: config.larkProfile }) : async () => ({ exitCode: 1, stdout: "", stderr: "MSTD_ENABLE_WRITE 未开" }),
    testTarget: testTargetFromEnv(process.env),
    heartbeat: heartbeatStore,
    onExecuted: ({ jobId, sessionKey, resultsMd, ok }) => {
      reinjector.onJobComplete({ jobId, sessionKey, sessionVersion: 0, ok, result: `写操作执行结果：\n${resultsMd}` });
      minutesBroadcast.onJobExecuted({ jobId, ok, resultsMd });   // 自含错误处理，fire-and-forget
    },
  });
  internal = {
    tokens: sessionTokens,
    modelLog,
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
    actors,
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
  // E2E 提速旋钮（默认即生产值）：tick 间隔 / 心跳频率与活跃时段
  const ticker = createTicker({ intervalMs: Number(process.env.MSTD_TICKER_INTERVAL_MS ?? 60_000) });
  const cronStore = createCronStore(db);
  const cronRunner = createCronRunner({ brain, agentStore, cronStore, grants: deliverGrants, snapshotFn });
  ticker.register("cron", 1, () => cronRunner.runDue());
  const heartbeat = createHeartbeat({
    store: heartbeatStore,
    deliverReminder: async ({ deliverTo, text, idempotencyKey }) => {
      const r = await turnHandler.deliverTrusted({ deliverKey: deliverTo, text, idempotencyKey });
      if (!r.ok) throw new Error(r.error);      // 软失败也进退避重试,不误标 delivered
      return r;
    },
    legacyPath: join(memoryDir, "HEARTBEAT.md"),
  });
  ticker.register("heartbeat", Number(process.env.MSTD_HEARTBEAT_EVERY_TICKS ?? 5), () => heartbeat.tick()); // 默认 5 分钟一扫
  internal.heartbeat = heartbeatStore;
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
    db, agentStore, actors, brain, snapshotFn,
    hasActiveJob: (key) => hasActiveJobForSession(db, key),
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
    // 迭代二 T2.2：host_open_id → 妙记 owner 反查 → alertOpenId 三级兜底
    const initiator = await resolveMinutesInitiator({
      params,
      fetchOwner: bootLark ? makeFetchMinutesOwner({ runLark: bootLark }) : null,
      alertOpenId: config.alertOpenId,
    });
    if (!initiator) return console.error(`[agent] job ${job.id} 无确认人（host_open_id/owner 反查/alertOpenId 全空），跳过发卡`);
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
    debugTurn: createDebugTurn({ actors, agentStore, handleTurn: turnHandler.handleTurn }),
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
});

const port = config.port;
app.listen(port, () => {
  console.error(
    `[mstd] listening on :${port} (enableWrite=${config.enableWrite}, enableTrigger=${config.enableTrigger}, maxPi=${config.maxConcurrentPi})`
  );
});

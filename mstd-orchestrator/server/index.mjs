import { existsSync, statSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, migrate } from "./db/index.mjs";
import { buildCapabilityProfile } from "./pi/resident-extensions.mjs";
import { assertCapabilityReadiness } from "./pi/capability-readiness.mjs";
import { loadServerConfig, intEnv } from "./config.mjs";
import { createApp } from "./app.mjs";
import { createSemaphore } from "./jobs/semaphore.mjs";
import { createEventBus } from "./jobs/event-bus.mjs";
import { createEventBuffer } from "./jobs/event-buffer.mjs";
import { sweepExpiredExports } from "./execute/job-workdir.mjs";
import { createRuntimeRegistry } from "./jobs/runtime.mjs";
import { makeFeishuClient } from "./auth/feishu-client.mjs";
import { makeRunLark, DEFAULT_LARK_CLI } from "./execute/run-lark.mjs";
import { testTargetFromEnv } from "./execute/write-target.mjs";
import { startPi } from "../supervisor/pi-client.mjs";
import { reconcileOnBoot } from "./execute/reconcile-startup.mjs";
import { createJobLauncher } from "./jobs/launcher.mjs";
import { startMinutesConsumer } from "./triggers/minutes-consumer.mjs";
import { resolveMinutesInitiator, makeFetchMinutesOwner, createMinutesBroadcast } from "./triggers/minutes-agent.mjs";
import { createTokenWatch } from "./ticker/token-watch.mjs";
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
import { createResponder } from "./models/responder.mjs";
import { createDispatcher } from "./models/dispatcher.mjs";
import { createReasoningTaskStore } from "./reasoning/task-store.mjs";
import { createReasoningRunStore } from "./reasoning/run-store.mjs";
import { createReasoningCoordinator } from "./reasoning/coordinator.mjs";
import { createTaskContextProvider } from "./reasoning/task-context.mjs";
import { createOutbound } from "./gateway/outbound.mjs";
import { createTurnHandler } from "./gateway/turn-handler.mjs";
import { createReplyPipeline } from "./gateway/reply-pipeline.mjs";
import { createSessionStore } from "./sessions/store.mjs";
import { createMemoryFiles } from "./memory/files.mjs";
import { createSessionSearch } from "./sessions/search.mjs";
import { createMemoryTool } from "./memory/tool.mjs";
import { buildMemorySnapshot } from "./memory/inject.mjs";
import { createCompactor } from "./memory/compact.mjs";
import { createJournal } from "./memory/journal.mjs";
import { createConfirmFlow } from "./cards/confirm-flow.mjs";
import { createBackgroundJobs } from "./jobs/background.mjs";
import { createBackgroundExecutor } from "./jobs/background-executor.mjs";
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
import { createActiveTurnRegistry } from "./sessions/active-turn.mjs";
import { createHmac } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import { createContextBudget } from "./safety/context-budget.mjs";
import { createReplyProvenanceRegistry, assertSafeCardCopy } from "./safety/reply-egress.mjs";
import { createVerbatimGuard } from "./safety/verbatim-guard.mjs";
import { createInternalDisclosureScanner } from "./safety/internal-disclosure.mjs";
import { createLarkReadEgressSource } from "./safety/lark-read-egress-source.mjs";
import { createProactiveLimiter } from "./gateway/rate-limit.mjs";
import { createObserveReport } from "./gateway/observe-report.mjs";
import { createTurnTrace } from "./gateway/turn-trace.mjs";
import { loadSimulatorConfig } from "./simulator/config.mjs";

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
    if (!process.env.CZ_GPT_KEY) fatal.push("MSTD_ENABLE_AGENT=1 时必须配置 CZ_GPT_KEY（reason 链兜底）");
    if (!process.env.DEEPSEEK_KEY) fatal.push("MSTD_ENABLE_AGENT=1 时必须配置 DEEPSEEK_KEY（fast 链分诊）");
  }
  if (config.enableWrite) {
    const hasTarget = String(process.env.MSTD_TEST_OPEN_IDS ?? "").trim()
      || String(process.env.MSTD_TEST_CHAT_IDS ?? "").trim()
      || String(process.env.MSTD_TEST_TASK_GUIDS ?? "").trim()
      || String(process.env.MSTD_TEST_DOC_TOKENS ?? "").trim();
    if (!hasTarget) fatal.push("MSTD_ENABLE_WRITE=1 时必须配置 MSTD_TEST_OPEN_IDS、MSTD_TEST_CHAT_IDS、MSTD_TEST_TASK_GUIDS 或 MSTD_TEST_DOC_TOKENS（写目标白名单 fail-closed，空=全拒）");
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

// 一键启动安全预检：端口被占是已有 daemon 的强信号。必须在任何 event consumer
// 拉起之前退出——否则第二条飞书长连接会负载均衡抢事件（「进程所有权」红线），
// 而 app.listen 的 EADDRINUSE 要到装配尾声才触发，抢事件窗口已经打开。
try {
  await new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", (e) => reject(e?.code === "EADDRINUSE"
      ? new Error(`端口 ${config.port} 已被占用——疑似已有 daemon/event consumer 在跑，拒绝启动第二实例（不代杀，请先自查 PID）`)
      : e));
    probe.once("listening", () => probe.close(resolve));
    probe.listen(config.port);
  });
} catch (e) {
  console.error(`[mstd] 致命：${e?.message ?? e}`);
  process.exit(1);
}

// Capability readiness fail-fast（批次 A 验收条款）：起任何 Pi 之前，用生产同一
// binary/参数对三个 role 探针一次，工具集合与 profile 漂移即拒绝启动。
// 探针无业务凭据（SOUL 用空桩）；E2E 提速可用 MSTD_SKIP_CAPABILITY_READINESS=1 跳过。
if ((config.enableAgent || config.enableTrigger) && process.env.MSTD_SKIP_CAPABILITY_READINESS !== "1") {
  try {
    const readiness = await assertCapabilityReadiness({ root: ROOT });
    console.error(`[mstd] capability readiness: ${readiness.roles.map((r) => `${r.role}=${r.activeTools.length}`).join(" ")}`);
  } catch (e) {
    console.error(`[mstd] 致命：capability readiness 失败——${e?.message ?? e}`);
    process.exit(1);
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

const readonlyJobProfile = buildCapabilityProfile(ROOT, "readonly_job");
let agentOnActionsReady = null;   // enableAgent 时由 Phase E 装配段赋值（E7 卡片确认链路）
const launcher = createJobLauncher({
  db,
  config,
  startPi,
  semaphore,
  bus,
  buffer,
  registry,
  capabilityProfile: readonlyJobProfile,
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
let gatewayHandle = null;
let simulatorConfigForApp = null;
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
  const internalDisclosure = createInternalDisclosureScanner({
    knownStrings: [agentWorkspace, ROOT, `127.0.0.1:${config.port}`, `localhost:${config.port}`],
  });
  // C0.3：内部通道改会话绑定 token(per-spawn 签发,吊销随 Pi 生命周期),废除静态共享 token
  const sessionTokens = createSessionTokenRegistry();
  const replyEgress = createReplyProvenanceRegistry();
  // 批次 C：逐字引用守卫。lark_read 每次成功读取经 /internal/egress/source 登记 shingle；
  // 席位私有 op 同时给本 epoch 打 taint（业务回合收口后 turn-handler 回收 resident）。
  const verbatimGuard = createVerbatimGuard();
  // 统一回合注册表：receipt/brain/initiator 三域同一条 per-session 记录、receipt+brain 共享
  // 一把回合 lease，任一域清空即整条回收——消灭"跨模块漏清一份留陈旧状态"这类错误。
  const turnLeaseTtlMs = intEnv(process.env, "MSTD_TURN_TIMEOUT_MS", 240_000) + 30_000;
  const activeTurnRegistry = createActiveTurnRegistry({
    brainTtlMs: turnLeaseTtlMs,
    initiatorTtlMs: turnLeaseTtlMs,
  });
  const activeTurns = activeTurnRegistry.receipts;
  const activeBrainTurns = activeTurnRegistry.brainTurns;
  const activeTurnInitiators = activeTurnRegistry.initiators;
  const actors = createActorPool();
  const modelLog = createModelLog(db);   // 模型链路可观测：降级/重试/预算命中落库，调试台消费
  const turnTrace = createTurnTrace(db, {
    pipeline: config.agentArchitectureMode === "legacy" ? "legacy" : "responder",
  });
  // 统一事件 sink：任一 sink 抛错不得影响另一个，也不得打断业务链路
  const observeAgentEvent = (event) => {
    try { modelLog.record(event); } catch (e) {
      console.error(`[mstd] modelLog.record failed: ${e?.message ?? e}`);
    }
    try { turnTrace.record(event); } catch (e) {
      console.error(`[mstd] turnTrace.record failed: ${e?.message ?? e}`);
    }
  };
  const caller = createModelCaller({ env: process.env, onEvent: observeAgentEvent });
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
  const contextBudget = createContextBudget({ maxBytes: config.contextBudgetBytes });
  // Context envelopes are server-issued capability metadata. Reuse the mandatory
  // persistent session secret with domain separation; never expose this signer to Pi.
  const contextSigner = (payload) => createHmac("sha256", config.sessionSecret)
    .update("mstd-context-envelope-v1\0", "utf8")
    .update(payload, "utf8")
    .digest("hex");
  const memoryFiles = createMemoryFiles({ rootDir: process.env.MSTD_MEMORY_DIR || join(ROOT, "agent-memory") });
  const memoryTool = createMemoryTool({ files: memoryFiles });
  const snapshotFn = ({ sessionKey }) => buildMemorySnapshot({ files: memoryFiles, sessionKey });
  // 分诊上下文:2048-token 预算窗口(末条不截断),自然参与判定的依据
  const triage = createTriage({ caller, store: agentStore, windowTokens: intEnv(process.env, "MSTD_TRIAGE_WINDOW_TOKENS", 2048) });
  // Always-available responder (Task 2): sole public voice for first reply + handoff rendering.
  // Wired for shadow/active modes; legacy path continues to use triage + renderReply adapter.
  const responder = createResponder({ caller, onEvent: observeAgentEvent });
  const taskStore = createReasoningTaskStore(db);
  const runStore = createReasoningRunStore(db);
  const dispatcher = createDispatcher({
    caller,
    onEvent: modelLog.record,
    contextLines: config.dispatchContextLines,
    contextBytes: config.dispatchContextBytes,
  });
  const taskContextProvider = createTaskContextProvider({
    taskStore,
    snapshotFn: ({ sessionKey }) => buildMemorySnapshot({ files: memoryFiles, sessionKey }),
  });
  const brain = createBrain({
    startPi,
    store: agentStore,
    semaphore,
    // 闲置 Pi 占并发位直到回收；默认 10min，E2E/低并发环境可调小避免饿死后续会话
    idleMs: intEnv(process.env, "MSTD_PI_IDLE_MS", 600_000),
    // 回合超时后沿 reason 链降级重跑；provider 挂起型故障的止损上限
    turnTimeoutMs: intEnv(process.env, "MSTD_TURN_TIMEOUT_MS", 240_000),
    capabilityProfile: buildCapabilityProfile(ROOT, "resident"),
    piCwd: agentWorkspace,                       // C1:bash/文件工具迁出源码树
    piEnv: {
      MSTD_INTERNAL_URL: `http://127.0.0.1:${config.port}`,
      MSTD_SOUL_PATH: soulPath,                  // persona hook 每 Pi 进程读一次
      // lark_read 会话域门禁：席位私有 op（邮件/妙记）只对独立配置的数据 owner 私聊放行
      ...(config.privateDataOwnerOpenId ? { MSTD_PRIVATE_DATA_OWNER_OPEN_ID: config.privateDataOwnerOpenId } : {}),
    },
    onEvent: observeAgentEvent,
    tokens: sessionTokens,
    activeTurnInitiators,
    activeBrainTurns,
    replyEgress,
    contextBudget,
    contextMode: config.contextEnvelopeMode,
    contextSigner,
    taskContextProvider,
  });
  const outbound = createOutbound({ runLark: makeRunLark({ profile: config.larkProfile }), onEvent: observeAgentEvent });
  // C0.4：reply.target 投递授权表（默认只许本会话;cron 执行窗口临时 grant）
  const deliverGrants = createDeliverGrants();
  // 5d：先建出站流水线（渲染→egress→唯一物理出口），再建入站回合执行器
  const replyPipeline = createReplyPipeline({
    outbound,
    store: agentStore,
    budget,
    renderReply,
    caller,
    snapshotFn,
    grants: deliverGrants,
    replyEgress,
    verbatimGuard,
    internalDisclosure,
    activeBrainTurns,
    onEvent: observeAgentEvent,
  });
  const coordinator = createReasoningCoordinator({
    taskStore,
    runStore,
    dispatcher,
    caller,
    brain,
    store: agentStore,
    snapshotFn: ({ sessionKey }) => buildMemorySnapshot({ files: memoryFiles, sessionKey }),
    activeBrainTurns,
    activeTurnInitiators,
    replyEgress,
    responder,
    deliverTerminal: replyPipeline.deliverTerminal,
    deliverText: replyPipeline.deliverText,
    onEvent: modelLog.record,
    maxReasonersPerSession: config.maxReasonersPerSession,
    contextLines: config.dispatchContextLines,
    contextBytes: config.dispatchContextBytes,
  });
  // A process may die after physical delivery but before the assistant row/dispatch state
  // commits. Retry with the durable idempotency key, then let the normal review pump claim it.
  const sessionById = (sessionId) => db.prepare("SELECT * FROM agent_sessions WHERE id = ?").get(sessionId);
  for (const row of taskStore.listRetryableSends()) {
    const session = sessionById(row.session_id);
    if (!session) continue;
    try {
      await coordinator.retryPendingSend({
        dispatchId: row.id,
        session,
        sessionKey: session.session_key,
      });
    } catch (error) {
      console.error(`[mstd] pending_send recovery failed dispatch=${row.id}: ${error?.message ?? error}`);
    }
  }
  // Release stale dispatcher claims, then recover durable runs before admitting new reviews.
  const pendingReviews = coordinator.resumePending();
  await coordinator.recoverRuns({
    resolveSession: sessionById,
  });
  for (const row of pendingReviews) {
    const session = sessionById(row.session_id);
    if (!session) continue;
    coordinator.schedule({
      dispatchId: row.id,
      session,
      sessionKey: session.session_key,
      items: [],
      mode: row.mode,
    });
  }
  const turnHandler = createTurnHandler({
    triage,
    brain,
    outbound,
    store: agentStore,
    budget,
    replyEgress,
    activeTurns,
    activeBrainTurns,
    replyPipeline,
    architectureMode: config.agentArchitectureMode,
    responder,
    dispatcher,
    taskStore,
    coordinator,
    snapshotFn,
    compactor: createCompactor({ caller, store: agentStore }),
    journal: createJournal({ caller, files: memoryFiles }),
    limiter: createProactiveLimiter(db),
    db,
    onEvent: (e) => {
      observeAgentEvent(e);
      if (e.type === "triage") {
        console.error(`[agent] triage session=${e.sessionKey} action=${e.action} source=${e.sourceAction} provider=${e.provider} guard=${e.guard ?? "none"} latency_ms=${e.latencyMs}`);
      }
      if (e.type === "responder_sent") {
        console.error(`[agent] responder session=${e.sessionKey} action=${e.action} dispatch=${e.dispatchId ?? "-"}`);
      }
    },
  });
  // ---- Phase D：写路径卡片 + 后台 job + 回注 ----
  // 系统维护回合的 brief 必须沿用 persona 豁免触发词：不要调用 reply。
  const reinjector = createReinjector({
    store: agentStore,
    actors,
    brain,
    contextSigner,
    contextBudget,
    coordinator,
  });
  // 迭代二 T2.1：妙记派发执行完 → 指定群播报（未配置 MSTD_MINUTES_BROADCAST_CHAT 则静默跳过）
  const minutesBroadcast = createMinutesBroadcast({
    db,
    renderAutomationReply: (args) => turnHandler.renderAutomationReply(args),
    chatKey: config.minutesBroadcastChat ? `feishu:group:${config.minutesBroadcastChat}` : "",
  });
  const backgroundJobs = createBackgroundJobs({
    db,
    semaphore,
    runJob: createBackgroundExecutor({
      startPi,
      config,
      agentWorkspace,
      capabilityProfile: buildCapabilityProfile(ROOT, "background"),
      timeoutMs: intEnv(process.env, "MSTD_BACKGROUND_TIMEOUT_MS", 240_000),
    }),
    onEvent: observeAgentEvent,
    onComplete: (x) => reinjector.onJobComplete(x),
  });
  // 崩溃遗留的裸 'running' 后台 job：收口 + onJobComplete({ok:false}) 闭环给用户，
  // 否则 owner 会话永久豁免归档、委托承诺静默失踪。
  const bgRecovered = backgroundJobs.recoverOnBoot();
  if (bgRecovered.recovered > 0) console.error(`[mstd] background job boot recovery: ${JSON.stringify(bgRecovered)}`);
  // C0.4：heartbeat 改 owner-bound 结构化队列——DB due picker 逐项受信直投,
  // 遗留 HEARTBEAT.md 启动即整文件隔离,不再作为活跃数据源。
  // Task 4B：同一 store 也是 confirmFlow 的 schedule_reminder 已确认写 adapter。
  const heartbeatStore = createHeartbeatStore(db);
  heartbeatStore.releaseStale();   // 进程崩溃遗留的超时 delivering claim 放回 pending
  const confirmFlow = createConfirmFlow({
    db,
    outbound,
    renderCardCopy: async ({ brief }) => {
      const { text } = await renderReply({ caller, soul: "", context: "", brief, kind: "card_copy" });
      return assertSafeCardCopy(text, {
        internalDisclosure,
        onAudit: ({ phase, matches }) => observeAgentEvent({
          type: "internal_disclosure_audit",
          phase,
          detail: matches.join(","),
        }),
      });
    },
    runLark: config.enableWrite ? makeRunLark({ profile: config.larkProfile }) : async () => ({ exitCode: 1, stdout: "", stderr: "MSTD_ENABLE_WRITE 未开" }),
    testTarget: testTargetFromEnv(process.env),
    heartbeat: heartbeatStore,
    onExecuted: ({ jobId, sessionKey, sessionVersion, taskId, originRunId, dispatchId, resultsMd, ok }) => {
      reinjector.onJobComplete({
        jobId,
        sessionKey,
        sessionVersion,
        taskId,
        originRunId,
        dispatchId,
        ok,
        result: `写操作执行结果：\n${resultsMd}`,
      });
      minutesBroadcast.onJobExecuted({ jobId, ok, resultsMd });   // 自含错误处理，fire-and-forget
    },
  });
  // boot reconcile 已先修复 action/job；此时 outbound/回注依赖齐备，再收口遗留 executing 卡片。
  await confirmFlow.recoverFinalizedExecutingCards();
  internal = {
    tokens: sessionTokens,
    activeTurnInitiators,
    activeBrainTurns,
    replyEgress,
    modelLog,
    handleReply: turnHandler.handleReply,
    memoryTool,
    searchTool: createSessionSearch(db),
    sessionVersionFor: (sessionKey) => agentStore.getOrCreate(sessionKey).version ?? 0,
    spawnBackground: ({ sessionKey, sessionVersion, taskId, originRunId, dispatchId, kind, brief, params }) =>
      backgroundJobs.spawn({
        sessionKey,
        sessionVersion,
        taskId,
        originRunId,
        dispatchId,
        kind,
        brief,
        params,
      }),
    proposeActions: ({ sessionKey, sessionVersion, taskId, originRunId, dispatchId, initiatorOpenId, title, intents }) =>
      confirmFlow.startConfirmFlow({
        sessionKey,
        sessionVersion,
        taskId,
        originRunId,
        dispatchId,
        intents,
        initiatorOpenId,
        title,
      }),
    egressSource: createLarkReadEgressSource({
      verbatimGuard,
      replyEgress,
      onEvent: observeAgentEvent,
    }),
  };
  try {
    simulatorConfigForApp = loadSimulatorConfig(process.env, config);
  } catch (e) {
    console.error(`[mstd] 致命：simulator 配置非法——${e?.message ?? e}`);
    process.exit(1);
  }
  gatewayHandle = wireGateway({
    db,
    config: { ...config, larkCliPath: DEFAULT_LARK_CLI, simulator: simulatorConfigForApp },
    spawnFn: spawn,
    actors,
    turnTrace,
    simulator: simulatorConfigForApp,
    handleTurn: (turn) => {
      console.error(`[agent] turn kind=${turn.kind} session=${turn.sessionKey ?? "-"} mode=${turn.mode ?? "-"} items=${turn.items?.length ?? 0}`);
      if (turn.kind === "card_action") {
        console.error(`[agent] card_action evt: ${JSON.stringify(turn.evt.raw ?? turn.evt).slice(0, 600)}`);
        return confirmFlow.handleCardAction(turn.evt.raw ?? turn.evt)
          .then((r) => console.error(`[agent] card_action 处理完成: ${JSON.stringify(r).slice(0, 120)}`))
          .catch((e) => console.error(`[agent] card_action 失败: ${e?.message ?? e}`));
      }
      return turnHandler.handleTurn(turn);
    },
  });
  // 入站 at-most-once 收口：回放上一进程 ack 后死在 debounce 窗口内的消息
  gatewayHandle.replayUnhandled();
  // ---- Phase E：主动层（单 ticker 多周期）----
  const memoryDir = process.env.MSTD_MEMORY_DIR || join(ROOT, "agent-memory");
  // E2E 提速旋钮（默认即生产值）：tick 间隔 / 心跳频率与活跃时段
  const ticker = createTicker({ intervalMs: intEnv(process.env, "MSTD_TICKER_INTERVAL_MS", 60_000) });
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
  ticker.register("heartbeat", intEnv(process.env, "MSTD_HEARTBEAT_EVERY_TICKS", 5), () => heartbeat.tick()); // 默认 5 分钟一扫
  internal.heartbeat = heartbeatStore;
  const dreaming = createDreaming({
    db,
    files: memoryFiles,
    caller,
    mode: config.dreamingMode,
    // createDreaming fail-closes apply outside tests; keep model_log informed for production review.
    onEvent: modelLog.record,
  });
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
    onArchived: (sessionKey) => verbatimGuard.clear(sessionKey),
  });
  ticker.register("session-expiry", 10, () => expiry.sweep());
  // job out/<jobId> 产物按 mtime TTL 收割（默认 7 天）；比照 session-expiry 低频扫。
  const jobExportsDir = join(ROOT, "out");
  const jobExportTtlMs = intEnv(process.env, "MSTD_JOB_EXPORT_TTL_MS", 7 * 24 * 3600_000);
  ticker.register("job-exports-sweep", 10, () => {
    try { sweepExpiredExports(jobExportsDir, jobExportTtlMs); }
    catch (e) { console.error(`[job-exports-sweep] ${e?.message ?? e}`); }
  });
  if (larkHealth) ticker.register("lark-health", 10, () => larkHealth.checkOnce().catch(() => {}));
  // T1.3 token 续期哨兵：6h 一查（本地读零网络）,refresh 剩 <48h 私聊 owner
  if (bootLark) {
    const tokenWatch = createTokenWatch({ runLark: bootLark, alert });
    ticker.register("token-watch", 360, () => tokenWatch.checkOnce());
    tokenWatch.checkOnce().catch(() => {});
  }
  // 观察期周报：每周一北京 09:00 DM 管理员
  const observeReport = createObserveReport({
    db,
    deliverSystemText: replyPipeline.deliverSystemText,
    adminOpenId: config.alertOpenId,
  });
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
    // params_json 单行损坏降级为空参数（initiator 走 owner 反查/alertOpenId 兜底），不炸整个回调链
    let params = {};
    try { params = JSON.parse(job.params_json ?? "{}"); } catch (e) {
      console.error(`[agent] job ${job.id} params_json 损坏,按空参数继续: ${e?.message ?? e}`);
    }
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
    modelLog,
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
  capabilityProfile: readonlyJobProfile,
  piCwd: ROOT,
  launcher,
  larkHealth,
  simulator: simulatorConfigForApp,
  simulatorTraceEnabled: Boolean(gatewayHandle),
  ingestNormalized: gatewayHandle?.ingestNormalized ?? null,
});

const port = config.port;
app.listen(port, () => {
  console.error(
    `[mstd] listening on :${port} (enableWrite=${config.enableWrite}, enableTrigger=${config.enableTrigger}, maxPi=${config.maxConcurrentPi})`
  );
});

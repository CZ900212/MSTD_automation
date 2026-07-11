// H3 全链路 E2E 回归剧本（MSTD_E2E=1 + MSTD_ENABLE_WRITE=1 才跑；test org 真机，已获授权）。
// 串联：①私聊问答(B7) → ②群旁听沉默+③群@必答(F6) → ④卡片确认真写(D8) → ⑤cron 投递(E) → ⑥HEARTBEAT 提醒(E) → ⑦dreaming 影子报告(C/E)。
// 提速：MSTD_TICKER_INTERVAL_MS=15s + 心跳每 tick 全时段（生产默认 60s/5tick/9-21点 不受影响）。
import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, mkdirSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { openDb, migrate } from "../server/db/index.mjs";
import { makeRunLark } from "../server/execute/run-lark.mjs";
import { createOutbound } from "../server/gateway/outbound.mjs";
import { createConfirmFlow } from "../server/cards/confirm-flow.mjs";
import { testTargetFromEnv } from "../server/execute/write-target.mjs";
import { createModelCaller } from "../server/models/caller.mjs";
import { createMemoryFiles } from "../server/memory/files.mjs";
import { createDreaming } from "../server/ticker/dreaming.mjs";
import { createCronStore } from "../server/ticker/cron-jobs.mjs";
import { createHeartbeatStore } from "../server/ticker/heartbeat-store.mjs";

const RUN = String(process.env.MSTD_E2E ?? "") === "1" && String(process.env.MSTD_ENABLE_WRITE ?? "") === "1";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const P2P_CHAT = process.env.MSTD_E2E_P2P_CHAT ?? "oc_11b72bc3d3bdedff7c86f3c4c61560fc";
const GROUP = process.env.MSTD_E2E_GROUP ?? "oc_b67c4510743e68be6a9a91f3906e7f97";
const BOT_OPEN_ID = process.env.MSTD_BOT_OPEN_ID ?? "ou_4c796176fd4ba145e5e5262d6cda77cc";
const INITIATOR = process.env.MSTD_E2E_INITIATOR ?? "ou_aca75bd11914b20bda06e2462a569593";
const DB_PATH = join(ROOT, "db", "e2e-full.sqlite");
const MEMORY_DIR = join(ROOT, "db", "e2e-full-memory");
const PORT = 8793;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!RUN)("H3 全链路 E2E 回归剧本", () => {
  let daemon = null;
  const logs = [];
  const runLark = makeRunLark({ profile: process.env.LARK_PROFILE });

  afterAll(() => { daemon?.kill("SIGTERM"); });

  async function send(chatId, text, key) {
    const r = await runLark(["im", "+messages-send", "--as", "user", "--chat-id", chatId, "--text", text, "--idempotency-key", key, "--json"]);
    expect(JSON.parse(r.stdout).ok, r.stdout).toBe(true);
  }

  async function botMessagesSince(chatId, sinceMs) {
    const r = await runLark(["im", "+chat-messages-list", "--as", "bot", "--chat-id", chatId, "--start", new Date(sinceMs).toISOString(), "--json"]);
    try {
      const data = JSON.parse(r.stdout);
      const items = data?.data?.items ?? data?.data?.messages ?? [];
      return items.filter((m) => m?.sender?.sender_type === "app" || m?.sender?.id_type === "app_id");
    } catch { return []; }
  }

  async function waitBotReply(chatId, sinceMs, timeoutMs = 150_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const got = await botMessagesSince(chatId, sinceMs);
      if (got.length) return got;
      await sleep(6000);
    }
    return [];
  }

  it("七段剧本：私聊→群旁听/群@→卡片写→cron→heartbeat→dreaming 影子", async () => {
    // ---------- 起 daemon（新鲜 DB + 隔离记忆目录 + 提速旋钮） ----------
    rmSync(DB_PATH, { force: true });
    rmSync(MEMORY_DIR, { recursive: true, force: true });
    mkdirSync(MEMORY_DIR, { recursive: true });
    // 人格拷贝：SOUL 决定「小达」口吻；无则回合仍可跑，但为贴近生产带上
    const soulSrc = join(ROOT, "agent-memory", "SOUL.md");
    if (existsSync(soulSrc)) appendFileSync(join(MEMORY_DIR, "SOUL.md"), readFileSync(soulSrc, "utf8"));

    daemon = spawn("node", [join(ROOT, "server", "index.mjs")], {
      cwd: ROOT,
      env: {
        ...process.env,
        MSTD_ENABLE_AGENT: "1", PORT: String(PORT), MSTD_DB_PATH: DB_PATH, MSTD_MEMORY_DIR: MEMORY_DIR,
        MSTD_TICKER_INTERVAL_MS: "15000", MSTD_HEARTBEAT_EVERY_TICKS: "1",
        // 剧本会先后攒下 p2p/群/cron 最多三个闲置 Pi（闲置也占并发位，默认 10min 才回收，
        // 且 maxPi 上限钳到 3）——heartbeat 的下一个 Pi 会被饿死。E2E 调小闲置回收窗即可。
        MSTD_MAX_CONCURRENT_PI: "3", MSTD_PI_IDLE_MS: "40000",
        // 回合 60s 没回来就沿 reason 链降级重跑（waitBotReply 150s 窗口内容得下两跳）
        MSTD_TURN_TIMEOUT_MS: "60000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    daemon.stdout.on("data", (d) => logs.push(String(d)));
    daemon.stderr.on("data", (d) => logs.push(String(d)));
    const bootDeadline = Date.now() + 20_000;
    while (Date.now() < bootDeadline && !logs.join("").includes("ticker on")) await sleep(500);
    expect(logs.join(""), "daemon 未就绪").toContain("ticker on");
    await sleep(3000);
    const db = openDb(DB_PATH);

    // ---------- ① 私聊问答（B7） ----------
    const t1 = Date.now();
    await send(P2P_CHAT, "你好，一句话介绍你自己", `e2e-full-1-${t1}`);
    const r1 = await waitBotReply(P2P_CHAT, t1 - 1000);
    expect(r1.length, `私聊未回复。日志：${logs.join("").slice(-2000)}`).toBeGreaterThan(0);
    expect(logs.join("")).toContain("[agent] turn kind=message");

    // ---------- ② 群旁听沉默 + ③ 群@必答（F6） ----------
    const t2 = Date.now();
    await send(GROUP, "今晚吃什么好呢", `e2e-full-2-${t2}`);
    await sleep(20_000);
    expect(await botMessagesSince(GROUP, t2 - 1000)).toHaveLength(0);
    expect(db.prepare("SELECT COUNT(*) n FROM agent_messages WHERE observed = 1").get().n).toBeGreaterThanOrEqual(1);

    const t3 = Date.now();
    await send(GROUP, `<at user_id="${BOT_OPEN_ID}">小达</at> 刚才群里在聊什么？一句话复述`, `e2e-full-3-${t3}`);
    const r3 = await waitBotReply(GROUP, t3 - 1000);
    expect(r3.length, `群@未回复。日志：${logs.join("").slice(-2000)}`).toBeGreaterThan(0);

    // ---------- ④ 卡片确认真写（D8：同库进程内装配，走真卡片/真写/真回注） ----------
    const wdb = openDb(DB_PATH);
    migrate(wdb);
    const realOutbound = createOutbound({ runLark });
    let sentCardJson = null;
    const outbound = { ...realOutbound, sendCard: async (args) => { sentCardJson = args.cardJson; return realOutbound.sendCard(args); } };
    const reinjected = [];
    const flow = createConfirmFlow({
      db: wdb, outbound, renderCardCopy: null, runLark,
      testTarget: testTargetFromEnv(process.env),
      onExecuted: (x) => reinjected.push(x),
    });
    const due = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const cf = await flow.startConfirmFlow({
      sessionKey: `feishu:p2p:${INITIATOR}`,
      intents: [{ kind: "create_task", payload: { title: `[E2E-full] 全链路回归任务 ${Date.now()}`, description: "H3 剧本", due_date: due, assignee_open_id: INITIATOR } }],
      initiatorOpenId: INITIATOR,
      title: "建任务确认（H3 全链路）",
    });
    expect(cf.ok, JSON.stringify(cf)).toBe(true);
    const tokenRef = JSON.stringify(sentCardJson).match(/"token_ref":"([^"]+)"/)?.[1];
    expect(tokenRef, "卡片按钮应含 token_ref").toBeTruthy();
    await flow.handleCardAction({
      operator: { open_id: INITIATOR },
      context: { open_message_id: cf.messageId },
      action: { value: { action: "confirm", token_ref: tokenRef }, form_value: {} },
    });
    let cardStatus;
    const cardDeadline = Date.now() + 60_000;
    while (Date.now() < cardDeadline) {
      cardStatus = wdb.prepare("SELECT status FROM confirm_cards WHERE job_id = ?").get(cf.jobId).status;
      if (cardStatus === "done" || cardStatus === "partial_failed") break;
      await sleep(2000);
    }
    expect(cardStatus).toBe("done");
    expect(wdb.prepare("SELECT status FROM job_actions WHERE job_id = ?").get(cf.jobId).status).toBe("succeeded");
    // 回注 hook 在终态卡真更新（lark 调用）之后才触发，等它落地
    const reinjectDeadline = Date.now() + 30_000;
    while (Date.now() < reinjectDeadline && reinjected.length === 0) await sleep(1000);
    expect(reinjected).toHaveLength(1);
    expect(reinjected[0].ok).toBe(true);

    // ---------- ⑤ cron 一次性任务 → 投递到私聊 ----------
    const t5 = Date.now();
    const cronStore = createCronStore(wdb);
    cronStore.add({
      schedule: new Date(t5 + 5_000).toISOString(),
      prompt: "这是 H3 全链路回归的定时任务：请用 reply 报一句「H3 cron 投递验证成功」。",
      deliverTo: `feishu:p2p:${INITIATOR}`,
      ownerOpenId: INITIATOR,
    });
    const r5 = await waitBotReply(P2P_CHAT, t5 - 1000, 240_000);
    expect(r5.length, `cron 未投递。日志：${logs.join("").slice(-3000)}`).toBeGreaterThan(0);

    // ---------- ⑥ HEARTBEAT 到期提醒（C0.4 owner-bound 结构化队列,不再写 HEARTBEAT.md） ----------
    const t6 = Date.now();
    const hbStore = createHeartbeatStore(wdb);
    const hbAdd = hbStore.addOwned({
      ownerSessionKey: `feishu:p2p:${INITIATOR}`,
      dueIso: new Date(t6 - 60_000).toISOString(),
      text: "H3 heartbeat 验证成功",
    });
    expect(hbAdd.ok, JSON.stringify(hbAdd)).toBe(true);
    const r6 = await waitBotReply(P2P_CHAT, t6 - 1000, 300_000);
    expect(r6.length, `heartbeat 未提醒。日志：${logs.join("").slice(-3000)}`).toBeGreaterThan(0);
    // 结构化 row 应最终 delivered（受信直投 + 幂等键 heartbeat:<itemId>）
    const hbDeadline = Date.now() + 30_000;
    let hbStatus = "";
    while (Date.now() < hbDeadline) {
      hbStatus = wdb.prepare("SELECT status FROM heartbeat_items WHERE id = ?").get(hbAdd.itemId).status;
      if (hbStatus === "delivered") break;
      await sleep(3000);
    }
    expect(hbStatus).toBe("delivered");

    // ---------- ⑦ dreaming 影子报告（进程内，同库同记忆目录；shadow 不改层文件） ----------
    const files = createMemoryFiles({ rootDir: MEMORY_DIR });
    const orgBefore = files.readLayer("org").content;
    const dreaming = createDreaming({ db: wdb, files, caller: createModelCaller({ env: process.env }), mode: "shadow" });
    const dr = await dreaming.run();
    expect(dr.ok).toBe(true);
    expect(dr.chunks).toBeGreaterThan(0);
    expect(existsSync(dr.reportPath)).toBe(true);
    const report = readFileSync(dr.reportPath, "utf8");
    expect(report).toContain("dreaming 报告");
    expect(report).toContain("模式: shadow");
    expect(files.readLayer("org").content).toBe(orgBefore); // shadow 不落盘
  }, 1_200_000);
});

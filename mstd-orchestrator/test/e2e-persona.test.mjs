// Task 8 C1 E2E：persona 生效真机验证（MSTD_E2E=1 才跑）。
// 启动完整 production daemon（隔离 DB/port/workspace，extensions 走 buildResidentExtensions
// ——daemon 即 index.mjs，本测试即证明 production 装配），真实 p2p 输入,
// 经 reply 出站断言人格/记号契约生效。只清理自己 spawn 的 daemon PID。
import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeRunLark } from "../server/execute/run-lark.mjs";

const E2E = String(process.env.MSTD_E2E ?? "") === "1";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const P2P_CHAT = process.env.MSTD_E2E_P2P_CHAT ?? "oc_11b72bc3d3bdedff7c86f3c4c61560fc";
const PORT = 8794;
// §5.2 审卷采纳:DB/workspace 按次随机,防上次残留掩盖 mkdir 删除或贡献旧消息
const RUN_ID = Date.now();
const DB_PATH = join(ROOT, "db", `e2e-persona-${RUN_ID}.sqlite`);
const WORKSPACE = join(ROOT, `agent-workspace-e2e-persona-${RUN_ID}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!E2E)("C1 E2E · persona 真机生效（人格/记号契约）", () => {
  let daemon = null;
  const logs = [];

  afterAll(async () => {
    if (daemon) {
      daemon.kill("SIGTERM");
      // §5.2 审卷采纳:SIGTERM 被忽略时 SIGKILL 兜底并确认退出,不做无条件超时放行
      const exited = await new Promise((r) => {
        daemon.once("exit", () => r(true));
        setTimeout(() => r(false), 5000);
      });
      if (!exited) {
        daemon.kill("SIGKILL");
        await new Promise((r) => { daemon.once("exit", r); setTimeout(r, 3000); });
      }
    }
    rmSync(WORKSPACE, { recursive: true, force: true });
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${DB_PATH}${suffix}`, { force: true });
  });

  async function startDaemon() {
    // §5.2 审卷采纳:清掉父环境可能泄入的 MSTD_SOUL_PATH——piEnv 注入被删时不得靠继承掩盖
    const env = {
      ...process.env, MSTD_ENABLE_AGENT: "1", PORT: String(PORT),
      MSTD_DB_PATH: DB_PATH,
      MSTD_AGENT_WORKSPACE: WORKSPACE,
    };
    delete env.MSTD_SOUL_PATH;
    // §5.2 Task 9 审卷:钉死读仓内 agent-memory 的真实 SOUL,防父环境指向别处
    delete env.MSTD_MEMORY_DIR;
    daemon = spawn("node", [join(ROOT, "server", "index.mjs")], {
      cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"],
    });
    daemon.stdout.on("data", (d) => logs.push(String(d)));
    daemon.stderr.on("data", (d) => logs.push(String(d)));
    const deadline = Date.now() + 20_000;
    let logReady = false;
    while (Date.now() < deadline) {
      if (!logReady && logs.join("").includes("agent gateway on")) logReady = true;
      if (logReady) {
        // §5.2 审卷采纳:ready 日志先于 listen 打印——补真实 HTTP 探活,任何应答即在听
        try { await fetch(`http://127.0.0.1:${PORT}/`); break; } catch { /* 未在听,继续等 */ }
      }
      await sleep(500);
    }
    if (Date.now() >= deadline) throw new Error(`daemon 未就绪:\n${logs.join("")}`);
    // §5.2 审卷采纳:workspace 必须由 daemon 创建(mkdirSync 被删即红,路径每次全新无残留)
    expect(existsSync(WORKSPACE), `agent workspace 未创建: ${WORKSPACE}`).toBe(true);
  }

  async function botTextsAfter(runLark, sinceMs, { timeoutMs = 150_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const r = await runLark([
        "im", "+chat-messages-list", "--as", "bot", "--chat-id", P2P_CHAT,
        "--start", new Date(sinceMs).toISOString(), "--json",
      ]);
      try {
        const data = JSON.parse(r.stdout);
        const items = data?.data?.items ?? data?.data?.messages ?? [];
        const fromBot = items.filter((m) =>
          m?.sender?.sender_type === "app" || m?.sender?.id_type === "app_id");
        if (fromBot.length) {
          // 真机形状:此列表接口 content 是顶层纯文本字符串(非 body.content JSON)
          return fromBot.map((m) => {
            const raw = m.body?.content ?? m.content ?? "";
            try { return JSON.parse(raw).text ?? String(raw); } catch { return String(raw); }
          }).join("\n");
        }
      } catch { /* 继续轮询 */ }
      await sleep(5000);
    }
    return "";
  }

  // lark-cli 偶发空返回(真机观测),发送重试 3 次
  async function sendWithRetry(runLark, text, key) {
    let last = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      last = await runLark([
        "im", "+messages-send", "--as", "user", "--chat-id", P2P_CHAT,
        "--text", text, "--idempotency-key", key, "--json",
      ]);
      try { if (JSON.parse(last.stdout).ok) return; } catch { /* retry */ }
      await sleep(3000);
    }
    throw new Error(`发消息 3 次失败: stdout=${last?.stdout} stderr=${last?.stderr}`);
  }

  it("问身份与 [@我] 语义:回复以小达自居、懂记号,不自称编码助手", async () => {
    await startDaemon();
    const runLark = makeRunLark({ profile: process.env.LARK_PROFILE });
    const t0 = Date.now();
    await sendWithRetry(runLark, "你是谁?对话记录里的 [@我] 记号是什么意思?", `e2e-c1-${t0}`);

    const text = await botTextsAfter(runLark, t0 - 1000);
    expect(text, `bot 未回复。daemon 日志：\n${logs.join("").slice(-3000)}`).not.toBe("");
    expect(text).toContain("小达");                            // 人格生效
    expect(text).not.toMatch(/不是小达/);                       // §5.2:排除否定式假绿
    expect(text).toMatch(/对我|@.{0,4}我|叫我|喊我/);           // 懂 [@我] = 对自己说话
    expect(text).not.toMatch(/编码助手|代码助手|编程助手|coding/i); // coding 人设零残留(§5.2 扩负向)
    expect(text).not.toMatch(/请问有什么可以帮您|好的呢/);      // Task 9 干练同事风:客服腔零出现
  }, 240_000);
});

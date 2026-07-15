// Phase F E2E：test org 群聊真机（MSTD_E2E=1 才跑）。
// ①闲聊不@ → 沉默且 observed；②@bot → 回复且带前情上下文；③ambient 明确求助 → 主动接话；④连发闲聊 → 不刷屏。
import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";
import { makeRunLark } from "../server/execute/run-lark.mjs";
import { openDb } from "../server/db/index.mjs";
import { stopOwnedProcessTree } from "./support/e2e-daemon.mjs";

const E2E = String(process.env.MSTD_E2E ?? "") === "1";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GROUP = process.env.MSTD_E2E_GROUP ?? "oc_b67c4510743e68be6a9a91f3906e7f97";
const BOT_OPEN_ID = process.env.MSTD_BOT_OPEN_ID ?? "ou_4c796176fd4ba145e5e5262d6cda77cc";
const DB_PATH = join(ROOT, "db", "e2e-group.sqlite");
const PORT = 8792;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!E2E)("Phase F E2E · 群@/旁听/限额真机", () => {
  let daemon = null;
  const logs = [];
  const runLark = makeRunLark({ profile: process.env.LARK_PROFILE });

  afterAll(async () => { await stopOwnedProcessTree(daemon); });

  async function send(text, key) {
    const r = await runLark(["im", "+messages-send", "--as", "user", "--chat-id", GROUP, "--text", text, "--idempotency-key", key, "--json"]);
    expect(JSON.parse(r.stdout).ok, r.stdout).toBe(true);
  }

  async function botMessagesSince(sinceMs) {
    const r = await runLark(["im", "+chat-messages-list", "--as", "bot", "--chat-id", GROUP, "--start", new Date(sinceMs).toISOString(), "--json"]);
    try {
      const items = JSON.parse(r.stdout).data?.messages ?? JSON.parse(r.stdout).data?.items ?? [];
      return items.filter((m) => m?.sender?.sender_type === "app" || m?.sender?.id_type === "app_id");
    } catch { return []; }
  }

  function messageText(message) {
    const raw = message?.body?.content ?? message?.content ?? "";
    try { return JSON.parse(raw).text ?? String(raw); } catch { return String(raw); }
  }

  async function waitBotReply(sinceMs, timeoutMs = 150_000, until = () => true) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const got = await botMessagesSince(sinceMs);
      if (got.length && until(got.map(messageText).join("\n"))) return got;
      await sleep(6000);
    }
    return [];
  }

  it("四段剧本：沉默旁听 → @必答带上下文 → ambient 接话 → 限额不刷屏", async () => {
    rmSync(DB_PATH, { force: true });
    daemon = spawn("node", [join(ROOT, "server", "index.mjs")], {
      cwd: ROOT,
      env: { ...process.env, MSTD_ENABLE_AGENT: "1", PORT: String(PORT), MSTD_DB_PATH: DB_PATH },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    daemon.stdout.on("data", (d) => logs.push(String(d)));
    daemon.stderr.on("data", (d) => logs.push(String(d)));
    let deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !logs.join("").includes("ticker on")) await sleep(500);
    expect(logs.join("")).toContain("ticker on");
    await sleep(3000);

    // ① 闲聊两条不@ → 沉默 + observed 落库
    const t1 = Date.now();
    await send("昨天的球赛看了吗，绝了", `e2e-g1-${t1}`);
    await send("今晚要不要一起点外卖", `e2e-g2-${t1}`);
    await sleep(20_000);
    expect(await botMessagesSince(t1 - 1000)).toHaveLength(0);
    const db = openDb(DB_PATH);
    const observed = db.prepare("SELECT COUNT(*) n FROM agent_messages WHERE observed = 1").get().n;
    expect(observed).toBe(2);

    // ② @bot 问上下文 → 必答
    const t2 = Date.now();
    await send(`<at user_id="${BOT_OPEN_ID}">小达</at> 刚才群里大家在聊什么？简单复述一下`, `e2e-g3-${t2}`);
    const reply2 = await waitBotReply(t2 - 1000, 150_000, (text) => /球赛|外卖/.test(text));
    expect(reply2.length, `bot 未回复@。日志：${logs.join("").slice(-2000)}`).toBeGreaterThan(0);

    // ③ 切 ambient → 明确求助 → 主动接话
    db.prepare(
      "INSERT INTO group_policies (chat_id, policy, hourly_proactive_limit, updated_at) VALUES (?, 'ambient', 4, 0) ON CONFLICT (chat_id) DO UPDATE SET policy='ambient'"
    ).run(GROUP);
    const t3 = Date.now();
    await send("在吗各位，谁知道 2+2 等于几？我算不明白了，急，在线等", `e2e-g4-${t3}`);
    const reply3 = await waitBotReply(t3 - 1000, 150_000, (text) => /(?:^|\D)4(?:\D|$)|四/.test(text));
    expect(reply3.length, `ambient 未接话。日志：${logs.join("").slice(-2000)}`).toBeGreaterThan(0);

    // ④ 连发闲聊 → 不刷屏（新增 bot 消息 ≤1）
    const baseline = new Set(
      (await botMessagesSince(t3 - 60_000)).map((message) => message.message_id),
    );
    const t4 = Date.now();
    await send("哈哈哈哈", `e2e-g5-${t4}`);
    await send("就是说啊", `e2e-g6-${t4}`);
    await send("下班了下班了", `e2e-g7-${t4}`);
    await sleep(45_000);
    const noisy = (await botMessagesSince(t3 - 60_000))
      .filter((message) => !baseline.has(message.message_id));
    expect(noisy.length).toBeLessThanOrEqual(1);
  }, 600_000);
});

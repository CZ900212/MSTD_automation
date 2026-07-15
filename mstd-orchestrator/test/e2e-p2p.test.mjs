// Phase B E2E：test org 真机私聊闭环（MSTD_E2E=1 才跑）。
// 起完整 daemon（真 lark-cli + 真三模型），私聊 bot 断言收到回复。
import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeRunLark } from "../server/execute/run-lark.mjs";
import { stopOwnedProcessTree } from "./support/e2e-daemon.mjs";

const E2E = String(process.env.MSTD_E2E ?? "") === "1";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const P2P_CHAT = process.env.MSTD_E2E_P2P_CHAT ?? "oc_11b72bc3d3bdedff7c86f3c4c61560fc";
const PORT = 8791;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!E2E)("Phase B E2E · test org 私聊闭环", () => {
  let daemon = null;
  const logs = [];

  afterAll(async () => { await stopOwnedProcessTree(daemon); });

  async function startDaemon() {
    daemon = spawn("node", [join(ROOT, "server", "index.mjs")], {
      cwd: ROOT,
      env: { ...process.env, MSTD_ENABLE_AGENT: "1", PORT: String(PORT), MSTD_DB_PATH: join(ROOT, "db", "e2e-p2p.sqlite") },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    daemon.stdout.on("data", (d) => logs.push(String(d)));
    daemon.stderr.on("data", (d) => logs.push(String(d)));
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (logs.join("").includes("agent gateway on")) return;
      await sleep(500);
    }
    throw new Error(`daemon 未就绪:\n${logs.join("")}`);
  }

  async function botRepliesAfter(runLark, sinceMs, { timeoutMs = 120_000 } = {}) {
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
        if (fromBot.length) return fromBot;
      } catch { /* 继续轮询 */ }
      await sleep(5000);
    }
    return [];
  }

  it("你好自我介绍 → 60~120s 内收到 bot 回复；日志含分诊与回合", async () => {
    await startDaemon();
    const runLark = makeRunLark({ profile: process.env.LARK_PROFILE });
    const t0 = Date.now();
    const send = await runLark([
      "im", "+messages-send", "--as", "user", "--chat-id", P2P_CHAT,
      "--text", "你好，介绍一下你自己", "--idempotency-key", `e2e-b7-${t0}`, "--json",
    ]);
    expect(JSON.parse(send.stdout).ok).toBe(true);

    const replies = await botRepliesAfter(runLark, t0 - 1000);
    expect(replies.length, `bot 未回复。daemon 日志：\n${logs.join("").slice(-3000)}`).toBeGreaterThan(0);

    const logText = logs.join("");
    expect(logText).toContain("[agent] turn kind=message");
    expect(logText).toMatch(/\[agent\] triage .* action=(quick_reply|escalate)/);
  }, 200_000);
});

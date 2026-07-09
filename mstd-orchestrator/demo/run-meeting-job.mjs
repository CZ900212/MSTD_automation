/**
 * Demo：无头(headless)跑通"会议纪要→建任务"这条已验证链路的完整多模型闭环。
 *   supervisor(pi-client, RPC) 驱动 Pi：
 *     主脑 = GPT-5.5（CZ 网关，工具循环 / 编排，推理强度始终 medium）
 *     感知/执行 = lark 工具（真实飞书）
 *     与用户交互/执笔 = draft_zh 工具（Claude Opus 4.6）
 *
 * 运行：先 `set -a; . ./.env; set +a` 再 `node demo/run-meeting-job.mjs`
 */
import { join } from "node:path";
import { startPi } from "../supervisor/pi-client.mjs";

const ROOT = join(new URL(".", import.meta.url).pathname, "..");

const JOB = `你是「会议纪要编排 Agent」的大脑。请无人工介入地完成一个 job：

1) 用 lark 工具搜我名下妙记：args=["minutes","+search","--owner-ids","me","--as","user"]，取第一条的 token。
2) 用 lark 工具导出逐字稿：args=["minutes","+detail","--minute-tokens","<token>","--transcript","--as","user","--output-dir","./out"]。
3) 用 read 工具读取导出的 transcript.txt。
4) 从逐字稿抽取 action items（负责人 + 事项），并判断每个负责人能否对齐到飞书 open_id（口语称呼=低置信，需人工确认）。
5) 调 draft_zh 工具（这是 Opus 4.6），让它写一段**发给会议主持人的飞书确认卡片正文（中文）**：列出待办、标注高/低置信、请主持人确认后再建任务。把抽取结果作为 context 传给它。
6) 最后只输出 draft_zh 返回的那段卡片文案（不要加你自己的解释）。`;

const client = startPi({
  provider: "cz-gpt",
  model: "gpt-5.5",
  thinking: "medium",
  cwd: ROOT,
  extensions: [
    join(ROOT, "pi-ext", "providers.ts"),
    join(ROOT, "pi-ext", "lark.ts"),
    join(ROOT, "pi-ext", "draft.ts"),
  ],
  debug: true,
});

console.error("[demo] 驱动 Pi 跑 job（GPT-5.5 编排[medium] + lark 感知 + opus 执笔）...");
const t0 = Date.now();
const out = await client.prompt(JOB, { timeoutMs: 300000 });
console.error(`[demo] 完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s。事件类型: ${[...client.seenTypes].join(", ")}`);
console.log("\n================ 卡片文案（Opus 4.6 执笔）================\n");
console.log(out);
console.log("\n=========================================================");
await client.close();

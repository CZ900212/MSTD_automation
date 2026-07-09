import { join } from "node:path";
import { startPi } from "./pi-client.mjs";

const ROOT = join(new URL(".", import.meta.url).pathname, "..");
const client = startPi({
  provider: "cz-gpt", model: "gpt-5.5", thinking: "medium", cwd: ROOT,
  extensions: [join(ROOT, "pi-ext", "providers.ts"), join(ROOT, "pi-ext", "lark.ts")],
});
const seen = [];
const { finalText } = await client.runJob(
  '只读：调用一次 lark 工具执行 args=["minutes","+search","--owner-ids","me","--as","user"]，取第一条标题用一句话回我。严禁任何写操作。',
  { id: "smoke-1", onEvent: (e) => { seen.push(e.event); process.stderr.write(`[sse] ${e.event}${e.data?.text ? " " + JSON.stringify(e.data.text) : ""}\n`); }, timeoutMs: 150000 }
);
console.error(`\n[smoke] SSE event sequence: ${seen.join(", ")}`);
console.log(`[smoke] finalText: ${finalText}`);
await client.close();

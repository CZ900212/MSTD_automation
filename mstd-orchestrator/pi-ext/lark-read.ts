/**
 * Pi 扩展（仅第①段加载）：lark_read —— deny-by-default 只读白名单。
 * 读飞书走 buildLarkReadArgs 白名单；read_file 只读 job 工作目录内文件。无任何写能力。
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildLarkReadArgs } from "../server/safety/lark-read.mjs";
import { resolveInsideWorkdir } from "../server/execute/job-workdir.mjs";

const LARK_CLI = join(homedir(), ".hermes", "node", "bin", "lark-cli");
const CLIP = 20000;

function runLark(args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const profile = process.env.LARK_PROFILE;
    const finalArgs = profile ? ["--profile", profile, ...args] : args;
    const child = spawn(LARK_CLI, finalArgs, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = []; const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGTERM"), 60_000);
    signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString(), code });
    });
  });
}

const clip = (s: string) => (s.length > CLIP ? s.slice(0, CLIP) + "\n...(截断)" : s);

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "lark_read",
    label: "Lark Read",
    description:
      "只读飞书（deny-by-default 白名单，无任何写能力）。op:\n" +
      "  search_minutes —— 搜我拥有的妙记\n" +
      "  get_transcript —— 导出逐字稿（必填 minute_token；文件落 ./out）\n" +
      "  search_user —— 按人名搜 open_id（必填 query）\n" +
      "  read_file —— 读工作目录内文件（必填 path，如 out/xxx.txt）",
    parameters: Type.Object({
      op: Type.String({ description: "search_minutes | get_transcript | search_user | read_file" }),
      minute_token: Type.Optional(Type.String()),
      query: Type.Optional(Type.String()),
      path: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal) {
      try {
        if (params.op === "read_file") {
          const workdir = process.env.MSTD_JOB_WORKDIR || process.cwd();
          const abs = resolveInsideWorkdir(workdir, params.path ?? "");
          return { content: [{ type: "text", text: clip(readFileSync(abs, "utf8")) }], details: { path: abs } };
        }
        const args = buildLarkReadArgs(params.op, params);
        const r = await runLark(args, signal);
        const body = r.code === 0 ? r.stdout || "(空输出)" : `exit=${r.code}\nSTDERR:\n${r.stderr}`;
        return { content: [{ type: "text", text: clip(body) }], details: { exitCode: r.code, argv: args } };
      } catch (e) {
        return { content: [{ type: "text", text: `拒绝/失败: ${e instanceof Error ? e.message : String(e)}` }], details: { error: String(e) } };
      }
    },
  });
}

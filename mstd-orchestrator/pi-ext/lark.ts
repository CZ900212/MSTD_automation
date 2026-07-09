/**
 * Pi 扩展：把已验证的 lark-cli 暴露成一个 `lark` 工具，让 Pi(大脑) 能感知/执行飞书。
 * 复用会话内已授权的 profile（默认 user613148），全量 lark-cli 命令可用：
 *   minutes(+detail/+search) · contact(+search-user) · im(+messages-send) · task(+create) · calendar · event...
 *
 * 安全：默认放行只读；写/高危(--yes, delete, logout, recall)默认拦截，除非 LARK_ALLOW_WRITE=1。
 * 这是本地验证版；生产版把拦截逻辑升级成 guard hook + 人在环路卡片确认（计划 Phase 1.2）。
 *
 * 用法: pi -e pi-ext/lark.ts ...  然后让模型调用 lark 工具，args 传 lark-cli 的参数数组。
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const LARK_CLI = join(homedir(), ".hermes", "node", "bin", "lark-cli");
const DEFAULT_TIMEOUT_S = 60;

// 写/高危动作的粗过滤（本地验证版；生产走 guard hook + 卡片确认）
const HIGH_RISK = new Set(["--yes"]);
const HIGH_RISK_SUBCOMMANDS = [/\bdelete\b/, /\blogout\b/, /\brecall\b/, /messages\s+delete/];

function isBlockedWrite(args: string[]): string | null {
  if (process.env.LARK_ALLOW_WRITE === "1") return null;
  const joined = args.join(" ");
  for (const a of args) if (HIGH_RISK.has(a)) return `拦截：包含高危标志 ${a}（设 LARK_ALLOW_WRITE=1 放行）`;
  for (const re of HIGH_RISK_SUBCOMMANDS) if (re.test(joined)) return `拦截：疑似删除/撤回/登出（设 LARK_ALLOW_WRITE=1 放行）`;
  return null;
}

function runLark(args: string[], timeoutS: number, signal?: AbortSignal): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const profile = process.env.LARK_PROFILE;
    const finalArgs = profile ? ["--profile", profile, ...args] : args;
    const child = spawn(LARK_CLI, finalArgs, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutS * 1000);
    const onAbort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString(), code });
    });
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "lark",
    label: "Lark",
    description:
      "调用飞书 lark-cli（已授权 profile）。args 传 lark-cli 的参数数组。常用：\n" +
      "  搜妙记: [\"minutes\",\"+search\",\"--owner-ids\",\"me\",\"--as\",\"user\"]\n" +
      "  导逐字稿: [\"minutes\",\"+detail\",\"--minute-tokens\",\"<token>\",\"--transcript\",\"--as\",\"user\",\"--output-dir\",\"./out\"]\n" +
      "  解析人名: [\"contact\",\"+search-user\",\"--user-ids\",\"me\",\"--as\",\"user\"]\n" +
      "  发卡片: [\"im\",\"+messages-send\",\"--as\",\"bot\",\"--user-id\",\"ou_...\",\"--msg-type\",\"interactive\",\"--content\",\"<json>\"]\n" +
      "  建任务: [\"task\",\"+create\",\"--as\",\"user\",\"--data\",\"<json>\"]\n" +
      "返回 lark-cli 的 stdout（多为 JSON）。默认只放行只读；写操作需环境放行。",
    parameters: Type.Object({
      args: Type.Array(Type.String(), { description: "lark-cli 参数数组，例如 [\"minutes\",\"+search\",\"--owner-ids\",\"me\",\"--as\",\"user\"]" }),
      reason: Type.Optional(Type.String({ description: "为什么调用（审计用）" })),
      timeout_s: Type.Optional(Type.Number({ description: `超时秒数，默认 ${DEFAULT_TIMEOUT_S}` })),
    }),

    async execute(_id, params, signal, _onUpdate, _ctx) {
      const args = params.args ?? [];
      if (args.length === 0) {
        return { content: [{ type: "text", text: "错误：args 为空" }], details: { error: "empty args" } };
      }
      const blocked = isBlockedWrite(args);
      if (blocked) {
        return { content: [{ type: "text", text: blocked }], details: { blocked: true, args } };
      }
      try {
        const r = await runLark(args, params.timeout_s ?? DEFAULT_TIMEOUT_S, signal);
        const body = r.code === 0 ? r.stdout || "(空输出)" : `exit=${r.code}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`;
        // 截断超长输出，避免撑爆上下文
        const text = body.length > 20000 ? body.slice(0, 20000) + "\n...(截断)" : body;
        return { content: [{ type: "text", text }], details: { exitCode: r.code, argv: args, reason: params.reason } };
      } catch (e) {
        return { content: [{ type: "text", text: `执行失败: ${e instanceof Error ? e.message : String(e)}` }], details: { error: String(e), argv: args } };
      }
    },
  });
}

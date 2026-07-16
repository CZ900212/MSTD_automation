/**
 * Pi 扩展（仅第①段加载）：lark_read —— deny-by-default 只读白名单。
 * 读飞书走 buildLarkReadArgs 白名单；read_file 只读 job 工作目录内文件。无任何写能力。
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildLarkReadArgsScoped, resolveLarkScope } from "../server/safety/lark-read.mjs";
import { readJobArtifactUtf8 } from "../server/execute/job-workdir.mjs";

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

// 批次 C：向 daemon 上报本次读到的源文本（逐字引用守卫的比对基准 + 席位私有 taint）。
// 尽力而为：daemon 侧 fail 不阻断读取；但 resident（有 token）会在返回结果前等它落地，
// 保证模型看到内容之前 shingle 已登记——reply 出站检查不会跑在登记前面。
async function reportSource(op: string, text: string): Promise<void> {
  const base = process.env.MSTD_INTERNAL_URL;
  const token = process.env.MSTD_INTERNAL_TOKEN;
  const sessionKey = process.env.MSTD_SESSION_KEY;
  if (!base || !token || !sessionKey || !text) return;
  try {
    await fetch(`${base}/internal/egress/source`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ session_key: sessionKey, op, text }),
      signal: AbortSignal.timeout(3000),
    });
  } catch { /* 登记失败不阻断只读链路 */ }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "lark_read",
    label: "Lark Read",
    description:
      "只读飞书（deny-by-default 白名单，无任何写能力）。会话隔离铁律：聊天记录/成员/搜消息只作用于**当前会话**，别的群和私聊的内容一律读不到，不要尝试。op 清单（括号内为必填参数）:\n" +
      "【消息】list_chats——我在的群列表 | search_chats(query)——搜群 | chat_history——拉当前会话历史(可选 page_token/start/end ISO时间) | chat_members——当前群成员 | search_messages(query)——在当前会话内搜消息\n" +
      "【文档】read_doc(doc)——读文档正文(doc=URL或token,markdown输出) | search_docs(query)——搜云文档/wiki | search_drive——搜云盘文件(可选 query)\n" +
      "【知识库】wiki_spaces——空间列表 | wiki_nodes(space_id)——节点列表 | wiki_node(node_token)——节点详情\n" +
      "【日历】agenda——日程(默认今天,可选 start/end) | search_events——搜日程(可选 query/start/end)\n" +
      "【任务】my_tasks——我的任务(可选 complete=true/false,query) | search_tasks(query) | get_task(task_guid)——按飞书全局任务 GUID 读取单条任务（不是 t104121 一类展示编号）\n" +
      "【表格】sheet_info(spreadsheet_token) | sheet_cells(spreadsheet_token,sheet_id,range如A1:F10) | base_tables(base_token) | base_records(base_token,table_id)\n" +
      "【妙记】search_minutes——搜我拥有的妙记 | get_transcript(minute_token)——导出逐字稿(文件落./out)\n" +
      "【其他】search_user(query)——人名→open_id | get_user——查用户(可选 user_id=ou_*,缺省查自己) | okr_cycles(user_id) | mail_list——邮件列表(可选 query/limit) | mail_message(message_id) | attendance(user_id,date_from,date_to整数YYYYMMDD)——打卡记录\n" +
      "  read_file(path)——读工作目录内文件(如 out/xxx.txt)。分页类结果带 page_token 时可传回续拉。",
    parameters: Type.Object({
      op: Type.String({ description: "白名单操作名，见工具描述" }),
      minute_token: Type.Optional(Type.String()),
      query: Type.Optional(Type.String()),
      path: Type.Optional(Type.String()),
      chat_id: Type.Optional(Type.String({ description: "oc_ 开头" })),
      page_token: Type.Optional(Type.String()),
      page_size: Type.Optional(Type.Number()),
      start: Type.Optional(Type.String({ description: "ISO 8601 时间" })),
      end: Type.Optional(Type.String()),
      doc: Type.Optional(Type.String({ description: "文档 URL 或 token" })),
      space_id: Type.Optional(Type.String()),
      parent_node_token: Type.Optional(Type.String()),
      node_token: Type.Optional(Type.String()),
      complete: Type.Optional(Type.String({ description: "true|false" })),
      task_guid: Type.Optional(Type.String({ description: "飞书全局任务 GUID（不是展示编号）" })),
      spreadsheet_token: Type.Optional(Type.String()),
      sheet_id: Type.Optional(Type.String()),
      range: Type.Optional(Type.String()),
      base_token: Type.Optional(Type.String()),
      table_id: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number()),
      user_id: Type.Optional(Type.String({ description: "ou_ 开头 open_id（attendance 用 employee_id）" })),
      message_id: Type.Optional(Type.String()),
      date_from: Type.Optional(Type.Number({ description: "YYYYMMDD" })),
      date_to: Type.Optional(Type.Number()),
    }),
    async execute(_id, params, signal) {
      try {
        if (params.op === "read_file") {
          const workdir = String(process.env.MSTD_JOB_WORKDIR ?? "").trim();
          if (!workdir) throw new Error("read_file 仅限 job workdir（fail-closed）");
          const text = readJobArtifactUtf8(workdir, params.path ?? "");
          const clipped = clip(text);
          await reportSource(params.op, clipped);
          return { content: [{ type: "text", text: clipped }], details: { path: params.path } };
        }
        const args = buildLarkReadArgsScoped(params.op, params, resolveLarkScope(process.env));
        const r = await runLark(args, signal);
        const body = r.code === 0 ? r.stdout || "(空输出)" : `exit=${r.code}\nSTDERR:\n${r.stderr}`;
        const clipped = clip(body);
        if (r.code === 0) await reportSource(params.op, clipped);
        return { content: [{ type: "text", text: clipped }], details: { exitCode: r.code, argv: args } };
      } catch (e) {
        if (signal?.aborted) throw e; // 与 draft.ts 同则:abort 如实传播,不伪造错误结果
        return { content: [{ type: "text", text: `拒绝/失败: ${e instanceof Error ? e.message : String(e)}` }], details: { error: String(e) } };
      }
    },
  });
}

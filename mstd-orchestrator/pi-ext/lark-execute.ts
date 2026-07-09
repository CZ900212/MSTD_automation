/**
 * Pi 扩展（仅第②段加载）：lark_execute_approved_action
 * 模型只能按 action_id 选执行已批准动作；权威执行在服务端。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { openDb } from "../server/db/index.mjs";
import { executeApprovedAction, loadApprovedHashes } from "../server/execute/execute-action.mjs";
import { testTargetFromEnv } from "../server/execute/write-target.mjs";

const LARK_CLI = join(homedir(), ".hermes", "node", "bin", "lark-cli");

function runLark(argv: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const profile = process.env.LARK_PROFILE;
    const finalArgs = profile ? ["--profile", profile, ...argv] : argv;
    const child = spawn(LARK_CLI, finalArgs, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = []; const err: Buffer[] = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("close", (code) => resolve({ exitCode: code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }));
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "lark_execute_approved_action",
    label: "Execute Approved Action",
    description:
      "执行一条【已批准】的飞书写动作。只接受 action_id；不得重新判断、不得改内容、只回报每条结果。",
    parameters: Type.Object({
      action_id: Type.String({ description: "已批准动作的 action_id" }),
    }),
    async execute(_id, params) {
      const dbPath = process.env.MSTD_DB_PATH || "./mstd.db";
      const db = openDb(dbPath);
      try {
        const action = db.prepare("SELECT job_id FROM job_actions WHERE id = ?").get(params.action_id) as { job_id?: string } | undefined;
        if (!action?.job_id) {
          return { content: [{ type: "text", text: `未知 action_id: ${params.action_id}` }], details: { ok: false } };
        }
        const approved = loadApprovedHashes(db, action.job_id);
        const key = db.prepare("SELECT action_key FROM job_actions WHERE id = ?").get(params.action_id) as { action_key: string };
        const out = await executeApprovedAction(db, {
          actionId: params.action_id,
          approvedHash: approved.get(key.action_key) ?? null,
          runLark,
          testTarget: testTargetFromEnv(),
        });
        return { content: [{ type: "text", text: JSON.stringify(out) }], details: out };
      } finally {
        db.close();
      }
    },
  });
}

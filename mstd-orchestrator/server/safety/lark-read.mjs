// deny-by-default：只有下列具名只读操作被允许；参数是具名参数，绝不接受自由 args[]。
// 迭代二 T1.2 全域扩容：argv 模板逐条经 lark-cli --dry-run 验证（2026-07-12）。
// 注意：attendance user_tasks query 底层是 POST 但语义只读——data JSON 由服务端拼装，
// 不接受自由 JSON 字符串。
// 迭代三：会话域门禁（buildLarkReadArgsScoped）——聊天内容只许本会话，席位私有只许
// owner 私聊，后台任务只留妙记链窄集；无会话身份 fail-closed 全拒。
import { parseSessionKey } from "../sessions/session-key.mjs";
import { normalizeMinuteToken } from "./minute-token.mjs";

const need = (p, key) => {
  const v = p?.[key];
  if (typeof v !== "string" || !v.trim()) throw new Error(`${key} 必填`);
  return v.trim();
};
const opt = (p, key) => {
  const v = p?.[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
};
const needChatId = (p) => {
  const v = need(p, "chat_id");
  if (!/^oc_[a-f0-9]+$/i.test(v)) throw new Error(`非法 chat_id: ${v}`);
  return v;
};
const optInt = (p, key, { min, max, dflt }) => {
  const raw = p?.[key];
  if (raw == null || raw === "") return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${key} 须为 ${min}-${max} 的整数`);
  return n;
};
const push = (args, flag, v) => { if (v != null) args.push(flag, String(v)); };
const needTaskGuid = (p) => {
  const guid = need(p, "task_guid");
  if (guid.length > 256 || /[\u0000-\u001f\u007f]/.test(guid)) throw new Error("非法 task_guid");
  return guid;
};

const READ_OPS = {
  // ---- 妙记（原有） ----
  search_minutes: () => ["minutes", "+search", "--owner-ids", "me", "--as", "user"],
  get_transcript: (p) => [
    "minutes", "+detail", "--minute-tokens", normalizeMinuteToken(p?.minute_token),
    "--transcript", "--as", "user", "--output-dir", "./out",
  ],
  search_user: (p) => ["contact", "+search-user", "--query", need(p, "query"), "--as", "user"],

  // ---- im：群/消息 ----
  list_chats: (p) => {
    const a = ["im", "+chat-list", "--page-size", String(optInt(p, "page_size", { min: 1, max: 100, dflt: 20 })), "--as", "user"];
    push(a, "--page-token", opt(p, "page_token"));
    return a;
  },
  search_chats: (p) => {
    const a = ["im", "+chat-search", "--query", need(p, "query"), "--as", "user"];
    push(a, "--page-token", opt(p, "page_token"));
    return a;
  },
  chat_history: (p) => {
    const a = ["im", "+chat-messages-list", "--chat-id", needChatId(p),
      "--page-size", String(optInt(p, "page_size", { min: 1, max: 50, dflt: 30 })), "--as", "user"];
    push(a, "--page-token", opt(p, "page_token"));
    push(a, "--start", opt(p, "start"));
    push(a, "--end", opt(p, "end"));
    return a;
  },
  chat_members: (p) => {
    const a = ["im", "+chat-members-list", "--chat-id", needChatId(p), "--as", "user"];
    push(a, "--page-token", opt(p, "page_token"));
    return a;
  },
  search_messages: (p) => {
    const a = ["im", "+messages-search", "--query", need(p, "query"), "--as", "user"];   // 仅 user 身份
    if (opt(p, "chat_id")) a.push("--chat-id", needChatId(p));
    return a;
  },

  // ---- 云文档 / drive / wiki ----
  read_doc: (p) => ["docs", "+fetch", "--doc", need(p, "doc"), "--doc-format", "im-markdown", "--as", "user"],
  search_docs: (p) => ["docs", "+search", "--query", need(p, "query"), "--as", "user"],   // 仅 user
  search_drive: (p) => {
    const a = ["drive", "+search", "--as", "user"];
    push(a, "--query", opt(p, "query"));
    return a;
  },
  wiki_spaces: (p) => {
    const a = ["wiki", "+space-list", "--as", "user"];
    push(a, "--page-token", opt(p, "page_token"));
    return a;
  },
  wiki_nodes: (p) => {
    const a = ["wiki", "+node-list", "--space-id", need(p, "space_id"), "--as", "user"];
    push(a, "--parent-node-token", opt(p, "parent_node_token"));
    push(a, "--page-token", opt(p, "page_token"));
    return a;
  },
  wiki_node: (p) => ["wiki", "+node-get", "--node-token", need(p, "node_token"), "--as", "user"],

  // ---- 日历 ----
  agenda: (p) => {
    const a = ["calendar", "+agenda", "--as", "user"];
    push(a, "--start", opt(p, "start"));
    push(a, "--end", opt(p, "end"));
    return a;
  },
  search_events: (p) => {
    const a = ["calendar", "+search-event", "--as", "user"];   // 仅 user
    push(a, "--query", opt(p, "query"));
    push(a, "--start", opt(p, "start"));
    push(a, "--end", opt(p, "end"));
    return a;
  },

  // ---- 任务 ----
  my_tasks: (p) => {
    const a = ["task", "+get-my-tasks", "--as", "user"];   // 仅 user
    const c = opt(p, "complete");
    if (c === "true" || c === "false") a.push("--complete", c);
    push(a, "--query", opt(p, "query"));
    return a;
  },
  search_tasks: (p) => ["task", "+search", "--query", need(p, "query"), "--as", "user"],   // 仅 user
  get_task: (p) => ["task", "tasks", "get", "--task-guid", needTaskGuid(p), "--as", "user"],

  // ---- 表格 / 多维表格 ----
  sheet_info: (p) => ["sheets", "+workbook-info", "--spreadsheet-token", need(p, "spreadsheet_token"), "--as", "user"],
  sheet_cells: (p) => [
    "sheets", "+cells-get", "--spreadsheet-token", need(p, "spreadsheet_token"),
    "--sheet-id", need(p, "sheet_id"), "--range", need(p, "range"), "--as", "user",
  ],
  base_tables: (p) => ["base", "+table-list", "--base-token", need(p, "base_token"), "--as", "user"],
  base_records: (p) => [
    "base", "+record-list", "--base-token", need(p, "base_token"), "--table-id", need(p, "table_id"),
    "--limit", String(optInt(p, "limit", { min: 1, max: 200, dflt: 50 })), "--as", "user",
  ],

  // ---- okr / mail / contact ----
  okr_cycles: (p) => ["okr", "+cycle-list", "--user-id", need(p, "user_id"), "--as", "user"],
  mail_list: (p) => {
    const a = ["mail", "+triage", "--mailbox", "me", "--max", String(optInt(p, "limit", { min: 1, max: 100, dflt: 20 })), "--as", "user"];
    push(a, "--query", opt(p, "query"));
    return a;
  },
  mail_message: (p) => ["mail", "+message", "--message-id", need(p, "message_id"), "--mailbox", "me", "--as", "user"],
  get_user: (p) => {
    const a = ["contact", "+get-user", "--as", "user"];
    const uid = opt(p, "user_id");
    if (uid) {
      if (!/^ou_[a-f0-9]+$/i.test(uid)) throw new Error(`非法 user_id: ${uid}`);
      a.push("--user-id", uid, "--user-id-type", "open_id");
    }
    return a;
  },

  // ---- attendance（底层 POST 但语义只读；data 由服务端拼装，绝不透传自由 JSON） ----
  attendance: (p) => {
    const userId = need(p, "user_id");
    const from = optInt(p, "date_from", { min: 20200101, max: 20991231, dflt: null });
    const to = optInt(p, "date_to", { min: 20200101, max: 20991231, dflt: null });
    if (!from || !to) throw new Error("date_from/date_to 必填（YYYYMMDD 整数）");
    const data = JSON.stringify({ user_ids: [userId], check_date_from: from, check_date_to: to });
    return ["attendance", "user_tasks", "query", "--employee-type", "employee_id", "--data", data, "--as", "user"];
  },
};

export function buildLarkReadArgs(op, params = {}) {
  const build = READ_OPS[op];
  if (!build) throw new Error(`unknown/不允许的只读操作: ${op}`);
  return build(params);
}

export const READ_OP_NAMES = Object.keys(READ_OPS);

// ---- 会话域门禁（隐私铁律延伸到飞书读取面）----
// 聊天内容绝不跨会话加载：群 A / 私聊的消息永远到不了群 B 的上下文。
const CHAT_CONTENT_OPS = new Set(["chat_history", "chat_members", "search_messages"]);
const CHAT_METADATA_OPS = new Set(["list_chats", "search_chats"]);
const SEAT_PRIVATE_OPS = new Set(["mail_list", "mail_message", "search_minutes", "get_transcript"]);
// 后台任务（妙记链）所需窄集——job 域内除此全拒
const JOB_OPS = new Set(["search_minutes", "get_transcript", "search_user", "get_user"]);

// 批次 C taint 依据：resident 直接读过席位私有数据 → 本 security epoch 带污点，
// 完成当前授权答复后 recycle（trust-boundary SENSITIVITIES 语义的 restricted 档）。
export function larkReadSensitivity(op) {
  return SEAT_PRIVATE_OPS.has(op) ? "restricted" : "internal";
}

// 从 Pi 进程 env 解析调用域。brain 在 spawn 时注入 MSTD_SESSION_KEY（+私聊的 MSTD_CHAT_ID）；
// job Pi 只有 MSTD_JOB_WORKDIR；两者皆无 = unknown（fail-closed 全拒）。
export function resolveLarkScope(env = {}) {
  const ownerOpenId = String(env.MSTD_PRIVATE_DATA_OWNER_OPEN_ID ?? "").trim() || null;
  const sessionKey = String(env.MSTD_SESSION_KEY ?? "").trim();
  if (sessionKey) {
    let parsed = null;
    try { parsed = parseSessionKey(sessionKey); } catch { return { kind: "unknown", ownerOpenId }; }
    if (parsed.kind === "group") return { kind: "group", chatId: parsed.chatId, ownerOpenId };
    if (parsed.kind === "p2p") {
      const chatId = String(env.MSTD_CHAT_ID ?? "").trim() || null;
      return { kind: "p2p", chatId, openId: parsed.openId, ownerOpenId };
    }
    return { kind: parsed.kind, ownerOpenId }; // cron / debug
  }
  if (String(env.MSTD_JOB_WORKDIR ?? "").trim()) {
    return {
      kind: "job",
      ownerOpenId,
      requesterOpenId: String(env.MSTD_JOB_REQUESTER_OPEN_ID ?? "").trim() || null,
      privateReadAuthorized: String(env.MSTD_JOB_PRIVATE_READ_AUTHORIZED ?? "") === "1",
    };
  }
  return { kind: "unknown", ownerOpenId };
}

export function buildLarkReadArgsScoped(op, params = {}, scope = { kind: "unknown" }) {
  if (!READ_OPS[op]) throw new Error(`unknown/不允许的只读操作: ${op}`);
  const kind = scope?.kind ?? "unknown";
  if (kind === "unknown") throw new Error("无会话身份，飞书读取一律拒绝（fail-closed）");

  if (CHAT_CONTENT_OPS.has(op)) {
    if (kind !== "group" && kind !== "p2p") {
      throw new Error(`${op} 仅限群/私聊会话内使用：${kind} 域禁止读聊天内容`);
    }
    if (!scope.chatId) throw new Error("本会话未绑定 chat_id，聊天内容读取被拒绝（fail-closed）");
    const requested = opt(params, "chat_id");
    if (requested && requested !== scope.chatId) {
      throw new Error(`跨会话读取被禁止：本会话只能访问自己的聊天内容（${scope.chatId}）`);
    }
    // 缺省即本会话；search_messages 强制圈定在本会话内
    return buildLarkReadArgs(op, { ...params, chat_id: scope.chatId });
  }

  if (SEAT_PRIVATE_OPS.has(op)) {
    if (kind === "job" && JOB_OPS.has(op) && scope.privateReadAuthorized === true) {
      return buildLarkReadArgs(op, params);
    }
    const isOwnerP2p = kind === "p2p" && scope.openId && scope.ownerOpenId && scope.openId === scope.ownerOpenId;
    if (!isOwnerP2p) throw new Error(`${op} 属席位私有数据，仅限 owner 私聊使用`);
    return buildLarkReadArgs(op, params);
  }

  if (CHAT_METADATA_OPS.has(op)) {
    if (kind === "job") throw new Error(`后台任务只读白名单不含 ${op}`);
    return buildLarkReadArgs(op, params);
  }

  // 公司资产类（文档/wiki/日历/任务/表格/通讯录等）：job 域收窄到妙记链所需，其余域放行
  if (kind === "job" && !JOB_OPS.has(op)) throw new Error(`后台任务只读白名单不含 ${op}`);
  return buildLarkReadArgs(op, params);
}

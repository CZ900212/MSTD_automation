import { createHash } from "node:crypto";
import { parseStrictIsoWithTimezone } from "../time/strict-iso.mjs";
import { canonicalDeliverableKey } from "../sessions/session-key.mjs";

// open_id 唯一校验器：outbound 出站与 initiator 门禁同用此处，不得各持一份正则。
const OPEN_ID_PATTERN = /^ou_[a-zA-Z0-9]+$/;

export function isValidOpenId(v) {
  return typeof v === "string" && OPEN_ID_PATTERN.test(v);
}

// task_guid 唯一约束：action 规范化与 write-args 执行侧共用（payload_hash 之外规则单一来源）。
export function isValidTaskGuid(v) {
  return typeof v === "string" && !!v.trim() && v.length <= 256 && !/[\u0000-\u001f\u007f]/.test(v);
}

export function isValidDocToken(v) {
  return typeof v === "string" && /^[a-zA-Z0-9_-]{8,256}$/.test(v);
}

export function canonicalJson(value) {
  if (value === undefined) {
    throw new TypeError("canonicalJson: undefined is not valid JSON");
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("canonicalJson: non-finite number is not valid JSON");
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
}

export function stableHash(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

// 溯源是批准上下文的一部分，而不是模型卡片文案。保留任意 JSON 以便审计，
// 但卡片永不渲染其中的原始字符串（它们可能来自不可信内容）。
export function canonicalizeProvenanceManifest(manifest) {
  if (manifest == null) return { json: null, hash: null };
  const json = canonicalJson(manifest);
  if (Buffer.byteLength(json, "utf8") > 16 * 1024) throw new Error("provenance manifest 过大（上限 16KiB）");
  return { json, hash: stableHash(manifest) };
}

// 卡片只给出固定、短的安全提示；绝不把 manifest 的 source/risk/original_text 原样带上卡。
export function provenanceCardSummary(manifestHash) {
  // 只渲染服务端固定词，manifest 原文（含 source/risk/text 等）绝不能进卡片。
  return manifestHash
    ? { source: "已绑定服务端溯源记录", risk: "请核对权威预览后确认" }
    : { source: "无附加溯源记录", risk: "请核对权威预览后确认" };
}

function previewText(value) {
  // action payload 可能含模型或用户输入；保留真实值，但编码为纯文本，不能借 Markdown 改写预览结构。
  return String(value ?? "未提供")
    .replace(/\\/g, "\\\\")
    .replace(/[`{}\[\]<>|]/g, "\\$&")
    .replace(/[\r\n]+/g, " ");
}

function previewTarget(value, fallback = "未指定") {
  return value ? previewText(value) : fallback;
}

// 由 canonical action payload 唯一生成。它是确认的权威依据，不能由模型文案替代。
export function buildAuthoritativePreview(actions) {
  const lines = [`**操作数量**：${actions.length}`];
  for (const [index, action] of actions.entries()) {
    const p = action.payload ?? {};
    let detail;
    switch (action.kind) {
      case "create_task":
        detail = `目标：负责人 ${previewTarget(p.assignee_open_id, "待确认人选择")}；参数：任务「${previewText(p.title)}」${p.due_date ? `，截止 ${previewText(p.due_date)}` : "，无截止时间"}`;
        break;
      case "notify_task_assignee":
        detail = `目标：负责人 ${previewTarget(p.to_open_id, "待确认人选择")}；参数：任务「${previewText(p.title)}」${p.due_date ? `，截止 ${previewText(p.due_date)}` : ""}，来源任务 ${previewText(p.source_task_action_key)}`;
        break;
      case "create_event":
        detail = `目标：参与人 ${p.attendee_open_ids?.length ? p.attendee_open_ids.map(previewText).join("、") : "无"}；参数：${previewText(p.summary)}；时间：${previewText(p.start_time)} 至 ${previewText(p.end_time)}`;
        break;
      case "send_dm":
        detail = `目标：${previewTarget(p.to_open_id, "待确认人选择")}；参数：卡片引用 ${previewText(p.card_ref)}`;
        break;
      case "send_group_msg":
        detail = `目标：群 ${previewText(p.chat_id)}；参数：卡片引用 ${previewText(p.card_ref)}`;
        break;
      case "schedule_reminder":
        detail = `目标：${previewText(p.deliver_to)}；参数：提醒「${previewText(p.text)}」；时间：${previewText(p.due_iso)}`;
        break;
      case "complete_task":
        detail = `目标：任务 ${previewText(p.task_guid)}；参数：标记为完成`;
        break;
      case "update_document":
        detail = `目标：文档 ${previewText(p.doc_token)}；参数：${previewText(p.command)}，基准版本 ${previewText(p.revision_id)}${p.pattern ? `，匹配「${previewText(p.pattern)}」` : ""}${p.block_id ? `，块 ${previewText(p.block_id)}` : ""}；写入内容「${previewText(p.content)}」`;
        break;
      default:
        detail = "参数：受限动作";
    }
    lines.push(`${index + 1}. **${previewText(action.kind)}**（${previewText(action.action_key)}）\n${detail}`);
  }
  return lines.join("\n");
}

export function validateStoredProvenance({ manifestJson, provenanceHash }) {
  if (manifestJson == null) return provenanceHash == null;
  try {
    const manifest = JSON.parse(manifestJson);
    return canonicalizeProvenanceManifest(manifest).hash === provenanceHash;
  } catch {
    return false;
  }
}

function createTaskAction(jobId, item, ordinal) {
  const payload = {
    title: item.task,
    description: "",
    due_date: item.due ?? null,
    assignee_open_id: item.suggested_open_id ?? null,
  };
  const kind = "create_task";
  return {
    action_key: stableHash({ jobId, kind, ordinal, payload }),
    kind,
    payload,
    payload_hash: stableHash(payload),
    target_open_id: payload.assignee_open_id,
    ordinal,
    requires_open_id: item.confidence === "low" || !isValidOpenId(payload.assignee_open_id),
  };
}

export function buildTaskNotificationAction({ jobId, taskActionKey, toOpenId, title, description = "", dueDate = null, ordinal, actionKey = null }) {
  const payload = {
    source_task_action_key: taskActionKey,
    to_open_id: isValidOpenId(toOpenId) ? toOpenId : null,
    title: String(title ?? ""),
    description: String(description ?? ""),
    due_date: dueDate ?? null,
    template_version: 1,
  };
  if (!payload.source_task_action_key || !payload.title.trim()) throw new Error("notify_task_assignee 缺来源任务或标题");
  const kind = "notify_task_assignee";
  return {
    action_key: actionKey ?? stableHash({ jobId, kind, ordinal, payload }),
    kind,
    payload,
    payload_hash: stableHash(payload),
    target_open_id: payload.to_open_id,
    ordinal,
    requires_open_id: false,
  };
}

// ---- D1: agent 意图通用规范化（类型封闭，每类 payload 形状由服务端定）----

const isIso = (v) => typeof v === "string" && v.length >= 10 && !Number.isNaN(Date.parse(v));

const AGENT_PAYLOADS = {
  create_task(p) {
    if (typeof p.title !== "string" || !p.title.trim()) throw new Error("create_task 缺 title");
    const assignee = isValidOpenId(p.assignee_open_id) ? p.assignee_open_id : null;
    return {
      payload: { title: p.title, description: String(p.description ?? ""), due_date: p.due_date ?? null, assignee_open_id: assignee },
      targetOpenId: assignee,
      requiresOpenId: !assignee,
    };
  },
  send_dm(p) {
    const to = isValidOpenId(p.to_open_id) ? p.to_open_id : null;
    if (typeof p.card_ref !== "string" || !p.card_ref) throw new Error("send_dm 缺 card_ref");
    return { payload: { to_open_id: to, card_ref: p.card_ref }, targetOpenId: to, requiresOpenId: !to };
  },
  create_event(p) {
    if (typeof p.summary !== "string" || !p.summary.trim()) throw new Error("create_event 缺 summary");
    if (!isIso(p.start_time) || !isIso(p.end_time)) throw new Error("create_event 时间必须为 ISO 8601");
    const ids = Array.isArray(p.attendee_open_ids) ? p.attendee_open_ids : [];
    if (!ids.every(isValidOpenId)) throw new Error("create_event 含非法 attendee open_id");
    return {
      payload: { summary: p.summary, start_time: p.start_time, end_time: p.end_time, attendee_open_ids: [...ids].sort() },
      targetOpenId: ids[0] ?? null,
      requiresOpenId: false,
    };
  },
  send_group_msg(p) {
    if (typeof p.chat_id !== "string" || !/^oc_[a-zA-Z0-9]+$/.test(p.chat_id)) throw new Error(`send_group_msg 非法 chat_id: ${p.chat_id}`);
    if (typeof p.card_ref !== "string" || !p.card_ref) throw new Error("send_group_msg 缺 card_ref");
    return { payload: { chat_id: p.chat_id, card_ref: p.card_ref }, targetOpenId: null, requiresOpenId: false };
  },
  // Task 4B：跨会话提醒。payload 闭合 {deliver_to, due_iso, text}；due 统一规范成 UTC toISOString,
  // 等价 offset 同意图同 hash。owner 不在 payload 里——执行时取 confirm flow 的 authoritative sessionKey。
  complete_task(p) {
    const allowed = new Set(["task_guid"]);
    for (const k of Object.keys(p)) {
      if (!allowed.has(k)) throw new Error(`complete_task 未知字段: ${k}（payload 闭合）`);
    }
    if (typeof p.task_guid !== "string" || !p.task_guid.trim()) throw new Error("complete_task task_guid 必填");
    const taskGuid = p.task_guid.trim();
    if (taskGuid.length > 256 || /[\u0000-\u001f\u007f]/.test(taskGuid)) throw new Error("complete_task 非法 task_guid");
    return { payload: { task_guid: taskGuid }, targetOpenId: null, requiresOpenId: false };
  },
  update_document(p) {
    const allowed = new Set(["doc_token", "command", "content", "revision_id", "pattern", "block_id", "doc_format"]);
    for (const k of Object.keys(p)) {
      if (!allowed.has(k)) throw new Error(`update_document 未知字段: ${k}（payload 闭合）`);
    }
    const docToken = typeof p.doc_token === "string" ? p.doc_token.trim() : "";
    if (!isValidDocToken(docToken)) throw new Error("update_document 非法 doc_token");
    const command = String(p.command ?? "");
    if (!new Set(["append", "str_replace", "block_insert_after", "block_replace"]).has(command)) {
      throw new Error(`update_document 不支持 command: ${command}`);
    }
    const docFormat = p.doc_format == null ? "markdown" : String(p.doc_format);
    if (!new Set(["xml", "markdown"]).has(docFormat)) throw new Error(`update_document 非法 doc_format: ${docFormat}`);
    if (!Number.isSafeInteger(p.revision_id) || p.revision_id < 0) throw new Error("update_document revision_id 必须为读取所得非负整数");
    if (typeof p.content !== "string") throw new Error("update_document content 必须为字符串");
    if (p.content.includes(" ")) throw new Error("update_document content 含非法控制字符");
    if (Buffer.byteLength(p.content, "utf8") > DOCUMENT_CONTENT_MAX_BYTES) throw new Error(`update_document content 超长（上限 ${DOCUMENT_CONTENT_MAX_BYTES} bytes）`);
    let pattern = null;
    let blockId = null;
    if (command === "str_replace") {
      if (typeof p.pattern !== "string" || !p.pattern) throw new Error("update_document str_replace 缺 pattern");
      if (p.pattern.includes(" ") || Buffer.byteLength(p.pattern, "utf8") > DOCUMENT_PATTERN_MAX_BYTES) throw new Error("update_document pattern 非法或过长");
      pattern = p.pattern;
    } else if (command === "block_insert_after" || command === "block_replace") {
      if (typeof p.block_id !== "string" || !/^(?:-1|[a-zA-Z0-9_-]{6,256})$/.test(p.block_id)) throw new Error("update_document block 操作缺合法 block_id");
      blockId = p.block_id;
    }
    return {
      payload: { doc_token: docToken, command, content: p.content, revision_id: p.revision_id, pattern, block_id: blockId, doc_format: docFormat },
      targetOpenId: null,
      requiresOpenId: false,
    };
  },
  schedule_reminder(p) {
    const allowed = new Set(["deliver_to", "due_iso", "text"]);
    for (const k of Object.keys(p)) {
      if (!allowed.has(k)) throw new Error(`schedule_reminder 未知字段: ${k}（payload 闭合）`);
    }
    const deliverTo = canonicalDeliverableKey(p.deliver_to);
    if (!deliverTo) {
      throw new Error(`schedule_reminder 非法 deliver_to: ${JSON.stringify(p.deliver_to)}（仅 canonical feishu:p2p:*/feishu:group:*）`);
    }
    const epochMs = parseStrictIsoWithTimezone(p.due_iso);
    if (epochMs === null) {
      throw new Error(`schedule_reminder 非法 due_iso: ${JSON.stringify(p.due_iso)}（需带时区的严格 ISO 8601）`);
    }
    if (typeof p.text !== "string" || !p.text.trim()) throw new Error("schedule_reminder text 必填（非空字符串）");
    if (p.text.includes("\u0000")) throw new Error("schedule_reminder text 含非法控制字符");
    if (p.text.length > REMINDER_TEXT_MAX) throw new Error(`schedule_reminder text 超长（上限 ${REMINDER_TEXT_MAX} 字符）`);
    return {
      payload: { deliver_to: deliverTo, due_iso: new Date(epochMs).toISOString(), text: p.text },
      targetOpenId: null,
      requiresOpenId: false,
    };
  },
};

const REMINDER_TEXT_MAX = 4000;   // 与 heartbeat 队列 TEXT_MAX 对齐
const DOCUMENT_CONTENT_MAX_BYTES = 8 * 1024;
const DOCUMENT_PATTERN_MAX_BYTES = 2 * 1024;

export function buildAgentAction({ jobId, kind, payload, ordinal = 0 }) {
  const normalizer = AGENT_PAYLOADS[kind];
  if (!normalizer) throw new Error(`未知 action kind: ${kind}（类型封闭）`);
  const { payload: canonical, targetOpenId, requiresOpenId } = normalizer(payload ?? {});
  return {
    action_key: stableHash({ jobId, kind, ordinal, payload: canonical }),
    kind,
    payload: canonical,
    payload_hash: stableHash(canonical),
    target_open_id: targetOpenId,
    ordinal,
    requires_open_id: requiresOpenId,
  };
}

export function canonicalizeActions({ jobId, items, notificationMode = "none" }) {
  if (!["card", "feishu_system", "none"].includes(notificationMode)) {
    throw new Error(`未知会议任务通知模式: ${notificationMode}`);
  }
  const actions = [];
  let ord = 0;
  for (const item of items) {
    const task = createTaskAction(jobId, item, ord++);
    actions.push(task);
    if (notificationMode === "card") {
      actions.push(buildTaskNotificationAction({
        jobId,
        taskActionKey: task.action_key,
        toOpenId: task.payload.assignee_open_id,
        title: task.payload.title,
        description: task.payload.description,
        dueDate: task.payload.due_date,
        ordinal: ord++,
      }));
    }
  }
  return actions;
}

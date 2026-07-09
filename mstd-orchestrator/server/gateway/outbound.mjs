// 唯一出站通道：只认具名参数拼 argv 白名单；5.5 裸文本永远进不了这里（结构性强制在 turn-handler/brain）。

const CHAT_ID = /^oc_[a-zA-Z0-9]+$/;
const OPEN_ID = /^ou_[a-zA-Z0-9]+$/;
const MESSAGE_ID = /^om_[a-zA-Z0-9]+$/;

export function createOutbound({ runLark }) {
  async function exec(argv, what) {
    const r = await runLark(argv);
    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch { /* 下面统一判错 */ }
    if (r.exitCode !== 0 || !parsed?.ok) {
      throw new Error(`${what}失败: exit=${r.exitCode} ${String(r.stderr || r.stdout).slice(0, 300)}`);
    }
    return parsed.data ?? {};
  }

  async function sendMessage({ chatId, openId, text, idempotencyKey }) {
    if (typeof text !== "string" || !text.trim()) throw new Error("text 必填");
    if (!idempotencyKey) throw new Error("idempotencyKey 必填");
    const argv = ["im", "+messages-send", "--as", "bot"];
    if (chatId) {
      if (!CHAT_ID.test(chatId)) throw new Error(`非法 chatId: ${chatId}`);
      argv.push("--chat-id", chatId);
    } else if (openId) {
      if (!OPEN_ID.test(openId)) throw new Error(`非法 openId: ${openId}`);
      argv.push("--user-id", openId);
    } else {
      throw new Error("chatId/openId 必须给一个");
    }
    argv.push("--text", text, "--idempotency-key", idempotencyKey, "--json");
    const data = await exec(argv, "发送");
    return { messageId: data.message_id ?? null, chatId: data.chat_id ?? chatId ?? null };
  }

  // 交互卡片发送（结构由服务端模板生成，模型碰不到）
  async function sendCard({ chatId, openId, cardJson, idempotencyKey }) {
    if (!cardJson || typeof cardJson !== "object") throw new Error("cardJson 必填");
    if (!idempotencyKey) throw new Error("idempotencyKey 必填");
    const argv = ["im", "+messages-send", "--as", "bot"];
    if (chatId) {
      if (!CHAT_ID.test(chatId)) throw new Error(`非法 chatId: ${chatId}`);
      argv.push("--chat-id", chatId);
    } else if (openId) {
      if (!OPEN_ID.test(openId)) throw new Error(`非法 openId: ${openId}`);
      argv.push("--user-id", openId);
    } else {
      throw new Error("chatId/openId 必须给一个");
    }
    argv.push("--msg-type", "interactive", "--content", JSON.stringify(cardJson), "--idempotency-key", idempotencyKey, "--json");
    const data = await exec(argv, "发卡");
    return { messageId: data.message_id ?? null, chatId: data.chat_id ?? chatId ?? null };
  }

  // 卡片原地更新（14 天窗口）：PATCH raw API
  async function updateCard({ messageId, cardJson }) {
    if (!MESSAGE_ID.test(messageId ?? "")) throw new Error(`非法 messageId: ${messageId}`);
    const argv = [
      "api", "PATCH", `/open-apis/im/v1/messages/${messageId}`, "--as", "bot",
      "--data", JSON.stringify({ content: JSON.stringify(cardJson) }),
      "--json",
    ];
    await exec(argv, "更卡");
    return { messageId };
  }

  // 文本消息编辑无 shortcut，走 raw API（messageId 已被正则约束，无路径注入面）
  async function editMessage({ messageId, text }) {
    if (!MESSAGE_ID.test(messageId ?? "")) throw new Error(`非法 messageId: ${messageId}`);
    if (typeof text !== "string" || !text.trim()) throw new Error("text 必填");
    const argv = [
      "api", "PUT", `/open-apis/im/v1/messages/${messageId}`, "--as", "bot",
      "--data", JSON.stringify({ msg_type: "text", content: JSON.stringify({ text }) }),
      "--json",
    ];
    await exec(argv, "编辑");
    return { messageId };
  }

  return { sendMessage, editMessage, sendCard, updateCard };
}

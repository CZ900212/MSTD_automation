export class IntentValidationError extends Error {
  constructor(reason) {
    super(`意图校验失败: ${reason}`);
    this.name = "IntentValidationError";
    this.reason = reason;
  }
}

function isStr(v) { return typeof v === "string" && v.length > 0; }

export function validateIntent(raw) {
  if (!raw || typeof raw !== "object") throw new IntentValidationError("不是对象");
  if (!isStr(raw.card_text)) throw new IntentValidationError("缺少 card_text");
  if (!Array.isArray(raw.items)) throw new IntentValidationError("items 必须是数组");

  const items = raw.items.map((it, i) => {
    if (!it || typeof it !== "object") throw new IntentValidationError(`items[${i}] 不是对象`);
    if (!isStr(it.owner_name)) throw new IntentValidationError(`items[${i}] 缺少 owner_name`);
    if (!isStr(it.task)) throw new IntentValidationError(`items[${i}] 缺少 task`);
    if (it.confidence !== "high" && it.confidence !== "low") {
      throw new IntentValidationError(`items[${i}] confidence 必须是 high|low`);
    }
    const due = it.due == null ? null : String(it.due);
    const openId = it.suggested_open_id == null ? null : String(it.suggested_open_id);
    return { owner_name: it.owner_name, task: it.task, due, suggested_open_id: openId, confidence: it.confidence };
  });

  return { card_text: raw.card_text, items };
}

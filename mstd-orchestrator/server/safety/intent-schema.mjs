export class IntentValidationError extends Error {
  constructor(reason) {
    super(`意图校验失败: ${reason}`);
    this.name = "IntentValidationError";
    this.reason = reason;
  }
}

function isStr(v) { return typeof v === "string" && v.length > 0; }

export const MAX_ITEMS = 50;
export const MAX_CARD_TEXT = 4000;
export const MAX_OWNER_NAME = 100;
export const MAX_TASK = 2000;
export const MAX_DUE = 64;
export const MAX_OPEN_ID = 128;

export function validateIntent(raw) {
  if (!raw || typeof raw !== "object") throw new IntentValidationError("不是对象");
  if (!isStr(raw.card_text)) throw new IntentValidationError("缺少 card_text");
  if (raw.card_text.length > MAX_CARD_TEXT) {
    throw new IntentValidationError(`card_text 超长（>${MAX_CARD_TEXT}）`);
  }
  if (!Array.isArray(raw.items)) throw new IntentValidationError("items 必须是数组");
  if (raw.items.length > MAX_ITEMS) {
    throw new IntentValidationError(`items 数量超上限（>${MAX_ITEMS}）`);
  }

  const items = raw.items.map((it, i) => {
    if (!it || typeof it !== "object") throw new IntentValidationError(`items[${i}] 不是对象`);
    if (!isStr(it.owner_name)) throw new IntentValidationError(`items[${i}] 缺少 owner_name`);
    if (it.owner_name.length > MAX_OWNER_NAME) {
      throw new IntentValidationError(`items[${i}] owner_name 超长（>${MAX_OWNER_NAME}）`);
    }
    if (!isStr(it.task)) throw new IntentValidationError(`items[${i}] 缺少 task`);
    if (it.task.length > MAX_TASK) {
      throw new IntentValidationError(`items[${i}] task 超长（>${MAX_TASK}）`);
    }
    if (it.confidence !== "high" && it.confidence !== "low") {
      throw new IntentValidationError(`items[${i}] confidence 必须是 high|low`);
    }

    let due = null;
    if (it.due != null) {
      if (typeof it.due !== "string") {
        throw new IntentValidationError(`items[${i}] due 必须是字符串`);
      }
      if (it.due.length > MAX_DUE) {
        throw new IntentValidationError(`items[${i}] due 超长（>${MAX_DUE}）`);
      }
      due = it.due;
    }

    let openId = null;
    if (it.suggested_open_id != null) {
      if (typeof it.suggested_open_id !== "string") {
        throw new IntentValidationError(`items[${i}] suggested_open_id 必须是字符串`);
      }
      if (it.suggested_open_id.length > MAX_OPEN_ID) {
        throw new IntentValidationError(`items[${i}] suggested_open_id 超长（>${MAX_OPEN_ID}）`);
      }
      if (!/^ou_/.test(it.suggested_open_id)) {
        throw new IntentValidationError(`items[${i}] suggested_open_id 前缀必须是 ou_`);
      }
      openId = it.suggested_open_id;
    }

    return { owner_name: it.owner_name, task: it.task, due, suggested_open_id: openId, confidence: it.confidence };
  });

  return { card_text: raw.card_text, items };
}

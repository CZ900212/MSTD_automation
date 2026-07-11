// 卡片固定模板（Card JSON 2.0）：结构由服务端定死，模型只能填文案槽位（字符串值），
// 无论槽位内容是什么都改变不了卡片结构键集合（模板固定性测试保障）。

const text = (content) => ({ tag: "plain_text", content: String(content) });
const md = (content) => ({ tag: "markdown", content: String(content) });

export function buildConfirmCard({ title, previewMd, actions = [], formFields = [], tokenRef }) {
  const elements = [md(previewMd)];

  for (const a of actions) {
    elements.push(md(a.summaryMd));
  }

  const formElements = [];
  for (const f of formFields) {
    formElements.push({
      tag: "person_select",
      name: `Person_assignee_${f.actionKey}`,
      required: true,
      placeholder: text(f.label ?? "选择负责人"),
    });
  }
  formElements.push({
    tag: "column_set",
    columns: [
      {
        tag: "column",
        elements: [{
          tag: "button",
          name: "confirm_btn",
          text: text("确认执行"),
          type: "primary",
          form_action_type: "submit",
          behaviors: [{ type: "callback", value: { action: "confirm", token_ref: String(tokenRef) } }],
        }],
      },
      {
        tag: "column",
        elements: [{
          tag: "button",
          name: "cancel_btn",
          text: text("取消"),
          type: "default",
          behaviors: [{ type: "callback", value: { action: "cancel", token_ref: String(tokenRef) } }],
        }],
      },
    ],
  });

  elements.push({ tag: "form", name: "confirm_form", elements: formElements });

  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: text(title), template: "blue" },
    body: { elements },
  };
}

// C6 Markdown 消息卡:普通消息命中富 Markdown 时的出站载体——唯一 markdown 元素,
// 模型文本只进 content 槽位,结构键集合冻结(模板固定性测试保障)
export function buildMarkdownMessageCard({ md: content }) {
  return {
    schema: "2.0",
    config: { update_multi: true },
    body: { elements: [md(content)] },
  };
}

const STATE_HEADER = {
  executing: { title: "⏳ 执行中", template: "yellow" },
  done: { title: "✅ 已执行", template: "green" },
  partial_failed: { title: "⚠️ 部分失败", template: "orange" },
  expired: { title: "⌛ 已过期", template: "grey" },
  cancelled: { title: "🚫 已取消", template: "grey" },
};

export function buildStatusCard({ state, resultsMd, retryTokenRef = null }) {
  const head = STATE_HEADER[state];
  if (!head) throw new Error(`未知状态卡 state: ${state}`);
  const elements = [md(resultsMd)];
  if (state === "partial_failed" && retryTokenRef) {
    elements.push({
      tag: "button",
      name: "retry_btn",
      text: text("重试失败条目"),
      type: "primary",
      behaviors: [{ type: "callback", value: { action: "retry", token_ref: String(retryTokenRef) } }],
    });
  }
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: text(head.title), template: head.template },
    body: { elements },
  };
}

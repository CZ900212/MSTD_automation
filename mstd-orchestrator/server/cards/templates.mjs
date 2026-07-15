// 卡片固定模板（Card JSON 2.0）：结构由服务端定死，模型只能填文案槽位（字符串值），
// 无论槽位内容是什么都改变不了卡片结构键集合（模板固定性测试保障）。

const text = (content) => ({ tag: "plain_text", content: String(content) });
const md = (content) => ({ tag: "markdown", content: String(content) });

export function buildConfirmCard({ title, authoritativePreviewMd, previewMd = "", sourceLabel = "未提供溯源记录", riskLabel = "请核对权威预览后确认", actions = [], formFields = [], tokenRef }) {
  // authoritativePreviewMd 只由 canonical action payload 生成，模型 previewMd 只能作为次要说明。
  const elements = [
    md(`**权威操作预览**\n${String(authoritativePreviewMd ?? "")}`),
    md(`**来源**：${String(sourceLabel)}　**风险提示**：${String(riskLabel)}`),
  ];
  if (previewMd) elements.push(md(`**补充说明（不作为批准依据）**\n${String(previewMd)}`));

  for (const a of actions) {
    elements.push(md(a.summaryMd));
  }

  const formElements = [];
  for (const f of formFields) {
    formElements.push({
      tag: "select_person",   // 卡片 JSON 2.0 的人员单选组件（写成 person_select 会被 200621 拒收）
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

export function buildTaskNotificationCard({ title, description = "", dueDate = null }) {
  const lines = [`**任务名称**\n${String(title)}`];
  if (dueDate) lines.push(`**截止时间**\n${String(dueDate)}`);
  if (description) lines.push(`**任务说明**\n${String(description)}`);
  lines.push("该任务已在飞书任务中创建，请到任务中心查看和处理。");
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: text("任务通知"), template: "blue" },
    body: { elements: [md(lines.join("\n\n"))] },
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

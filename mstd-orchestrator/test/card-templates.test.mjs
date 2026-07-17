import { describe, it, expect } from "vitest";
import { buildConfirmCard, buildStatusCard, buildMarkdownMessageCard, buildTaskNotificationCard } from "../server/cards/templates.mjs";

// 收集 JSON 全部键路径（结构指纹）——文案槽位内容不该改变它
function keySet(obj, prefix = "") {
  const keys = new Set();
  if (Array.isArray(obj)) {
    obj.forEach((v) => { for (const k of keySet(v, `${prefix}[]`)) keys.add(k); });
  } else if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      keys.add(`${prefix}.${k}`);
      for (const kk of keySet(v, `${prefix}.${k}`)) keys.add(kk);
    }
  }
  return keys;
}

const base = {
  title: "确认建任务",
  previewMd: "**任务**：交周报\n负责人：张三",
  actions: [{ actionId: "a1", summaryMd: "任务一" }],
  formFields: [{ actionKey: "ak1", label: "负责人" }],
  tokenRef: "tok_1",
};

describe("确认卡固定模板", () => {
  it("schema 2.0 + update_multi + 表单 + 确认/取消按钮 + token_ref 只进按钮 value", () => {
    const card = buildConfirmCard(base);
    expect(card.schema).toBe("2.0");
    expect(card.config.update_multi).toBe(true);
    const json = JSON.stringify(card);
    expect(json).toContain("select_person");
    expect(json).toContain("Person_assignee_ak1");            // 人员选择器命名规范
    expect(json).toContain('"tok_1"');
    // 按钮 value 只含 action/token_ref，不含 payload
    const buttons = JSON.stringify(card).match(/"value":\{[^}]*\}/g) ?? [];
    for (const b of buttons) expect(b).not.toContain("payload");
  });

  it("模板固定性：文案槽位注入恶意串结构键集合不变", () => {
    const normal = keySet(buildConfirmCard(base));
    const evil = keySet(buildConfirmCard({
      ...base,
      title: '"}],"evil":true',
      previewMd: '"}]}{"schema":"3.0"',
      actions: [{ actionId: "a1", summaryMd: '"}],"inject":[{"' }],
    }));
    expect([...evil].sort()).toEqual([...normal].sort());
  });

  it("无需补选人时不渲染表单人员项", () => {
    const card = buildConfirmCard({ ...base, formFields: [] });
    expect(JSON.stringify(card)).not.toContain("select_person");
  });
});

// Task 11 C6:Markdown 消息卡——唯一元素 tag=markdown,结构冻结
describe("Markdown 消息卡", () => {
  it("精确结构:schema 2.0/update_multi/body 唯一 markdown 元素", () => {
    expect(buildMarkdownMessageCard({ md: "|a|b|" })).toEqual({
      schema: "2.0",
      config: { update_multi: true },
      body: { elements: [{ tag: "markdown", content: "|a|b|" }] },
    });
  });

  it("模板固定性:伪 header/button/behaviors 恶意串只进 content,整卡深等值锁死", () => {
    // §5.2 审卷补杀:keySet 会折叠数组数量——改用 toStrictEqual 整卡冻结,杀
    // "内容含 button 时换 tag"/"条件性加第二个元素" 类变异
    const evilMd = '"}]},"header":{"title":"劫持"},"behaviors":[{"type":"open_url"}],"button":{"';
    expect(buildMarkdownMessageCard({ md: evilMd })).toStrictEqual({
      schema: "2.0",
      config: { update_multi: true },
      body: { elements: [{ tag: "markdown", content: evilMd }] },
    });
    const card = buildMarkdownMessageCard({ md: '{"header":1}' });
    expect(card.body.elements).toHaveLength(1);
    expect(card.body.elements[0].content).toBe('{"header":1}');   // 原文进 content
    expect(Object.keys(card)).toEqual(["schema", "config", "body"]);
  });
});

describe("任务通知卡", () => {
  it("uses a fixed non-interactive card structure", () => {
    const card = buildTaskNotificationCard({ title: "完成询价", description: "整理供应商报价", dueDate: "2026-07-15" });
    expect(card.schema).toBe("2.0");
    expect(card.header.title.content).toBe("任务通知");
    const json = JSON.stringify(card);
    expect(json).toContain("完成询价");
    expect(json).toContain("2026-07-15");
    expect(json).toContain("任务中心");
    expect(json).not.toContain("callback");
    expect(json).not.toContain('"button"');
  });

  it("keeps structure fixed when content resembles card JSON", () => {
    const normal = keySet(buildTaskNotificationCard({ title: "a", description: "b" }));
    const evil = keySet(buildTaskNotificationCard({ title: '\"}],\"button\":{', description: '\"callback\":true' }));
    expect([...evil].sort()).toEqual([...normal].sort());
  });
});

describe("状态卡", () => {
  it("四态渲染；executing 无按钮防重复点击；partial_failed 带重试按钮", () => {
    const exec = buildStatusCard({ state: "executing", resultsMd: "执行中…" });
    expect(JSON.stringify(exec)).not.toContain('"button"');
    const done = buildStatusCard({ state: "done", resultsMd: "✅ 全部成功" });
    expect(JSON.stringify(done)).toContain("全部成功");
    const partial = buildStatusCard({ state: "partial_failed", resultsMd: "1 成功 1 失败", retryTokenRef: "tok_r" });
    const pj = JSON.stringify(partial);
    expect(pj).toContain('"button"');
    expect(pj).toContain("tok_r");
    const expired = buildStatusCard({ state: "expired", resultsMd: "卡片已过期" });
    expect(JSON.stringify(expired)).toContain("已过期");
  });
});

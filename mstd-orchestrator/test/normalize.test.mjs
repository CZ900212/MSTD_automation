// Task 5 C2：入站 @ 单趟规范化——结构化 @_user_N 与纯文本 bot 名同源(同一 alternation、
// 同一次 replace)检测/替换。只改 mention token,不 trim、不折叠任何空白。
import { describe, it, expect } from "vitest";
import { buildBotNames, normalizeIncoming } from "../server/gateway/normalize.mjs";

describe("buildBotNames", () => {
  it("主名+aliases 去重去空、按最长优先", () => {
    const names = buildBotNames({ MSTD_BOT_NAME: "小达", MSTD_BOT_ALIASES: "user613148's Feishu CLI, 小达 , " });
    expect(names).toEqual(["user613148's Feishu CLI", "小达"]);
  });
  it("全空环境返回空数组", () => {
    expect(buildBotNames({})).toEqual([]);
  });
  it("排序键是长度：与插入序、字典序都冲突的数据仍按最长优先", () => {
    const names = buildBotNames({ MSTD_BOT_NAME: "甲甲", MSTD_BOT_ALIASES: "乙,丙丙丙" });
    expect(names).toEqual(["丙丙丙", "甲甲", "乙"]);
  });
});

describe("normalizeIncoming", () => {
  const ctx = (over = {}) => ({ botNames: ["user613148's Feishu CLI", "小达"], botOpenId: "ou_bot", mentions: [], ...over });

  it.each([
    ["主名", "@小达 汇报一下", "[@我] 汇报一下"],
    ["旧名(含撇号与空格)", "@user613148's Feishu CLI 在吗", "[@我] 在吗"],
    ["句尾主名", "都问过 @小达", "都问过 [@我]"],
  ])("纯文本 %s → [@我] 且 mentionsBot=true", (_l, input, want) => {
    const r = normalizeIncoming(input, ctx());
    expect(r.content).toBe(want);
    expect(r.mentionsBot).toBe(true);
  });

  it("含正则元字符名整体转义;非 mention 空白逐字节保留", () => {
    const r = normalizeIncoming("  @C+(测)  \t在吗  ", ctx({ botNames: ["C+(测)"] }));
    expect(r.content).toBe("  [@我]  \t在吗  ");
    expect(r.mentionsBot).toBe(true);
  });

  it("@_user_10 不被 @_user_1 截断;他人结构化 mention 保留名字", () => {
    const mentions = [
      { key: "@_user_1", id: { open_id: "ou_bot" }, name: "小达" },
      { key: "@_user_10", id: { open_id: "ou_zhang" }, name: "张三" },
    ];
    const r = normalizeIncoming("@_user_10 跟进 @_user_1 的事", ctx({ mentions }));
    expect(r.content).toBe("@张三 跟进 [@我] 的事");
    expect(r.mentionsBot).toBe(true);
  });

  it("结构化 mention 全是他人:mentionsBot=false 但名字照样还原", () => {
    const mentions = [{ key: "@_user_1", id: { open_id: "ou_li" }, name: "李四" }];
    const r = normalizeIncoming("@_user_1 看下", ctx({ mentions }));
    expect(r).toEqual({ content: "@李四 看下", mentionsBot: false });
  });

  it("@小达人 单独出现:不替换不点名(级联替换事故防线)", () => {
    const r = normalizeIncoming("@小达人 是谁", ctx());
    expect(r).toEqual({ content: "@小达人 是谁", mentionsBot: false });
  });

  it("@小达人 与合法 @小达 共存:只替换后者", () => {
    const r = normalizeIncoming("@小达人 和 @小达 都在", ctx());
    expect(r.content).toBe("@小达人 和 [@我] 都在");
    expect(r.mentionsBot).toBe(true);
  });

  it("无 mention / 空输入不 trim 不改写", () => {
    expect(normalizeIncoming("  纯聊天  ", ctx())).toEqual({ content: "  纯聊天  ", mentionsBot: false });
    expect(normalizeIncoming("", ctx())).toEqual({ content: "", mentionsBot: false });
  });

  // ---- §5.1 审核补杀 ----

  it("裸字符串 id 的 mention 对象：bot 判定与替换同源（检测/替换不分脑）", () => {
    const mentions = [{ key: "@_user_1", id: "ou_bot", name: "小达" }];
    const r = normalizeIncoming("你好 @_user_1", ctx({ mentions }));
    expect(r.content).toBe("你好 [@我]");
    expect(r.mentionsBot).toBe(true);
  });

  it.each([
    ["下划线后继（别的用户名）", "@小达_人 在"],
    ["邮箱域名", "邮件发 foo@小达.com"],
    ["左侧粘连字母", "abc@小达 hi"],
  ])("边界洞封堵：%s 不替换不点名", (_l, input) => {
    const r = normalizeIncoming(input, ctx());
    expect(r.content).toBe(input);
    expect(r.mentionsBot).toBe(false);
  });

  it("句首/空格后的 @小达 仍正常命中（左边界不误伤）", () => {
    expect(normalizeIncoming("@小达 早", ctx()).content).toBe("[@我] 早");
    expect(normalizeIncoming("大家问 @小达 吧", ctx()).content).toBe("大家问 [@我] 吧");
  });

  it("中文粘连 @（飞书选人无空格的真实形态）必须放行", () => {
    const r = normalizeIncoming("问@小达 一下", ctx());
    expect(r.content).toBe("问[@我] 一下");
    expect(r.mentionsBot).toBe(true);
  });

  it("结构化 key 有 metadata 背书：ASCII 粘连也照样替换（不加左边界）", () => {
    const mentions = [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "小达" }];
    const r = normalizeIncoming("hi@_user_1 look", ctx({ mentions }));
    expect(r.content).toBe("hi[@我] look");
    expect(r.mentionsBot).toBe(true);
  });

  it("畸形重复 key：按首个 mention 归属，不被后者覆盖（含 bot 标志位）", () => {
    const dup = (a, b) => normalizeIncoming("@_user_1 看下", ctx({
      mentions: [a, b].map(([openId, name]) => ({ key: "@_user_1", id: { open_id: openId }, name })),
    }));
    expect(dup(["ou_a", "甲"], ["ou_b", "乙"])).toEqual({ content: "@甲 看下", mentionsBot: false });
    // bot 在后被丢弃：文本与标志都跟首个,不许"文本跟甲、标志 OR 上 bot"的半吊子
    expect(dup(["ou_a", "甲"], ["ou_bot", "小达"])).toEqual({ content: "@甲 看下", mentionsBot: false });
    // bot 在前：正常点名
    expect(dup(["ou_bot", "小达"], ["ou_a", "甲"])).toEqual({ content: "[@我] 看下", mentionsBot: true });
  });

  // ---- §5.2 审卷补杀 ----

  it("混合来源同一 alternation：结构化他人 + 纯文本 bot 名同句各归其位", () => {
    const mentions = [{ key: "@_user_1", id: { open_id: "ou_zhang" }, name: "张三" }];
    const r = normalizeIncoming("@_user_1 与 @小达 对一下", ctx({ mentions }));
    expect(r.content).toBe("@张三 与 [@我] 对一下");
    expect(r.mentionsBot).toBe(true);
  });

  it("单趟 replace 不级联：他人恰好名叫小达,还原出的 @小达 不得再被二次替换", () => {
    const mentions = [{ key: "@_user_1", id: { open_id: "ou_other" }, name: "小达" }];
    const r = normalizeIncoming("@_user_1 hi", ctx({ mentions }));
    expect(r).toEqual({ content: "@小达 hi", mentionsBot: false });
  });

  it("(?!\\d) 独立生效：只有 @_user_1 metadata 时 @_user_10 原样保留", () => {
    const mentions = [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "小达" }];
    const r = normalizeIncoming("@_user_10 先看", ctx({ mentions, botNames: [] }));
    expect(r).toEqual({ content: "@_user_10 先看", mentionsBot: false });
  });

  it("名字互为前缀时最长优先与入参顺序无关", () => {
    const r = normalizeIncoming("@A-B hi", ctx({ botNames: ["A", "A-B"] }));
    expect(r.content).toBe("[@我] hi");
    expect(r.mentionsBot).toBe(true);
  });

  it.each([
    ["左侧数字", "1@小达 在"],
    ["左侧下划线", "_@小达 在"],
    ["右侧数字（别的用户名）", "@小达2 在"],
  ])("边界字符类完整：%s 不替换不点名", (_l, input) => {
    expect(normalizeIncoming(input, ctx())).toEqual({ content: input, mentionsBot: false });
  });

  it("合法标点后继照常命中（右边界不得过严成仅空白/句尾）", () => {
    const r = normalizeIncoming("@小达，处理下", ctx());
    expect(r.content).toBe("[@我]，处理下");
    expect(r.mentionsBot).toBe(true);
  });

  it.each([["A|B"], ["A$"], ["A[1]"], ["A^B"], ["A\\B"]])("escapeRe 全元字符覆盖：名字 %s 整体转义", (name) => {
    const r = normalizeIncoming(`@${name} hi`, ctx({ botNames: [name] }));
    expect(r.content).toBe("[@我] hi");
    expect(r.mentionsBot).toBe(true);
  });
});

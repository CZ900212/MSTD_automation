import { describe, it, expect } from "vitest";
import { buildLarkReadArgs, READ_OP_NAMES } from "../server/safety/lark-read.mjs";

describe("buildLarkReadArgs", () => {
  it("search_minutes -> minutes +search read argv", () => {
    expect(buildLarkReadArgs("search_minutes")).toEqual([
      "minutes", "+search", "--owner-ids", "me", "--as", "user",
    ]);
  });

  it("get_transcript requires minute_token and maps to +detail", () => {
    expect(buildLarkReadArgs("get_transcript", { minute_token: "mt_1" })).toEqual([
      "minutes", "+detail", "--minute-tokens", "mt_1",
      "--transcript", "--as", "user", "--output-dir", "./out",
    ]);
  });

  it("search_user uses --query (name search), not --user-ids", () => {
    const argv = buildLarkReadArgs("search_user", { query: "张三" });
    expect(argv).toEqual([
      "contact", "+search-user", "--query", "张三", "--as", "user",
    ]);
    expect(argv).not.toContain("--user-ids");
  });

  it("rejects unknown op (deny-by-default)", () => {
    expect(() => buildLarkReadArgs("delete_everything")).toThrow(/unknown|不允许/i);
  });

  it("rejects missing required param", () => {
    expect(() => buildLarkReadArgs("get_transcript")).toThrow(/minute_token/);
  });

  it("never produces write verbs", () => {
    for (const op of ["search_minutes", "search_user", "get_transcript"]) {
      const params = op === "get_transcript" ? { minute_token: "x" } : { query: "x" };
      const joined = buildLarkReadArgs(op, params).join(" ");
      expect(joined).not.toMatch(/\+create|messages-send|--yes|delete|recall/);
    }
  });

  it("read_file 不进 lark-cli 白名单（buildLarkReadArgs 拒绝）", () => {
    expect(() => buildLarkReadArgs("read_file", { path: "out/a.txt" })).toThrow(/不允许/);
  });
});

describe("buildLarkReadArgs 全域扩容（迭代二 T1.2）", () => {
  it("chat_history：chat_id 必填且校验 oc_ 格式，分页/时间窗可选", () => {
    expect(buildLarkReadArgs("chat_history", { chat_id: "oc_b67c4510743e68be6a9a91f3906e7f97" })).toEqual([
      "im", "+chat-messages-list", "--chat-id", "oc_b67c4510743e68be6a9a91f3906e7f97",
      "--page-size", "30", "--as", "user",
    ]);
    const withPage = buildLarkReadArgs("chat_history", {
      chat_id: "oc_abc123", page_token: "pt1", start: "2026-07-01T00:00:00+08:00", page_size: 10,
    });
    expect(withPage).toContain("--page-token");
    expect(withPage).toContain("pt1");
    expect(withPage).toContain("--start");
    expect(() => buildLarkReadArgs("chat_history", { chat_id: "om_notachat" })).toThrow(/非法 chat_id/);
    expect(() => buildLarkReadArgs("chat_history", { chat_id: "oc_x; rm -rf" })).toThrow(/非法 chat_id/);
    expect(() => buildLarkReadArgs("chat_history", {})).toThrow(/chat_id 必填/);
  });

  it("page_size 越界拒绝", () => {
    expect(() => buildLarkReadArgs("chat_history", { chat_id: "oc_abc", page_size: 999 })).toThrow(/1-50/);
    expect(() => buildLarkReadArgs("list_chats", { page_size: 0 })).toThrow(/1-100/);
  });

  it("read_doc 固定 im-markdown 输出；search_docs/search_messages 必填 query", () => {
    expect(buildLarkReadArgs("read_doc", { doc: "https://x.feishu.cn/docx/AbCdEf" })).toEqual([
      "docs", "+fetch", "--doc", "https://x.feishu.cn/docx/AbCdEf", "--doc-format", "im-markdown", "--as", "user",
    ]);
    expect(() => buildLarkReadArgs("search_docs", {})).toThrow(/query 必填/);
    expect(() => buildLarkReadArgs("search_messages", {})).toThrow(/query 必填/);
  });

  it("agenda/search_events/my_tasks 无必填参数可裸调", () => {
    expect(buildLarkReadArgs("agenda")).toEqual(["calendar", "+agenda", "--as", "user"]);
    expect(buildLarkReadArgs("search_events")).toEqual(["calendar", "+search-event", "--as", "user"]);
    expect(buildLarkReadArgs("my_tasks")).toEqual(["task", "+get-my-tasks", "--as", "user"]);
    expect(buildLarkReadArgs("my_tasks", { complete: "false" })).toContain("--complete");
    expect(buildLarkReadArgs("my_tasks", { complete: "梅花" })).not.toContain("--complete");   // 非 bool 串丢弃
  });

  it("sheet_cells/base_records 多必填参数", () => {
    expect(buildLarkReadArgs("sheet_cells", { spreadsheet_token: "shtx", sheet_id: "s1", range: "A1:F10" }))
      .toEqual(["sheets", "+cells-get", "--spreadsheet-token", "shtx", "--sheet-id", "s1", "--range", "A1:F10", "--as", "user"]);
    expect(() => buildLarkReadArgs("sheet_cells", { spreadsheet_token: "x" })).toThrow(/sheet_id 必填/);
    expect(buildLarkReadArgs("base_records", { base_token: "bas1", table_id: "tbl1" }))
      .toEqual(["base", "+record-list", "--base-token", "bas1", "--table-id", "tbl1", "--limit", "50", "--as", "user"]);
  });

  it("attendance：data JSON 服务端拼装，日期必须是 YYYYMMDD 整数", () => {
    const argv = buildLarkReadArgs("attendance", { user_id: "emp1", date_from: 20260701, date_to: 20260712 });
    expect(argv.slice(0, 3)).toEqual(["attendance", "user_tasks", "query"]);
    const data = JSON.parse(argv[argv.indexOf("--data") + 1]);
    expect(data).toEqual({ user_ids: ["emp1"], check_date_from: 20260701, check_date_to: 20260712 });
    expect(() => buildLarkReadArgs("attendance", { user_id: "e", date_from: 202607, date_to: 20260712 })).toThrow(/date_from/);
    expect(() => buildLarkReadArgs("attendance", { user_id: "e" })).toThrow(/必填/);
  });

  it("get_user：user_id 须为 ou_ 开头，缺省查自己", () => {
    expect(buildLarkReadArgs("get_user")).toEqual(["contact", "+get-user", "--as", "user"]);
    expect(buildLarkReadArgs("get_user", { user_id: "ou_abc123" })).toContain("--user-id-type");
    expect(() => buildLarkReadArgs("get_user", { user_id: "not_ou" })).toThrow(/非法 user_id/);
  });

  it("全部 op 恒为 --as user 且绝不产生写动词/自由 args", () => {
    const fill = {
      minute_token: "m", query: "q", chat_id: "oc_abc", doc: "d", space_id: "s", node_token: "n",
      spreadsheet_token: "st", sheet_id: "si", range: "A1:B2", base_token: "bt", table_id: "ti",
      user_id: "ou_abc", message_id: "mi", date_from: 20260701, date_to: 20260712,
    };
    for (const op of READ_OP_NAMES) {
      const argv = buildLarkReadArgs(op, op === "attendance" ? { user_id: "e1", date_from: 20260701, date_to: 20260712 } : fill);
      expect(argv).toContain("--as");
      expect(argv[argv.indexOf("--as") + 1]).toBe("user");
      const joined = argv.join(" ");
      expect(joined).not.toMatch(/\+create|\+send|messages-send|--yes|delete|recall|update|patch/i);
    }
  });
});

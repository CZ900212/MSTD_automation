// Task 9 C4 §5.2 审卷补杀:实际 SOUL.md 内容锁——SOUL 在 agent-memory 独立仓演进
// (主仓 gitignore),没有这条锁"恢复旧版客服风 SOUL"任何主仓测试都不红。
// 文件缺失(全新 clone 无独立仓)时跳过:运行时由 index.mjs SOUL fail-fast 兜底。
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SOUL_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "agent-memory", "SOUL.md");

describe.skipIf(!existsSync(SOUL_PATH))("C4 SOUL.md 干练同事风内容锁", () => {
  const soul = existsSync(SOUL_PATH) ? readFileSync(SOUL_PATH, "utf8") : "";

  it("身份+人格+示例框定+禁忌+规矩五段方向句齐全", () => {
    expect(soul).toContain("你是「小达」");
    expect(soul).toContain("不是客服系统");
    expect(soul).toContain("干练的同事");
    expect(soul).toContain("直接给结论");
    expect(soul).toContain("错误示范");                    // ✗ 例已框定,防弱模型照抄
    expect(soul).toContain("客服腔");                      // 禁忌段
    expect(soul).toContain("绝不跨群转述");
    expect(soul).toContain("先发确认卡,经确认才执行");
    expect(soul).toContain("heartbeat_update");
    expect(soul).toContain("绝不编造");
  });

  it("旧版客服风回归即红:旧措辞不再出现", () => {
    expect(soul).not.toContain("你不是某个工具或框架");     // 旧身份段独有句
    expect(soul).toContain("绝不向用户提及内部架构");
  });
});

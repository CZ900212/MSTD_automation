import { describe, expect, it } from "vitest";
import { buildPiArgs } from "../supervisor/pi-client.mjs";
import { buildCapabilityProfile } from "../server/pi/resident-extensions.mjs";

describe("Pi supervisor capability profiles", () => {
  it("turns the readonly job profile into an isolated extension-only allowlist", () => {
    const args = buildPiArgs({
      provider: "cz-gpt",
      model: "gpt-5.6-sol",
      capabilityProfile: buildCapabilityProfile("/r", "readonly_job"),
    });
    expect(args).toEqual(expect.arrayContaining([
      "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills",
      "--no-context-files", "--no-prompt-templates", "--no-builtin-tools",
      "-e", "/r/pi-ext/providers.ts", "-e", "/r/pi-ext/lark-read.ts", "-e", "/r/pi-ext/draft.ts",
      "--tools", "lark_read,draft_zh",
    ]));
    expect(args).not.toContain("bash");
    expect(args).not.toContain("read");
    expect(args).not.toContain("write");
    // -a 在 0.80.3 是 projectTrustOverride=true（信任并加载 cwd 项目本地资源），生产禁止。
    expect(args).not.toContain("-a");
    expect(args).toContain("--no-approve");
  });

  it("rejects a raw extension list combined with a verified profile", () => {
    expect(() => buildPiArgs({
      extensions: ["/unsafe.ts"],
      capabilityProfile: buildCapabilityProfile("/r", "resident"),
    })).toThrow(/不可混用/);
  });

  it("uses no tools at all for a profile with no declared tools", () => {
    const empty = { role: "background", extensions: [], tools: [] };
    expect(() => buildPiArgs({ capabilityProfile: empty })).toThrow(/extension paths/);
  });
});

// startPi 运行时接线（supervisor 核心此前零单测,只靠真机间接触碰）——fake spawn 驱动
import { EventEmitter } from "node:events";
import { startPi } from "../supervisor/pi-client.mjs";
import { vi, afterEach } from "vitest";

function fakePiChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: vi.fn(() => true), end: vi.fn() };
  child.kill = vi.fn();
  return child;
}

afterEach(() => { vi.useRealTimers(); });

describe("startPi 运行时（fake spawn）", () => {
  it("JSONL 跨 chunk 切分正确:一条消息分两片到达仍解析;坏行上报 parse_error 不断流", async () => {
    const child = fakePiChild();
    const client = startPi({ provider: "deepseek", model: "m", spawnFn: () => child });
    const seen = [];
    client.on((msg) => seen.push(msg));
    const line = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "好" }] } });
    child.stdout.emit("data", Buffer.from(line.slice(0, 10)));
    child.stdout.emit("data", Buffer.from(`${line.slice(10)}\n{broken\n`));
    expect(seen[0]).toMatchObject({ type: "message_end" });
    expect(seen[1]).toMatchObject({ type: "parse_error", raw: "{broken" });
    expect(client.seenTypes.has("message_end")).toBe(true);
  });

  it("prompt():取最后一条 assistant 文本,agent_end 终局事件才 resolve", async () => {
    const child = fakePiChild();
    const client = startPi({ spawnFn: () => child });
    const p = client.prompt("hi");
    expect(child.stdin.write).toHaveBeenCalled(); // prompt 指令已写入 stdin
    const emitLine = (obj) => child.stdout.emit("data", Buffer.from(`${JSON.stringify(obj)}\n`));
    emitLine({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "初稿" }] } });
    emitLine({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "终稿" }] } });
    emitLine({ type: "agent_end", willRetry: false });
    await expect(p).resolves.toBe("终稿");
  });

  it("prompt() 超时 reject;close() 在子进程不退时 3s 后硬杀", async () => {
    vi.useFakeTimers();
    const child = fakePiChild();
    const client = startPi({ spawnFn: () => child });
    const p = client.prompt("hi", { timeoutMs: 1000 });
    vi.advanceTimersByTime(1000);
    await expect(p).rejects.toThrow(/timeout/);
    const closing = client.close();
    expect(child.stdin.end).toHaveBeenCalled();   // 先礼:stdin EOF 优雅关停
    vi.advanceTimersByTime(3000);
    expect(child.kill).toHaveBeenCalled();        // 后兵:3s 不退硬杀
    await expect(closing).resolves.toBeUndefined();
  });

  it.each(["exit", "close"])("%s immediately rejects a pending runJob and future calls", async (event) => {
    const child = fakePiChild();
    const client = startPi({ spawnFn: () => child });
    const pending = client.runJob("hi", { timeoutMs: 240000 });
    child.emit(event, 1, null);
    await expect(pending).rejects.toThrow(/pi process (exited|closed)/);
    await expect(client.prompt("again")).rejects.toThrow(/pi process (exited|closed)/);
  });

  it("child error rejects prompt without becoming an unhandled EventEmitter error", async () => {
    const child = fakePiChild();
    const client = startPi({ spawnFn: () => child });
    const pending = client.prompt("hi", { timeoutMs: 240000 });
    child.emit("error", new Error("spawn broke"));
    await expect(pending).rejects.toThrow(/spawn broke/);
    await expect(client.close()).resolves.toBeUndefined();
  });
});

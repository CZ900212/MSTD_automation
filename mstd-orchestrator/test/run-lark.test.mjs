// makeRunLark 是所有写动作的唯一物理出口,此前其 spawn 包装零单测(仅 e2e 门控间接触碰)。
import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { makeRunLark } from "../server/execute/run-lark.mjs";

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

afterEach(() => { vi.useRealTimers(); });

describe("makeRunLark spawn 包装", () => {
  it("profile 非空时 argv 前置 --profile;stdout/stderr 分流拼接;close 带回 exitCode", async () => {
    let spawned;
    const child = fakeChild();
    const runLark = makeRunLark({
      larkCli: "/fake/lark-cli",
      profile: "user613148",
      spawnFn: (cli, args) => { spawned = { cli, args }; return child; },
    });
    const p = runLark(["im", "+messages-send"]);
    child.stdout.emit("data", Buffer.from('{"ok":'));
    child.stdout.emit("data", Buffer.from("true}"));
    child.stderr.emit("data", Buffer.from("warn"));
    child.emit("close", 0);
    await expect(p).resolves.toEqual({ exitCode: 0, stdout: '{"ok":true}', stderr: "warn" });
    expect(spawned.cli).toBe("/fake/lark-cli");
    expect(spawned.args.slice(0, 2)).toEqual(["--profile", "user613148"]);
    expect(spawned.args).toContain("im");
  });

  it("spawn error(如二进制缺失)→ 解析为 exitCode:-1 而非 reject", async () => {
    const child = fakeChild();
    const runLark = makeRunLark({ larkCli: "/missing", profile: "", spawnFn: () => child });
    const p = runLark(["auth", "status"]);
    child.emit("error", new Error("ENOENT: no such file"));
    await expect(p).resolves.toMatchObject({ exitCode: -1, stderr: expect.stringContaining("ENOENT") });
  });

  it("挂死子进程在 timeoutMs 到期被 SIGTERM,随后 close 收口", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const runLark = makeRunLark({ larkCli: "/fake", profile: "", timeoutMs: 60_000, spawnFn: () => child });
    const p = runLark(["im", "+messages-send"]);
    vi.advanceTimersByTime(60_000);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close", 143); // SIGTERM 退出码
    await expect(p).resolves.toMatchObject({ exitCode: 143 });
  });

  it("SIGTERM 后 CLI 仍不退出(吞信号挂死)→宽限期后升级 SIGKILL,仍等 close 才 resolve", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const runLark = makeRunLark({ larkCli: "/fake", profile: "", timeoutMs: 60_000, spawnFn: () => child });
    const p = runLark(["im", "+messages-send"]);
    vi.advanceTimersByTime(60_000);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");

    // 宽限期内 CLI 仍未退出,Promise 不得提前 resolve
    vi.advanceTimersByTime(4_999);
    expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");

    vi.advanceTimersByTime(1);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    // SIGKILL 发出后 Promise 仍未 settle,必须等 close 事件
    let settled = false;
    p.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    child.emit("close", 137); // SIGKILL 退出码
    await expect(p).resolves.toMatchObject({ exitCode: 137 });
  });
});

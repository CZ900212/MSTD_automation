import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  renderLaunchdPlist,
  renderSystemdUnit,
  renderWindowsTaskXml,
  rootSlug,
  serviceIdentity,
} from "../bin/service.mjs";
import { childMatches, parseCimProcesses } from "../bin/win-process.mjs";

const ROOT = "/opt/mstd & co/orchestrator"; // 带特殊字符，顺带验 XML 转义
const cfg = { root: ROOT, nodeBin: "/Users/op/.hermes/node/bin/node", pathEnv: "/usr/bin:/bin" };

describe("服务身份按 ROOT 隔离", () => {
  it("slug 由 ROOT 绝对路径稳定派生，不同 checkout 不冲突", () => {
    expect(rootSlug(ROOT)).toBe(rootSlug(ROOT));
    expect(rootSlug(ROOT)).toHaveLength(8);
    expect(rootSlug(ROOT)).not.toBe(rootSlug("/opt/other"));
  });

  it("三平台身份命名一致含 slug", () => {
    const slug = rootSlug(ROOT);
    expect(serviceIdentity(ROOT, "darwin").label).toBe(`com.mstd.orchestrator.${slug}`);
    expect(serviceIdentity(ROOT, "linux").unit).toBe(`mstd-orchestrator-${slug}.service`);
    expect(serviceIdentity(ROOT, "win32").taskName).toBe(`\\MSTD\\Orchestrator-${slug}`);
  });
});

describe("launchd plist 模板", () => {
  const plist = renderLaunchdPlist(cfg);

  it("开机自启 + 崩溃拉起（正常退出不拉）", () => {
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>SuccessfulExit</key><false/>");
  });

  it("ExecStart 指向 bin/mstd run，日志与 nohup 模式同一份 daemon.log", () => {
    expect(plist).toContain("bin/mstd</string>");
    expect(plist).toContain("<string>run</string>");
    expect(plist).toContain("daemon.log</string>");
  });

  it("环境变量只注入基础设施项（node 路径/PATH），业务开关一律走 .env", () => {
    expect(plist).toContain("<key>MSTD_NODE_BIN</key>");
    expect(plist).toContain("<key>PATH</key>");
    expect(plist).not.toContain("MSTD_ENABLE_AGENT");
    expect(plist).not.toContain("MSTD_ENABLE_WRITE");
  });

  it("路径做了 XML 转义", () => {
    expect(plist).toContain("mstd &amp; co");
    expect(plist).not.toContain("mstd & co");
  });
});

describe("systemd user unit 模板", () => {
  const unit = renderSystemdUnit(cfg);

  it("崩溃拉起但 systemctl stop 后不复活", () => {
    expect(unit).toContain("Restart=on-failure");
    expect(unit).not.toContain("Restart=always");
  });

  it("日志追加写入同一份 daemon.log", () => {
    expect(unit).toMatch(/StandardOutput=append:.*daemon\.log/);
    expect(unit).toMatch(/StandardError=append:.*daemon\.log/);
  });

  it("开机自启挂 default.target，业务开关不进服务定义", () => {
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain("MSTD_NODE_BIN=");
    expect(unit).not.toContain("MSTD_ENABLE_AGENT");
  });
});

describe("Windows 任务计划模板", () => {
  const xml = renderWindowsTaskXml({ root: "C:\\mstd", nodeBin: "C:\\node\\node.exe", userId: "op" });

  it("登录触发 + 最低权限 + 崩溃重启", () => {
    expect(xml).toContain("<LogonTrigger>");
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(xml).toContain("<RestartOnFailure>");
    expect(xml).toContain("<Interval>PT1M</Interval>");
    expect(xml).toContain("<Count>3</Count>");
  });

  it("不限制运行时长，Action 用绝对 node 路径跑 service-run.mjs", () => {
    expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(xml).toContain("<Command>C:\\node\\node.exe</Command>");
    expect(xml).toContain("service-run.mjs");
  });
});

describe("Windows 进程判定（CIM 输出解析）", () => {
  it("单对象与数组两种 JSON 形态都能解析", () => {
    const single = JSON.stringify({ ProcessId: 42, CommandLine: "lark-cli event consume im.message.receive_v1 --as bot" });
    const many = JSON.stringify([
      { ProcessId: 1, CommandLine: "node server/index.mjs" },
      { ProcessId: 2, CommandLine: null },
    ]);
    expect(parseCimProcesses(single)).toEqual([
      { pid: 42, commandLine: "lark-cli event consume im.message.receive_v1 --as bot" },
    ]);
    expect(parseCimProcesses(many)).toHaveLength(2);
    expect(parseCimProcesses("not json")).toEqual([]);
  });

  it("consumer 匹配口径与 bin/mstd verify 一致", () => {
    const children = parseCimProcesses(
      JSON.stringify([{ ProcessId: 7, CommandLine: "lark-cli event consume card.action.trigger --as bot" }]),
    );
    expect(childMatches(children, "event consume card.action.trigger --as bot")).toBe(true);
    expect(childMatches(children, "event consume minutes.minute.generated_v1 --as user")).toBe(false);
  });
});

describe("service.mjs 源码红线", () => {
  const source = readFileSync(new URL("../bin/service.mjs", import.meta.url), "utf8");

  it("不用 pkill / launchctl load（弃用 API）", () => {
    expect(source).not.toMatch(/\bpkill\b/);
    expect(source).not.toMatch(/launchctl", \["load/);
    expect(source).toContain('"bootstrap"');
    expect(source).toContain('"bootout"');
  });

  it("linux 安装含 enable-linger（登出防杀），schtasks 停止先 DISABLE 再 End", () => {
    expect(source).toContain("enable-linger");
    expect(source).toMatch(/\/DISABLE[\s\S]*?\/End/);
  });
});

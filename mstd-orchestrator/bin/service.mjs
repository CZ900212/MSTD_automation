#!/usr/bin/env node
// service.mjs — mstd 系统服务编排（一键部署核心）。
// 把守护从 nohup 升级为系统级服务：macOS launchd / Linux systemd(user) / Windows 任务计划程序。
// 子命令（供 bin/mstd 与 bin/mstd.cmd 委托调用）：
//   installed-as <ROOT>        打印 none|launchd|systemd|schtasks
//   install <ROOT> [--dry-run] 注册服务（开机自启+崩溃拉起），等待就绪，失败回滚
//   uninstall <ROOT> [--dry-run] 停止并注销服务；不自动回退拉起 nohup daemon
//   service-start <ROOT>       让服务管理器拉起服务（不含就绪等待，由调用方轮询）
//   service-stop <ROOT>        停止且不被 KeepAlive/Restart 拉回来
// Windows 入口 shim（bin/mstd.cmd）额外委托：start|stop|restart|status|logs
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, "..");

export function rootSlug(root) {
  return createHash("sha256").update(resolve(root)).digest("hex").slice(0, 8);
}

// 服务身份按 ROOT 绝对路径 hash 派生：同机多份 checkout 各装各的，互不覆盖。
export function serviceIdentity(root, platform = process.platform) {
  const abs = resolve(root);
  const slug = rootSlug(abs);
  if (platform === "darwin") {
    const label = `com.mstd.orchestrator.${slug}`;
    return {
      kind: "launchd",
      slug,
      label,
      definitionPath: join(homedir(), "Library", "LaunchAgents", `${label}.plist`),
    };
  }
  if (platform === "linux") {
    const unit = `mstd-orchestrator-${slug}.service`;
    return {
      kind: "systemd",
      slug,
      unit,
      definitionPath: join(homedir(), ".config", "systemd", "user", unit),
    };
  }
  if (platform === "win32") {
    return {
      kind: "schtasks",
      slug,
      taskName: `\\MSTD\\Orchestrator-${slug}`,
      definitionPath: null,
    };
  }
  throw new Error(`不支持的平台: ${platform}`);
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// —— 三平台服务定义模板（纯函数，供单测快照）——
// 服务定义里只放基础设施变量（MSTD_NODE_BIN/PATH）；
// MSTD_ENABLE_AGENT 等业务开关一律走 .env（project.md 硬规则：生产开关必须落 .env）。

export function renderLaunchdPlist({ root, nodeBin, pathEnv }) {
  const abs = resolve(root);
  const { label } = serviceIdentity(abs, "darwin");
  const log = join(abs, "daemon.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(join(abs, "bin", "mstd"))}</string>
    <string>run</string>
  </array>
  <key>WorkingDirectory</key><string>${xmlEscape(abs)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>StandardOutPath</key><string>${xmlEscape(log)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(log)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MSTD_NODE_BIN</key><string>${xmlEscape(nodeBin)}</string>
    <key>PATH</key><string>${xmlEscape(pathEnv)}</string>
  </dict>
</dict>
</plist>
`;
}

export function renderSystemdUnit({ root, nodeBin, pathEnv }) {
  const abs = resolve(root);
  return `[Unit]
Description=MSTD orchestrator (${abs})
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${abs}
ExecStart=${join(abs, "bin", "mstd")} run
Restart=on-failure
RestartSec=5
StandardOutput=append:${join(abs, "daemon.log")}
StandardError=append:${join(abs, "daemon.log")}
Environment="MSTD_NODE_BIN=${nodeBin}"
Environment="PATH=${pathEnv}"

[Install]
WantedBy=default.target
`;
}

export function renderWindowsTaskXml({ root, nodeBin, userId }) {
  const abs = resolve(root);
  const { taskName } = serviceIdentity(abs, "win32");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <URI>${xmlEscape(taskName)}</URI>
    <Description>MSTD orchestrator (${xmlEscape(abs)})</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlEscape(userId)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(nodeBin)}</Command>
      <Arguments>"${xmlEscape(join(abs, "bin", "service-run.mjs"))}"</Arguments>
      <WorkingDirectory>${xmlEscape(abs)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

// —— 运行时辅助 ——

function makeRunner(dryRun) {
  return {
    dryRun,
    exec(cmd, args, { ignoreFailure = false, input } = {}) {
      if (dryRun) {
        process.stdout.write(`[dry-run] exec: ${cmd} ${args.join(" ")}${ignoreFailure ? "（失败可忽略）" : ""}\n`);
        return { status: 0, stdout: "", stderr: "" };
      }
      const result = spawnSync(cmd, args, { encoding: "utf8", input });
      if (result.error) {
        if (ignoreFailure) return { status: 1, stdout: "", stderr: String(result.error.message) };
        throw new Error(`执行失败 ${cmd}: ${result.error.message}`);
      }
      if (result.status !== 0 && !ignoreFailure) {
        throw new Error(`命令非零退出（${result.status}）: ${cmd} ${args.join(" ")}\n${result.stderr || result.stdout}`);
      }
      return result;
    },
    write(path, content) {
      if (dryRun) {
        process.stdout.write(`[dry-run] write ${path}:\n${content}\n`);
        return;
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    },
    remove(path) {
      if (dryRun) {
        process.stdout.write(`[dry-run] rm ${path}\n`);
        return;
      }
      rmSync(path, { force: true });
    },
  };
}

// 与 bin/mstd 同源的运行时配置（PORT/ENABLE_AGENT）：
// 借 --env-file-if-exists 加载 .env 后跑 runtime-config.mjs，避免自行解析 env 文件产生口径分叉。
function loadRuntimeConfig(root) {
  const result = spawnSync(
    process.execPath,
    [`--env-file-if-exists=${join(root, ".env")}`, join(SCRIPT_DIR, "runtime-config.mjs")],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`读取运行时配置失败: ${result.stderr}`);
  const [port, larkProfile, enableAgent] = result.stdout.trim().split("\n");
  return { port, larkProfile, enableAgent: enableAgent === "1" };
}

function readPidFile(root) {
  try {
    const raw = readFileSync(join(root, "daemon.pid"), "utf8").trim();
    return /^\d+$/.test(raw) ? Number(raw) : null;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 就绪判定与 bin/mstd http_ready_owned 同口径：health 必须 200 且回显 pid == daemon.pid，
// 防端口被他进程截胡（rsh-api-gateway 占 8787 老坑）报假成功。
async function healthOwned(port, expectedPid) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return false;
    const body = await res.json();
    return Number(body?.pid) === Number(expectedPid);
  } catch {
    return false;
  }
}

async function waitReady(root, { timeoutSec = 25 } = {}) {
  const { port, enableAgent } = loadRuntimeConfig(root);
  const logPath = join(root, "daemon.log");
  for (let i = 0; i < timeoutSec; i += 1) {
    await sleep(1000);
    const pid = readPidFile(root);
    if (!pid) continue;
    if (!(await healthOwned(port, pid))) continue;
    if (enableAgent) {
      let log = "";
      try {
        log = readFileSync(logPath, "utf8");
      } catch {}
      if (!log.includes("agent gateway on")) continue;
    }
    return pid;
  }
  return null;
}

function tailLog(root, lines = 20) {
  try {
    const content = readFileSync(join(root, "daemon.log"), "utf8").trimEnd().split("\n");
    return content.slice(-lines).join("\n");
  } catch {
    return "(daemon.log 不可读)";
  }
}

// —— installed-as：只读判断当前 ROOT 是否已注册系统服务 ——

export function installedAs(root, platform = process.platform) {
  const identity = serviceIdentity(root, platform);
  if (identity.kind === "schtasks") {
    const result = spawnSync("schtasks", ["/Query", "/TN", identity.taskName], { encoding: "utf8" });
    return result.status === 0 ? "schtasks" : "none";
  }
  if (!existsSync(identity.definitionPath)) return "none";
  // 防御：定义文件存在但指向别的 ROOT（理论上 slug 已隔离，仅防手工改动）
  const content = readFileSync(identity.definitionPath, "utf8");
  return content.includes(resolve(root)) ? identity.kind : "none";
}

// —— 平台特定 启/停（停 = 停止且不被拉回来）——

function serviceStart(root, runner) {
  const identity = serviceIdentity(root);
  if (identity.kind === "launchd") {
    const domain = `gui/${process.getuid()}`;
    // KeepAlive 下 bootstrap 已加载的 job 会报错；先 bootout 再 bootstrap，幂等。
    runner.exec("launchctl", ["bootout", `${domain}/${identity.label}`], { ignoreFailure: true });
    runner.exec("launchctl", ["bootstrap", domain, identity.definitionPath]);
    return;
  }
  if (identity.kind === "systemd") {
    runner.exec("systemctl", ["--user", "daemon-reload"]);
    runner.exec("systemctl", ["--user", "start", identity.unit]);
    return;
  }
  runner.exec("schtasks", ["/Change", "/TN", identity.taskName, "/ENABLE"]);
  runner.exec("schtasks", ["/Run", "/TN", identity.taskName]);
}

function serviceStop(root, runner) {
  const identity = serviceIdentity(root);
  if (identity.kind === "launchd") {
    // 直接 kill 会被 KeepAlive 秒拉起，必须 bootout 整个 job。
    runner.exec("launchctl", ["bootout", `gui/${process.getuid()}/${identity.label}`], { ignoreFailure: true });
    return;
  }
  if (identity.kind === "systemd") {
    runner.exec("systemctl", ["--user", "stop", identity.unit], { ignoreFailure: true });
    return;
  }
  // schtasks /End 的退出状态可能被判"失败"触发 RestartOnFailure，先 DISABLE 再 End 规避。
  runner.exec("schtasks", ["/Change", "/TN", identity.taskName, "/DISABLE"], { ignoreFailure: true });
  runner.exec("schtasks", ["/End", "/TN", identity.taskName], { ignoreFailure: true });
}

// —— install / uninstall ——

function foreignDaemonRunning() {
  if (process.platform === "win32") {
    // Windows 侧用 CIM 查 server/index.mjs 进程
    const result = spawnSync(
      "powershell",
      ["-NoProfile", "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name like 'node%'\" | Where-Object { $_.CommandLine -like '*server/index.mjs*' -or $_.CommandLine -like '*server\\index.mjs*' } | Select-Object -ExpandProperty ProcessId"],
      { encoding: "utf8" },
    );
    return Boolean(result.stdout && result.stdout.trim());
  }
  const result = spawnSync("pgrep", ["-f", "server/index.mjs"], { encoding: "utf8" });
  return result.status === 0;
}

function stopViaCli(root, runner) {
  if (runner.dryRun) {
    process.stdout.write(`[dry-run] exec: ${join(root, "bin", "mstd")} stop\n`);
    return;
  }
  if (process.platform === "win32") {
    cliStop(root, makeRunner(false));
    return;
  }
  const result = spawnSync(join(root, "bin", "mstd"), ["stop"], { encoding: "utf8", stdio: "inherit" });
  if (result.status !== 0) throw new Error("mstd stop 失败，中止安装。");
}

async function install(root, { dryRun = false } = {}) {
  const abs = resolve(root);
  const identity = serviceIdentity(abs);
  const runner = makeRunner(dryRun);
  const nodeBin = process.execPath;
  const pathEnv = process.env.PATH ?? "";

  // ① 先干净停掉当前 CLI 拥有的 daemon（无 daemon 时是安全 no-op；已装服务时顺带 bootout 旧服务）
  stopViaCli(abs, runner);

  // ② 外来进程占着（别的 checkout / 手工起的 daemon）→ 拒绝安装不代杀（延续现有红线）
  if (!dryRun && foreignDaemonRunning()) {
    throw new Error("发现不属于当前 PID 文件的 server/index.mjs 进程；为避免误杀，拒绝安装。请先手动确认并停止它。");
  }

  // ③ 渲染服务定义并写盘
  if (identity.kind === "launchd") {
    runner.write(identity.definitionPath, renderLaunchdPlist({ root: abs, nodeBin, pathEnv }));
  } else if (identity.kind === "systemd") {
    runner.write(identity.definitionPath, renderSystemdUnit({ root: abs, nodeBin, pathEnv }));
  } else {
    const xml = renderWindowsTaskXml({ root: abs, nodeBin, userId: userInfo().username });
    const xmlPath = join(abs, "daemon-task.xml");
    runner.write(xmlPath, xml);
    runner.exec("schtasks", ["/Create", "/TN", identity.taskName, "/XML", xmlPath, "/F"]);
    runner.remove(xmlPath);
  }

  // ④ 启用 + 拉起
  if (!dryRun) {
    rmSync(join(abs, "daemon.pid"), { force: true });
    try {
      truncateSync(join(abs, "daemon.log"));
    } catch {}
  }
  if (identity.kind === "systemd") {
    runner.exec("systemctl", ["--user", "daemon-reload"]);
    runner.exec("systemctl", ["--user", "enable", "--now", identity.unit]);
    // 不 enable-linger 的话用户一登出 systemd --user 连服务一起被杀，"开机自启"名存实亡。
    const linger = runner.exec("loginctl", ["enable-linger", userInfo().username], { ignoreFailure: true });
    if (linger.status !== 0) {
      process.stderr.write(
        "⚠️ loginctl enable-linger 失败：用户登出后服务会被终止。请让有权限的管理员执行 " +
          `loginctl enable-linger ${userInfo().username}\n`,
      );
    }
  } else {
    serviceStart(abs, runner);
  }

  if (dryRun) {
    process.stdout.write("[dry-run] （跳过就绪等待与核验）\n");
    return;
  }

  // ⑤ 等就绪（health 回显 pid 必须匹配 + agent 时等 gateway on），失败回滚（对齐 cleanup_failed_start 精神）
  const pid = await waitReady(abs);
  if (!pid) {
    serviceStop(abs, runner);
    if (identity.definitionPath) runner.remove(identity.definitionPath);
    rmSync(join(abs, "daemon.pid"), { force: true });
    throw new Error(`等待 25s 服务仍未就绪，已回滚安装。日志尾部：\n${tailLog(abs)}`);
  }

  // ⑥ 复用 mstd status 的 verify（consumer 核验）；退化态（exit 3）同样回滚
  if (process.platform !== "win32") {
    const status = spawnSync(join(abs, "bin", "mstd"), ["status"], { encoding: "utf8", stdio: "inherit" });
    if (status.status !== 0) {
      serviceStop(abs, runner);
      runner.remove(identity.definitionPath);
      rmSync(join(abs, "daemon.pid"), { force: true });
      throw new Error(`服务已拉起但核验未通过（exit ${status.status}），已回滚安装。日志尾部：\n${tailLog(abs)}`);
    }
  }
  process.stdout.write(`✅ 已安装为系统服务（${identity.kind}，pid ${pid}）：开机自启 + 崩溃自动拉起。\n`);
  process.stdout.write("   卸载: mstd uninstall   状态: mstd status\n");
}

function uninstall(root, { dryRun = false } = {}) {
  const abs = resolve(root);
  const identity = serviceIdentity(abs);
  const runner = makeRunner(dryRun);
  if (!dryRun && installedAs(abs) === "none") {
    process.stdout.write("未发现本 ROOT 注册的系统服务；无需卸载。\n");
    return;
  }
  serviceStop(abs, runner);
  if (identity.kind === "schtasks") {
    runner.exec("schtasks", ["/Delete", "/TN", identity.taskName, "/F"], { ignoreFailure: true });
  } else {
    runner.remove(identity.definitionPath);
    if (identity.kind === "systemd") {
      runner.exec("systemctl", ["--user", "daemon-reload"], { ignoreFailure: true });
    }
  }
  if (dryRun) {
    process.stdout.write("[dry-run] （以上为将执行的动作）\n");
    return;
  }
  rmSync(join(abs, "daemon.pid"), { force: true });
  process.stdout.write("✅ 已卸载系统服务；如需继续运行请执行 mstd start（将回退到 nohup 模式）。\n");
}

// —— Windows 入口 shim（bin/mstd.cmd）的 start/stop/status/logs 委托 ——

async function cliStart(root, runner) {
  const abs = resolve(root);
  if (installedAs(abs) === "none") {
    throw new Error("Windows 下请先执行 mstd install 注册服务；未注册时不支持 nohup 回退模式。");
  }
  rmSync(join(abs, "daemon.pid"), { force: true });
  try {
    truncateSync(join(abs, "daemon.log"));
  } catch {}
  serviceStart(abs, runner);
  const pid = await waitReady(abs);
  if (!pid) {
    serviceStop(abs, runner);
    throw new Error(`等待 25s 服务仍未就绪。日志尾部：\n${tailLog(abs)}`);
  }
  process.stdout.write(`✅ 已启动（pid ${pid}）。\n`);
}

function cliStop(root, runner) {
  const abs = resolve(root);
  serviceStop(abs, runner);
  const pid = readPidFile(abs);
  if (pid) {
    try {
      process.kill(pid);
    } catch {}
  }
  rmSync(join(abs, "daemon.pid"), { force: true });
  process.stdout.write("已停止。\n");
}

async function cliStatus(root) {
  const abs = resolve(root);
  const { port } = loadRuntimeConfig(abs);
  const pid = readPidFile(abs);
  const managed = installedAs(abs);
  if (!pid) {
    process.stdout.write("orchestrator 未运行。敲 'mstd' 启动。\n");
    process.exitCode = 1;
    return;
  }
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  if (!alive) {
    process.stdout.write("orchestrator 未运行（PID 文件残留）。敲 'mstd' 启动。\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`orchestrator 运行中（pid ${pid}，管理方式 ${managed}）\n`);
  if (!(await healthOwned(port, pid))) {
    process.stdout.write(`❌ HTTP /api/health 未就绪或 pid 不匹配（端口 ${port}）\n`);
    process.exitCode = 3;
  } else {
    process.stdout.write(`✅ HTTP /api/health（端口 ${port}）\n`);
  }
}

async function cliLogs(root) {
  const { followLog } = await import("./win-process.mjs");
  await followLog(join(resolve(root), "daemon.log"));
}

// —— 入口 ——

async function main(argv) {
  const args = argv.filter((a) => a !== "--dry-run");
  const dryRun = argv.includes("--dry-run");
  const [cmd, rootArg] = args;
  const root = resolve(rootArg ?? DEFAULT_ROOT);
  const runner = makeRunner(dryRun);
  switch (cmd) {
    case "installed-as":
      process.stdout.write(`${installedAs(root)}\n`);
      return;
    case "install":
      await install(root, { dryRun });
      return;
    case "uninstall":
      uninstall(root, { dryRun });
      return;
    case "service-start":
      serviceStart(root, runner);
      return;
    case "service-stop":
      serviceStop(root, runner);
      return;
    // 以下仅 Windows shim 使用（macOS/Linux 走 bin/mstd 的 bash 路径）
    case "start":
      await cliStart(root, runner);
      return;
    case "restart":
      cliStop(root, runner);
      await cliStart(root, runner);
      return;
    case "stop":
      cliStop(root, runner);
      return;
    case "status":
      await cliStatus(root);
      return;
    case "logs":
      await cliLogs(root);
      return;
    default:
      throw new Error(`未知命令: ${cmd ?? "(空)"}；用法: service.mjs <installed-as|install|uninstall|service-start|service-stop> <ROOT> [--dry-run]`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

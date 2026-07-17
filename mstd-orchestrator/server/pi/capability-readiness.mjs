// 启动 readiness 探针（批次 A 收尾）：用生产同一 binary、生产同一参数拼装，
// 对每个 capability role 断言实际暴露的工具集合与 profile 声明完全一致。
// 漂移（Pi 升级、扩展改名、builtins 复活、legacy lark 复活）即 fail-fast，拒绝起服务。
// 探针无任何业务凭据、临时空 cwd/agent 目录、不处理用户输入、不调用任何工具。
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPiArgs, PI_BIN } from "../../supervisor/pi-client.mjs";
import { buildCapabilityProfile, CAPABILITY_ROLE_NAMES } from "./resident-extensions.mjs";

const MARKER = "MSTD_CAPABILITY_READY=";

// 观察扩展不注册任何工具——纯 session_start 上报，绝不扰动被测工具集合。
const OBSERVER_SOURCE = `export default function (pi) {
  pi.on("session_start", async () => {
    process.stderr.write(${JSON.stringify(MARKER)} + JSON.stringify({
      activeTools: pi.getActiveTools().slice().sort(),
      configuredTools: pi.getAllTools().map((t) => t.name).sort(),
    }) + "\\n");
  });
}
`;

// builtins 与退役的 legacy lark 面必须在任何 role 下都不可见（验证矩阵 #2）。
export const FORBIDDEN_TOOL_NAMES = Object.freeze([
  "read", "bash", "edit", "write", "grep", "find", "ls", "lark",
]);

function runOnce(args, { cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    // stdin 直接关闭：RPC 模式下 pi 完成初始化后随 stdin EOF 退出，不会挂住。
    const child = spawn(PI_BIN, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.stdout.resume();
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stderr, timedOut }); });
  });
}

function extractObservation(stderr) {
  const lines = stderr.split(/\r?\n/).filter((line) => line.startsWith(MARKER));
  if (lines.length === 0) throw new Error(`readiness 探针未收到能力上报；stderr: ${stderr}`);
  const unique = [...new Set(lines)];
  if (unique.length !== 1) throw new Error(`readiness 探针收到 ${unique.length} 份不一致上报`);
  return JSON.parse(unique[0].slice(MARKER.length));
}

/**
 * 对每个 role 启动一次真实 Pi（生产参数 + 观察扩展），比对工具集合。
 * 返回 { ok, roles } 或抛错；调用方（index.mjs）负责 fail-fast。
 */
export async function assertCapabilityReadiness({ root, roles = CAPABILITY_ROLE_NAMES, timeoutMs = 20_000 } = {}) {
  if (!root) throw new Error("capability readiness root 必填");
  const workRoot = await mkdtemp(join(tmpdir(), "mstd-pi-readiness-"));
  try {
    const observerPath = join(workRoot, "readiness-observer.mjs");
    await writeFile(observerPath, OBSERVER_SOURCE, "utf8");
    // persona.ts 加载期强制要求 SOUL 路径存在；探针给空桩，绝不读真实 persona。
    const soulStubPath = join(workRoot, "SOUL.stub.md");
    await writeFile(soulStubPath, "# readiness probe stub\n", "utf8");
    const results = [];

    for (const role of roles) {
      const profile = buildCapabilityProfile(root, role);
      // 生产同一参数拼装（含 --no-approve/--no-builtin-tools/--tools allowlist），
      // 仅追加观察扩展与 --offline；观察扩展不在 --tools 内，不会进入 active 集合。
      const args = [...buildPiArgs({ capabilityProfile: profile }), "-e", observerPath, "--offline"];
      const result = await runOnce(args, {
        cwd: workRoot,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: workRoot,
          LANG: "C",
          PI_CODING_AGENT_DIR: join(workRoot, "agent"),
          PI_OFFLINE: "1",
          PI_TELEMETRY: "0",
          PI_SKIP_VERSION_CHECK: "1",
          MSTD_SOUL_PATH: soulStubPath,
        },
        timeoutMs,
      });
      if (result.timedOut) throw new Error(`role=${role} readiness 探针超时（${timeoutMs}ms）`);
      if (result.code !== 0 || result.signal !== null) {
        throw new Error(`role=${role} readiness 探针异常退出 code=${result.code} signal=${result.signal}；stderr: ${result.stderr}`);
      }
      const observation = extractObservation(result.stderr);
      const expected = [...profile.tools].sort();

      if (JSON.stringify(observation.activeTools) !== JSON.stringify(expected)) {
        throw new Error(`role=${role} 工具集合漂移：profile 声明 [${expected.join(",")}]，实际 active [${observation.activeTools.join(",")}]`);
      }
      const forbidden = observation.configuredTools.filter((name) => FORBIDDEN_TOOL_NAMES.includes(name));
      if (forbidden.length > 0) {
        throw new Error(`role=${role} 出现被禁工具面：[${forbidden.join(",")}]`);
      }
      results.push({ role, activeTools: observation.activeTools });
    }
    return { ok: true, roles: results };
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}

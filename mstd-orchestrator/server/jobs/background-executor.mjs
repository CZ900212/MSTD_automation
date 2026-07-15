// 后台只读任务执行体：每个 job 一个全新的、能力收窄的 Pi 进程，
// 绝不复用常驻 resident——没有 reply/memory/写提案/嵌套 spawn 能力。
import { join } from "node:path";
import { mkdirSync } from "node:fs";

const TIMEOUT_CODES = new Set(["ETIMEDOUT", "ERR_OPERATION_TIMEOUT", "ABORT_ERR"]);
const CRASH_CODES = new Set(["EPIPE", "ECONNRESET", "ERR_CHILD_PROCESS_IPC_REQUIRED"]);

export function classifyBackgroundError(error) {
  const name = String(error?.name ?? "");
  const code = String(error?.code ?? "").toUpperCase();
  const message = String(error?.message ?? error ?? "");
  if (name === "TimeoutError" || name === "AbortError" || TIMEOUT_CODES.has(code) || /tim(?:e|ed)\s*out|deadline exceeded|超时/i.test(message)) {
    return "timeout";
  }
  if (name === "ToolError" || code === "TOOL_ERROR" || /\btool[_ -]?error\b/i.test(message)) return "tool_error";
  if (Number.isInteger(error?.exitCode) || error?.signal || CRASH_CODES.has(code) || /\b(?:crash(?:ed)?|child exited|process exited)\b/i.test(message)) {
    return "crashed";
  }
  return "unknown";
}

export function createBackgroundExecutor({ startPi, config, agentWorkspace, capabilityProfile, timeoutMs }) {
  return async function runJob({ jobId, sessionKey: _sessionKey, brief, params }) {
    const workdir = join(agentWorkspace, "background", jobId);
    mkdirSync(workdir, { recursive: true });
    const client = startPi({
      provider: config.pi.provider,
      model: config.pi.model,
      thinking: config.pi.thinking,
      capabilityProfile,
      cwd: workdir,
      env: { MSTD_JOB_WORKDIR: workdir },
    });
    try {
      const result = await client.runJob(
        `【后台只读任务】${brief}\n参数: ${JSON.stringify(params ?? {})}\n完成后直接输出结果要点。不要调用 reply 或任何未提供的写入、消息工具。`,
        { id: `background:${jobId}`, timeoutMs },
      );
      return { text: result.finalText, sensitivity: "internal" };
    } catch (error) {
      const classified = new Error(String(error?.message ?? error ?? "unknown background error"), { cause: error });
      classified.name = error?.name ?? "Error";
      classified.errorKind = classifyBackgroundError(error);
      throw classified;
    } finally {
      await client.close();
    }
  };
}

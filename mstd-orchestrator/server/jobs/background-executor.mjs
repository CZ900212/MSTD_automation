// 后台只读任务执行体：每个 job 一个全新的、能力收窄的 Pi 进程，
// 绝不复用常驻 resident——没有 reply/memory/写提案/嵌套 spawn 能力。
import { join } from "node:path";
import { mkdirSync } from "node:fs";

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
    } finally {
      await client.close();
    }
  };
}

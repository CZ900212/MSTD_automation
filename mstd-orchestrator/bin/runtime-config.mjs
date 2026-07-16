import { pathToFileURL } from "node:url";

export function resolveRuntimeConfig(env = process.env) {
  const rawPort = String(env.PORT ?? "8787");
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
    throw new Error(`PORT 必须是 1-65535 的整数，当前为 ${JSON.stringify(rawPort)}`);
  }
  return {
    port: rawPort,
    larkProfile: String(env.LARK_PROFILE ?? env.MSTD_LARK_PROFILE ?? ""),
    enableAgent: String(env.MSTD_ENABLE_AGENT ?? "") === "1",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = resolveRuntimeConfig();
    process.stdout.write(`${config.port}\n${config.larkProfile}\n${config.enableAgent ? "1" : "0"}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}

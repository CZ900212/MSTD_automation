import { homedir } from "node:os";
import { join } from "node:path";

// lark-cli 可执行文件的 hermes 默认安装位（本机开发环境）。
export const HERMES_LARK_CLI = join(homedir(), ".hermes", "node", "bin", "lark-cli");

// lark-cli 路径解析优先级（2026-07-22 生产事故治本，单一事实来源）：
//   1) LARK_CLI_BIN —— Pi 子进程唯一能收到的覆盖（LARK_ 前缀天然过 buildPiEnv 白名单）；
//   2) MSTD_LARK_CLI —— 守护侧历史变量，向后兼容（buildPiEnv 会桥接为 LARK_CLI_BIN 传导进 Pi）；
//   3) ~/.hermes 默认。
// 守护侧（run-lark/write-smoke）两个变量都认；Pi 内（lark-read）实际只有 LARK_CLI_BIN 能到，
// 但兜底逻辑保持一致，避免两处口径分叉。
export function resolveLarkCliPath(env = process.env) {
  const fromBin = String(env.LARK_CLI_BIN ?? "").trim();
  if (fromBin) return fromBin;
  const fromMstd = String(env.MSTD_LARK_CLI ?? "").trim();
  if (fromMstd) return fromMstd;
  return HERMES_LARK_CLI;
}

// 解析出的路径来源标签，供 doctor 自检回显（LARK_CLI_BIN / MSTD_LARK_CLI / hermes 默认）。
export function larkCliPathSource(env = process.env) {
  if (String(env.LARK_CLI_BIN ?? "").trim()) return "LARK_CLI_BIN";
  if (String(env.MSTD_LARK_CLI ?? "").trim()) return "MSTD_LARK_CLI";
  return "hermes 默认";
}

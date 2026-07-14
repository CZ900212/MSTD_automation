import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertCapabilityReadiness, FORBIDDEN_TOOL_NAMES } from "../server/pi/capability-readiness.mjs";
import { buildCapabilityProfile, CAPABILITY_ROLE_NAMES } from "../server/pi/resident-extensions.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("capability readiness fail-fast（真实 Pi，生产参数）", () => {
  it("三个 role 的实际工具集合与 profile 声明逐一相符", async () => {
    const result = await assertCapabilityReadiness({ root: ROOT });
    expect(result.ok).toBe(true);
    expect(result.roles.map(({ role }) => role)).toEqual([...CAPABILITY_ROLE_NAMES]);
    for (const { role, activeTools } of result.roles) {
      expect(activeTools).toEqual([...buildCapabilityProfile(ROOT, role).tools].sort());
    }
  }, 30_000);

  it("builtins 与 legacy lark 永远在禁用名单里", () => {
    for (const name of ["bash", "read", "write", "edit", "lark"]) {
      expect(FORBIDDEN_TOOL_NAMES).toContain(name);
    }
  });

  it("缺 root 直接抛错，不静默通过", async () => {
    await expect(assertCapabilityReadiness({})).rejects.toThrow(/root 必填/);
  });
});

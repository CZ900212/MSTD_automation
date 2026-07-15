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

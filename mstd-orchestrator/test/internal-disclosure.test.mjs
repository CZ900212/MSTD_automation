import { describe, expect, it } from "vitest";
import { createInternalDisclosureScanner } from "../server/safety/internal-disclosure.mjs";

describe("internal disclosure scanner", () => {
  const scanner = createInternalDisclosureScanner({
    knownStrings: ["/srv/mstd/agent-workspace", "127.0.0.1:4310"],
    auditPatterns: ["read_file", "lark_read"],
  });

  it("blocks exact known strings without returning the sensitive values", () => {
    const result = scanner.scan("工作区在 /srv/mstd/agent-workspace，服务是 127.0.0.1:4310");
    expect(result).toEqual({ blocked: ["known_string_0", "known_string_1"], audit: [] });
    expect(JSON.stringify(result)).not.toContain("/srv/mstd");
    expect(JSON.stringify(result)).not.toContain("127.0.0.1");
  });

  it("tool names are audit-only and use identifier boundaries", () => {
    expect(scanner.scan("read_file 没跑通，随后调用 lark_read"))
      .toEqual({ blocked: [], audit: ["read_file", "lark_read"] });
    expect(scanner.scan("my_read_file_wrapper 是业务字段"))
      .toEqual({ blocked: [], audit: [] });
  });

  it("ignores empty, duplicate and non-string known values", () => {
    const deduped = createInternalDisclosureScanner({ knownStrings: ["/x", "", "/x", null] });
    expect(deduped.scan("/x")).toEqual({ blocked: ["known_string_0"], audit: [] });
  });
});

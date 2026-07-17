import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { relative, resolve } from "node:path";

describe("public outbound boundary", () => {
  it("keeps direct outbound calls inside reply-pipeline and the confirm-card allowlist", () => {
    const root = resolve(import.meta.dirname, "../server");
    const offenders = [];
    for (const file of globSync("**/*.mjs", { cwd: root })) {
      const source = readFileSync(resolve(root, file), "utf8");
      if (/\boutbound\.(?:sendMessage|sendCard)\s*\(/.test(source)
        && !["gateway/reply-pipeline.mjs", "cards/confirm-flow.mjs"].includes(file)) {
        offenders.push(relative(root, resolve(root, file)));
      }
    }
    expect(offenders).toEqual([]);
  });
});

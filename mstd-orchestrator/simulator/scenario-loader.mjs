import { readFileSync, statSync } from "node:fs";
import { parseDocument } from "yaml";
import { validateScenarioObject } from "./scenario-schema.mjs";

const MAX_BYTES = 256 * 1024;

export function loadScenarioFile(path, opts = {}) {
  const st = statSync(path);
  if (st.size > MAX_BYTES) throw new Error(`scenario file too large (>${MAX_BYTES} bytes)`);
  const raw = readFileSync(path, "utf8");
  return loadScenarioYaml(raw, opts);
}

export function loadScenarioYaml(raw, opts = {}) {
  if (Buffer.byteLength(raw, "utf8") > MAX_BYTES) {
    throw new Error(`scenario yaml too large (>${MAX_BYTES} bytes)`);
  }
  // Reject YAML anchors/aliases to avoid recursive expansion bombs
  if (/(^|\s)&\w+|(\s)\*\w+/.test(raw)) {
    throw new Error("YAML anchors/aliases are not allowed");
  }
  const doc = parseDocument(raw, { uniqueKeys: true, maxAliasCount: 0 });
  if (doc.errors?.length) {
    throw new Error(`YAML parse error: ${doc.errors[0].message}`);
  }
  const data = doc.toJS({ maxAliasCount: 0 });
  return validateScenarioObject(data, opts);
}

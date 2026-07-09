import { describe, it, expect } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createSessionStore } from "../server/sessions/store.mjs";

describe("session store", () => {
  it("getOrCreate 幂等；append/transcript 按 ts 序；软删不出现在 transcript；版本自增", () => {
    const db = openDb();
    migrate(db);
    const store = createSessionStore(db);
    const s1 = store.getOrCreate("feishu:p2p:ou_a", { kind: "p2p", title: "张三" });
    const s2 = store.getOrCreate("feishu:p2p:ou_a");
    expect(s2.id).toBe(s1.id);

    const m1 = store.append(s1.id, { role: "user", senderOpenId: "ou_a", content: "第一句", ts: 1000 });
    store.append(s1.id, { role: "assistant", content: "回复", ts: 2000 });
    expect(store.transcript(s1.id).map((m) => m.content)).toEqual(["第一句", "回复"]);

    store.softDelete(m1.id);
    expect(store.transcript(s1.id).map((m) => m.content)).toEqual(["回复"]);

    expect(store.bumpVersion(s1.id)).toBe(1);
    expect(store.bumpVersion(s1.id)).toBe(2);
  });
});

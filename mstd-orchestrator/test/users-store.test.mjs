import { describe, it, expect, beforeEach } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { upsertUserByOpenId, getUserById } from "../server/store/users.mjs";

let db;
beforeEach(() => { db = openDb(); migrate(db); });

describe("upsertUserByOpenId", () => {
  it("inserts a new user with default role", () => {
    const u = upsertUserByOpenId(db, { openId: "ou_a", name: "张三", avatar: "http://x" }, 100);
    expect(u.feishu_open_id).toBe("ou_a");
    expect(u.role).toBe("user");
    expect(getUserById(db, u.id).name).toBe("张三");
  });
  it("updates name/avatar on conflict, keeps id + created_at", () => {
    const first = upsertUserByOpenId(db, { openId: "ou_a", name: "张三" }, 100);
    const second = upsertUserByOpenId(db, { openId: "ou_a", name: "张三改", avatar: "http://y" }, 200);
    expect(second.id).toBe(first.id);
    expect(second.name).toBe("张三改");
    expect(second.avatar).toBe("http://y");
    expect(second.created_at).toBe(100);
    const count = db.prepare("SELECT COUNT(*) AS c FROM users").get().c;
    expect(count).toBe(1);
  });
});

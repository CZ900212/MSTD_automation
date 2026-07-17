import { randomUUID } from "node:crypto";
import { buildUpsert } from "../db/dialect.mjs";

const USER_COLS = ["id", "feishu_open_id", "name", "avatar", "role", "created_at"];

export function upsertUserByOpenId(db, { openId, name = null, avatar = null, role = "user" }, now = Date.now(), dialect = "sqlite") {
  const sql = buildUpsert({
    dialect, table: "users", columns: USER_COLS,
    conflictColumns: ["feishu_open_id"], updateColumns: ["name", "avatar"],
  });
  db.prepare(sql).run(randomUUID(), openId, name, avatar, role, now);
  return db.prepare("SELECT * FROM users WHERE feishu_open_id = ?").get(openId);
}

export function getUserById(db, id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
}

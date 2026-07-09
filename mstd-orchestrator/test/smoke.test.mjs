import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";

describe("smoke", () => {
  it("vitest runs", () => {
    expect(1 + 1).toBe(2);
  });
  it("better-sqlite3 opens an in-memory db", () => {
    const db = new Database(":memory:");
    const row = db.prepare("SELECT 1 AS n").get();
    expect(row.n).toBe(1);
    db.close();
  });
});

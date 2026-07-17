function placeholders(n) { return Array.from({ length: n }, () => "?").join(", "); }

export function buildInsertIgnore({ dialect = "sqlite", table, columns, conflictColumns = [] }) {
  const cols = columns.join(", ");
  const ph = placeholders(columns.length);
  if (dialect === "sqlite") {
    return `INSERT OR IGNORE INTO ${table} (${cols}) VALUES (${ph})`;
  }
  if (dialect === "postgres") {
    return `INSERT INTO ${table} (${cols}) VALUES (${ph}) ON CONFLICT (${conflictColumns.join(", ")}) DO NOTHING`;
  }
  throw new Error(`unknown dialect: ${dialect}`);
}

export function buildUpsert({ dialect = "sqlite", table, columns, conflictColumns, updateColumns }) {
  if (dialect !== "sqlite" && dialect !== "postgres") throw new Error(`unknown dialect: ${dialect}`);
  const cols = columns.join(", ");
  const ph = placeholders(columns.length);
  const set = updateColumns.map((c) => `${c} = excluded.${c}`).join(", ");
  return `INSERT INTO ${table} (${cols}) VALUES (${ph}) ON CONFLICT (${conflictColumns.join(", ")}) DO UPDATE SET ${set}`;
}

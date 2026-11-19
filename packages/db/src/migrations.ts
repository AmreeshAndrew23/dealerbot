import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { withTx } from "./index";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

/** Applies migrations/*.sql in name order, each in its own transaction. Returns applied names. */
export async function runMigrations(db: pg.Pool): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await db.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = await readFile(path.join(dir, f), "utf8");
    await withTx(async (tx) => {
      await tx.query(sql);
      await tx.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
    }, db);
    applied.push(f);
  }
  return applied;
}

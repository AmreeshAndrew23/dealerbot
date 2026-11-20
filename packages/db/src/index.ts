import pg from "pg";
import { getConfig } from "@fmcg/config";

// numeric -> string (never float) for money and quantities; timestamptz stays Date.
pg.types.setTypeParser(1700, (v) => v);

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    // Connections default to system mode (workers, CLIs, webhook intake, auth lookups).
    // Staff requests switch to the restricted role per transaction with withTenantTx.
    pool = new pg.Pool({ connectionString: getConfig().DATABASE_URL, max: 10, options: "-c app.role=system" });
    pool.on("error", (err) => console.error("pg pool error", err));
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

/** Runs fn inside one transaction. Never make network calls to third parties inside fn. */
export async function withTx<T>(fn: (tx: Tx) => Promise<T>, db: pg.Pool = getPool()): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export { runMigrations } from "./migrations";

/**
 * Transaction for staff requests: runs as role fmcg_app with app.tenant_id set, so row-level
 * security hides every other tenant's rows. The tenant always comes from the session, never the body.
 */
export async function withTenantTx<T>(tenantId: string, fn: (tx: Tx) => Promise<T>, db: pg.Pool = getPool()): Promise<T> {
  return withTx(async (tx) => {
    await tx.query("SET LOCAL ROLE fmcg_app");
    await tx.query("SELECT set_config('app.role', 'staff', true), set_config('app.tenant_id', $1, true)", [tenantId]);
    return fn(tx);
  }, db);
}

export async function writeAudit(
  tx: Tx,
  e: {
    tenant_id: string | null;
    actor_type: "system" | "user" | "connector" | "provider" | "platform_admin";
    actor_id: string | null;
    action: string;
    entity_type: string;
    entity_id: string | null;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO audit_events (tenant_id, actor_type, actor_id, action, entity_type, entity_id, details_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [e.tenant_id, e.actor_type, e.actor_id, e.action, e.entity_type, e.entity_id, e.details ?? {}],
  );
}

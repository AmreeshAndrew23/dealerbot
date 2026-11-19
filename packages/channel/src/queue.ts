import PgBoss from "pg-boss";
import { QUEUES } from "@fmcg/contracts";
import type { Tx } from "@fmcg/db";

export type Boss = PgBoss;

/**
 * Starts pg-boss. The API only enqueues (no maintenance or scheduling); the worker runs everything.
 * pg-boss keeps its tables in the "pgboss" schema of the same database, so jobs can be inserted in
 * the same transaction as business data.
 */
export async function startBoss(connectionString: string, role: "api" | "worker"): Promise<PgBoss> {
  const boss = new PgBoss({
    connectionString,
    application_name: `fmcg-${role}`,
    supervise: role === "worker",
    schedule: role === "worker",
  });
  boss.on("error", (err) => console.error("pg-boss error", err));
  await boss.start();
  await ensureQueues(boss);
  await grantQueueAccess(connectionString);
  return boss;
}

async function ensureQueues(boss: PgBoss): Promise<void> {
  const defs: PgBoss.Queue[] = [
    { name: QUEUES.inbound, retryLimit: 8, retryDelay: 2, retryBackoff: true },
    { name: QUEUES.media, retryLimit: 6, retryDelay: 5, retryBackoff: true },
    { name: QUEUES.send, retryLimit: 6, retryDelay: 5, retryBackoff: true },
  ];
  for (const q of defs) {
    if (!(await boss.getQueue(q.name))) await boss.createQueue(q.name, q);
  }
}

/** Staff transactions run as fmcg_app and may enqueue jobs (e.g. a human reply). */
async function grantQueueAccess(connectionString: string): Promise<void> {
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString });
  await c.connect();
  try {
    const role = await c.query("SELECT 1 FROM pg_roles WHERE rolname = 'fmcg_app'");
    if (role.rowCount) {
      await c.query("GRANT USAGE ON SCHEMA pgboss TO fmcg_app");
      await c.query("GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA pgboss TO fmcg_app");
    }
  } catch (err) {
    console.warn("could not grant pg-boss access to fmcg_app:", (err as Error).message);
  } finally {
    await c.end();
  }
}

/** Enqueues a job inside an open transaction: it only becomes visible if the transaction commits. */
export async function sendInTx(boss: PgBoss, tx: Tx, queue: string, data: object): Promise<void> {
  await boss.send(queue, data, {
    db: { executeSql: (text: string, values: any[]) => tx.query(text, values) },
  });
}

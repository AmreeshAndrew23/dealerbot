// CLI: pnpm db:migrate
import { closePool, getPool } from "./index";
import { runMigrations } from "./migrations";

try {
  const applied = await runMigrations(getPool());
  for (const f of applied) console.log(`applied ${f}`);
  console.log(applied.length ? `${applied.length} migration(s) applied` : "database is up to date");
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await closePool();
}

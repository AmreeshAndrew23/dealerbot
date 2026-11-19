// Loads a catalogue CSV into a distributor's products (same rules as the dashboard upload).
//   pnpm catalogue:import --file data/britannia/catalogue.csv [--tenant "Britannia Distributor"] [--dry-run] [--hide-missing]
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "@fmcg/config";
import { closePool, withTx, writeAudit } from "@fmcg/db";
import { importCatalogue } from "@fmcg/catalogue";
import { resolveTenant } from "./tenant";

const { values } = parseArgs({
  options: {
    file: { type: "string" },
    tenant: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    "hide-missing": { type: "boolean", default: false },
  },
});
if (!values.file) {
  console.error('Usage: pnpm catalogue:import --file data/britannia/catalogue.csv [--tenant "Name"] [--dry-run] [--hide-missing]');
  process.exit(1);
}

try {
  const csv = readFileSync(path.resolve(repoRoot, values.file), "utf8");
  const res = await withTx(async (tx) => {
    const tenant = await resolveTenant(tx, values.tenant);
    const r = await importCatalogue(tx, tenant.id, csv, { dryRun: values["dry-run"]!, hideMissing: values["hide-missing"]! });
    if (r.applied) {
      await writeAudit(tx, { tenant_id: tenant.id, actor_type: "system", actor_id: null, action: "catalogue.imported", entity_type: "catalogue", entity_id: null, details: { counts: r.counts, source: values.file } });
    }
    return { ...r, tenant: tenant.name };
  });
  for (const e of res.errors) console.error(`line ${e.line}: ${e.message}`);
  const c = res.counts;
  console.log(`${res.tenant}: ${c.rows} rows, ${c.create} new, ${c.update} changed, ${c.unchanged} unchanged, ${c.hide} to hide`);
  console.log(res.applied ? "Saved." : res.errors.length ? "Nothing saved: fix the errors above." : "Dry run: nothing saved.");
  if (res.errors.length) process.exitCode = 1;
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await closePool();
}

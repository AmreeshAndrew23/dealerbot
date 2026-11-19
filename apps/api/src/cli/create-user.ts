// Creates (or updates) a staff user and gives them a role in a distributor. Used to create the
// first OWNER; everyone else is invited from the dashboard.
//   pnpm user:create --tenant "Demo Distributor" --email owner@example.com --name "Owner" --role OWNER
// The password is read from the FMCG_NEW_PASSWORD environment variable or prompted for.
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { closePool, withTx, writeAudit } from "@fmcg/db";
import { hashPassword, passwordProblem } from "../auth/password";

const { values } = parseArgs({
  options: {
    tenant: { type: "string" },
    email: { type: "string" },
    name: { type: "string" },
    role: { type: "string", default: "OWNER" },
  },
});
if (!values.tenant || !values.email || !values.name || !["OWNER", "OPERATOR", "VIEWER"].includes(values.role!)) {
  console.error('Usage: pnpm user:create --tenant "Demo Distributor" --email you@example.com --name "Your Name" [--role OWNER|OPERATOR|VIEWER]');
  process.exit(1);
}

async function readPassword(): Promise<string> {
  if (process.env.FMCG_NEW_PASSWORD) return process.env.FMCG_NEW_PASSWORD;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const pw = await rl.question("Password (min 10 characters): ");
  rl.close();
  return pw;
}

try {
  const password = await readPassword();
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);
  const hash = await hashPassword(password);
  const out = await withTx(async (tx) => {
    const t =
      (await tx.query<{ id: string }>(`SELECT id FROM tenants WHERE name = $1`, [values.tenant])).rows[0] ??
      (await tx.query<{ id: string }>(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [values.tenant])).rows[0]!;
    const u = (
      await tx.query<{ id: string }>(
        `INSERT INTO users (auth_subject, email, display_name, password_hash) VALUES ($1,$2,$3,$4)
         ON CONFLICT (auth_subject) DO UPDATE SET display_name = EXCLUDED.display_name, password_hash = EXCLUDED.password_hash,
           active = true, updated_at = now()
         RETURNING id`,
        [`local:${values.email!.toLowerCase()}`, values.email, values.name, hash],
      )
    ).rows[0]!;
    await tx.query(
      `INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,$3)
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role, active = true, updated_at = now()`,
      [t.id, u.id, values.role],
    );
    await writeAudit(tx, { tenant_id: t.id, actor_type: "system", actor_id: "cli", action: "user.created", entity_type: "user", entity_id: u.id, details: { role: values.role } });
    return { tenantId: t.id, userId: u.id };
  });
  console.log(`user ${values.email} is ${values.role} of "${values.tenant}" (tenant_id ${out.tenantId})`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await closePool();
}

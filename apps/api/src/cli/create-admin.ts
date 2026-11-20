// Creates (or updates) a platform admin: someone who can add and maintain dealers at /admin/.
// Admins are not dealer staff and are only made from the terminal.
//   pnpm admin:create --email you@example.com --name "Your Name"
// The password is read from the FMCG_NEW_PASSWORD environment variable or prompted for.
// --disable turns an admin off (their sessions end).
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { closePool, withTx, writeAudit } from "@fmcg/db";
import { hashPassword, passwordProblem } from "../auth/password";

const { values } = parseArgs({ options: { email: { type: "string" }, name: { type: "string" }, disable: { type: "boolean", default: false } } });
if (!values.email || (!values.disable && !values.name)) {
  console.error('Usage: pnpm admin:create --email you@example.com --name "Your Name"\n       pnpm admin:create --email you@example.com --disable');
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
  if (values.disable) {
    await withTx(async (tx) => {
      const a = (await tx.query<{ id: string }>(`UPDATE platform_admins SET active = false, updated_at = now() WHERE lower(email) = lower($1) RETURNING id`, [values.email])).rows[0];
      if (!a) throw new Error(`no admin ${values.email}`);
      await tx.query(`DELETE FROM platform_admin_sessions WHERE admin_id = $1`, [a.id]);
      await writeAudit(tx, { tenant_id: null, actor_type: "system", actor_id: "cli", action: "admin.disabled", entity_type: "platform_admin", entity_id: a.id });
    });
    console.log(`admin ${values.email} disabled`);
  } else {
    const password = await readPassword();
    const problem = passwordProblem(password);
    if (problem) throw new Error(problem);
    const hash = await hashPassword(password);
    const id = await withTx(async (tx) => {
      const existing = (await tx.query<{ id: string }>(`SELECT id FROM platform_admins WHERE lower(email) = lower($1)`, [values.email])).rows[0];
      const a = existing
        ? (await tx.query<{ id: string }>(`UPDATE platform_admins SET display_name = $2, password_hash = $3, active = true, updated_at = now() WHERE id = $1 RETURNING id`, [existing.id, values.name, hash])).rows[0]!
        : (await tx.query<{ id: string }>(`INSERT INTO platform_admins (email, display_name, password_hash) VALUES ($1,$2,$3) RETURNING id`, [values.email, values.name, hash])).rows[0]!;
      if (existing) await tx.query(`DELETE FROM platform_admin_sessions WHERE admin_id = $1`, [a.id]);
      await writeAudit(tx, { tenant_id: null, actor_type: "system", actor_id: "cli", action: existing ? "admin.updated" : "admin.created", entity_type: "platform_admin", entity_id: a.id });
      return a.id;
    });
    console.log(`admin ${values.email} can sign in at /admin/ (id ${id})`);
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await closePool();
}

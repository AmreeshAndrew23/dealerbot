// Registers a distributor (tenant) and its WhatsApp number.
//   pnpm channel:add --tenant "Demo Distributor" --phone-number-id 1234567890 --display "+91 98765 43210" [--waba 111] [--secret env:WHATSAPP_ACCESS_TOKEN]
import { parseArgs } from "node:util";
import { closePool, withTx, writeAudit } from "@fmcg/db";

const { values } = parseArgs({
  options: {
    tenant: { type: "string" },
    "phone-number-id": { type: "string" },
    display: { type: "string" },
    waba: { type: "string" },
    secret: { type: "string", default: "env:WHATSAPP_ACCESS_TOKEN" },
  },
});

if (!values.tenant || !values["phone-number-id"]) {
  console.error('Usage: pnpm channel:add --tenant "Name" --phone-number-id <id> [--display "+91..."] [--waba <id>]');
  process.exit(1);
}

try {
  const out = await withTx(async (tx) => {
    const existing = await tx.query<{ id: string }>(`SELECT id FROM tenants WHERE name = $1`, [values.tenant]);
    const tenantId =
      existing.rows[0]?.id ??
      (await tx.query<{ id: string }>(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [values.tenant])).rows[0]!.id;
    const acc = await tx.query<{ id: string }>(
      `INSERT INTO channel_accounts (tenant_id, provider_phone_id, display_phone, waba_id, secret_reference, status)
       VALUES ($1,$2,$3,$4,$5,'active')
       ON CONFLICT (provider_phone_id) DO UPDATE
         SET display_phone = EXCLUDED.display_phone, waba_id = EXCLUDED.waba_id,
             secret_reference = EXCLUDED.secret_reference, updated_at = now()
         WHERE channel_accounts.tenant_id = EXCLUDED.tenant_id
       RETURNING id`,
      [tenantId, values["phone-number-id"], values.display ?? null, values.waba ?? null, values.secret],
    );
    if (!acc.rows[0]) throw new Error("This phone number ID already belongs to another tenant.");
    await writeAudit(tx, {
      tenant_id: tenantId,
      actor_type: "system",
      actor_id: "cli",
      action: "channel_account.upsert",
      entity_type: "channel_account",
      entity_id: acc.rows[0].id,
      details: { provider_phone_id: values["phone-number-id"] },
    });
    return { tenantId, channelAccountId: acc.rows[0].id };
  });
  console.log(`tenant_id          ${out.tenantId}\nchannel_account_id ${out.channelAccountId}`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await closePool();
}

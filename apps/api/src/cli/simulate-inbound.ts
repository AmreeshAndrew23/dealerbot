// Posts a correctly signed, Meta-shaped webhook to the local API, so the whole inbound path can
// be tested without a phone. Uses the first active channel account.
//   pnpm wa:simulate --from +919876543210 --text "2 case Product A 100g" [--url http://localhost:3000]
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { getConfig } from "@fmcg/config";
import { signMetaPayload } from "@fmcg/channel";
import { closePool, getPool } from "@fmcg/db";

const { values } = parseArgs({
  options: {
    from: { type: "string", default: "+919876543210" },
    text: { type: "string", default: "Send 2 cases of Product A 100g" },
    name: { type: "string", default: "Test Retailer" },
    url: { type: "string" },
    repeat: { type: "string", default: "1" },
  },
});

try {
  const cfg = getConfig();
  if (!cfg.WHATSAPP_APP_SECRET) throw new Error("Set WHATSAPP_APP_SECRET in .env first.");
  const acc = (await getPool().query(`SELECT provider_phone_id, display_phone FROM channel_accounts WHERE status='active' ORDER BY created_at LIMIT 1`)).rows[0];
  if (!acc) throw new Error("No channel account. Run pnpm channel:add first.");
  const waId = values.from!.replace(/^\+/, "");
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "SIMULATED_WABA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: acc.display_phone ?? "", phone_number_id: acc.provider_phone_id },
              contacts: [{ profile: { name: values.name }, wa_id: waId }],
              messages: [
                { from: waId, id: `wamid.SIM_${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: values.text } },
              ],
            },
          },
        ],
      },
    ],
  });
  const url = `${values.url ?? `http://localhost:${cfg.PORT}`}/webhooks/whatsapp`;
  for (let i = 0; i < Number(values.repeat); i++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signMetaPayload(body, cfg.WHATSAPP_APP_SECRET) },
      body,
    });
    console.log(`POST ${url} -> ${res.status} ${await res.text()}`);
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await closePool();
}

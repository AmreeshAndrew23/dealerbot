// Connectivity check: sends an approved template straight through the Graph API (bypasses the
// queue). Meta test numbers can only start a conversation with a template such as hello_world.
//   pnpm wa:send-template --to +919876543210 [--template hello_world] [--lang en_US]
import { parseArgs } from "node:util";
import { getConfig, resolveSecret } from "@fmcg/config";
import { GraphApiError, GraphClient } from "@fmcg/channel";
import { closePool, getPool } from "@fmcg/db";

const { values } = parseArgs({
  options: {
    to: { type: "string" },
    template: { type: "string", default: "hello_world" },
    lang: { type: "string", default: "en_US" },
    "phone-number-id": { type: "string" },
  },
});
if (!values.to || !/^\+\d{6,15}$/.test(values.to)) {
  console.error("Usage: pnpm wa:send-template --to +919876543210 [--template hello_world] [--lang en_US]");
  process.exit(1);
}

try {
  const cfg = getConfig();
  const q = values["phone-number-id"]
    ? await getPool().query(`SELECT provider_phone_id, secret_reference FROM channel_accounts WHERE provider_phone_id = $1`, [values["phone-number-id"]])
    : await getPool().query(`SELECT provider_phone_id, secret_reference FROM channel_accounts WHERE status = 'active' ORDER BY created_at LIMIT 1`);
  const acc = q.rows[0];
  if (!acc) throw new Error("No channel account. Run pnpm channel:add first.");
  const graph = new GraphClient({ accessToken: resolveSecret(acc.secret_reference), apiVersion: cfg.GRAPH_API_VERSION });
  const id = await graph.sendMessage(acc.provider_phone_id, values.to, {
    kind: "template",
    name: values.template!,
    language: values.lang!,
    body_params: [],
  });
  console.log(`sent: ${id}`);
} catch (err) {
  if (err instanceof GraphApiError) console.error(`Graph API error ${err.httpStatus}: ${err.message}`, err.details);
  else console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await closePool();
}

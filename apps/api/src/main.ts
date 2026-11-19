import { getConfig, mediaDir } from "@fmcg/config";
import { LocalStorage, startBoss } from "@fmcg/channel";
import { closePool } from "@fmcg/db";
import { buildServer } from "./server";

const config = getConfig();
if (!config.WHATSAPP_APP_SECRET || !config.WHATSAPP_VERIFY_TOKEN) {
  console.warn("WHATSAPP_APP_SECRET / WHATSAPP_VERIFY_TOKEN are empty: webhooks will be rejected until set in .env");
}

const boss = await startBoss(config.DATABASE_URL, "api");
const app = buildServer({ config, boss, storage: new LocalStorage(mediaDir(config)), secureCookie: process.env.NODE_ENV === "production" });

const shutdown = async () => {
  await app.close();
  await boss.stop({ graceful: true });
  await closePool();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: config.PORT, host: "0.0.0.0" });

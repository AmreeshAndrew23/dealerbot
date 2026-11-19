import { getConfig, mediaDir } from "@fmcg/config";
import { InboundJob, MediaJob, QUEUES, SendJob } from "@fmcg/contracts";
import { handleInboundJob, handleMediaJob, handleSendJob, LocalStorage, startBoss } from "@fmcg/channel";
import { closePool } from "@fmcg/db";

const config = getConfig();
const boss = await startBoss(config.DATABASE_URL, "worker");
const storage = new LocalStorage(mediaDir(config));
const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ time: new Date().toISOString(), ...o }));

await boss.work(QUEUES.inbound, { batchSize: 1, pollingIntervalSeconds: 0.5 }, async ([job]) => {
  const data = InboundJob.parse(job!.data);
  const out = await handleInboundJob(data.webhook_event_id, boss);
  log({ queue: QUEUES.inbound, job: job!.id, result: out.result, type: out.event?.type, conversation: out.conversationId });
});

await boss.work(QUEUES.media, { batchSize: 1, pollingIntervalSeconds: 1, includeMetadata: true }, async ([job]) => {
  const data = MediaJob.parse(job!.data);
  const res = await handleMediaJob(data, {
    apiVersion: config.GRAPH_API_VERSION,
    storage,
    maxBytes: config.MEDIA_MAX_BYTES,
    retentionDays: config.MEDIA_RETENTION_DAYS,
  });
  log({ queue: QUEUES.media, job: job!.id, result: res, retry: job!.retryCount });
});

await boss.work(QUEUES.send, { batchSize: 1, pollingIntervalSeconds: 0.5, includeMetadata: true }, async ([job]) => {
  const data = SendJob.parse(job!.data);
  await handleSendJob(data, { apiVersion: config.GRAPH_API_VERSION, lastAttempt: job!.retryCount >= job!.retryLimit });
  log({ queue: QUEUES.send, job: job!.id, outbound: data.outbound_id, retry: job!.retryCount });
});

log({ msg: "worker started", queues: Object.values(QUEUES) });

const shutdown = async () => {
  await boss.stop({ graceful: true, timeout: 10_000 });
  await closePool();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

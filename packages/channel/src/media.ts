// Media job (PRD flow D): download through the provider with the channel's token, validate type
// and size, hash, store under a tenant-scoped key, and link to the message. Problems are recorded
// on messages.review_reason so an operator sees why.
import { createHash, randomUUID } from "node:crypto";
import type { MediaJob } from "@fmcg/contracts";
import { resolveSecret } from "@fmcg/config";
import { getPool, withTx } from "@fmcg/db";
import { GraphApiError, GraphClient, MediaTooLargeError } from "./graph-client";
import { mediaKey, type ObjectStorage } from "./storage";

export const ALLOWED_MEDIA: Record<string, string> = {
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/aac": ".aac",
  "audio/amr": ".amr",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
};

export function baseMime(mime: string): string {
  return mime.split(";")[0]!.trim().toLowerCase();
}

export interface MediaDeps {
  apiVersion: string;
  storage: ObjectStorage;
  maxBytes: number;
  retentionDays: number;
  graphFactory?: (token: string) => GraphClient;
}

export async function handleMediaJob(job: MediaJob, deps: MediaDeps): Promise<"STORED" | "REJECTED" | "SKIPPED"> {
  const r = await getPool().query<{
    provider_media_id: string | null;
    media_mime_type: string | null;
    media_id: string | null;
    secret_reference: string;
  }>(
    `SELECT m.provider_media_id, m.media_mime_type, m.media_id, ca.secret_reference
       FROM messages m JOIN channel_accounts ca ON ca.tenant_id = m.tenant_id AND ca.id = m.channel_account_id
      WHERE m.tenant_id = $1 AND m.id = $2`,
    [job.tenant_id, job.message_id],
  );
  const row = r.rows[0];
  if (!row || !row.provider_media_id || row.media_id) return "SKIPPED";

  const reject = async (reason: string) => {
    await withTx((tx) =>
      tx.query(`UPDATE messages SET review_reason = $3 WHERE tenant_id = $1 AND id = $2`, [job.tenant_id, job.message_id, reason]),
    );
    return "REJECTED" as const;
  };

  const declared = baseMime(row.media_mime_type ?? "");
  if (!ALLOWED_MEDIA[declared]) return reject(`UNSUPPORTED_MEDIA_TYPE:${declared || "unknown"}`);

  const graph = (deps.graphFactory ?? ((t) => new GraphClient({ accessToken: t, apiVersion: deps.apiVersion })))(
    resolveSecret(row.secret_reference),
  );

  let data: Buffer;
  let mime: string;
  try {
    const info = await graph.getMediaInfo(row.provider_media_id);
    mime = baseMime(info.mime_type ?? declared);
    if (!ALLOWED_MEDIA[mime]) return reject(`UNSUPPORTED_MEDIA_TYPE:${mime}`);
    if (info.file_size && info.file_size > deps.maxBytes) return reject("MEDIA_TOO_LARGE");
    data = await graph.downloadMedia(info.url, deps.maxBytes);
  } catch (err) {
    if (err instanceof MediaTooLargeError) return reject("MEDIA_TOO_LARGE");
    if (err instanceof GraphApiError && !err.retryable) return reject(`MEDIA_DOWNLOAD_FAILED:${err.httpStatus}`);
    throw err; // transient: pg-boss retries
  }

  const sha256 = createHash("sha256").update(data).digest("hex");
  const mediaId = randomUUID();
  const key = mediaKey(job.tenant_id, mediaId, ALLOWED_MEDIA[mime]!);
  await deps.storage.put(key, data, mime);

  await withTx(async (tx) => {
    await tx.query(
      `INSERT INTO media_assets (id, tenant_id, storage_key, mime_type, size_bytes, sha256, delete_after)
       VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(days => $7))`,
      [mediaId, job.tenant_id, key, mime, data.length, sha256, deps.retentionDays],
    );
    // Duration (<=120 s for voice) is checked by the voice pipeline (E15), which decodes the audio.
    await tx.query(`UPDATE messages SET media_id = $3 WHERE tenant_id = $1 AND id = $2 AND media_id IS NULL`, [
      job.tenant_id,
      job.message_id,
      mediaId,
    ]);
  });
  return "STORED";
}

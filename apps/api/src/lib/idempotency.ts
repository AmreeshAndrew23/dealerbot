import { createHash } from "node:crypto";
import type { Tx } from "@fmcg/db";
import { ApiError, badRequest } from "./errors";

export interface StoredResponse {
  status: number;
  body: unknown;
}

/**
 * Idempotency-Key handling (PRD section 8). Runs inside the caller's transaction:
 * - same key + same request: returns the stored response, handler not run again;
 * - same key + different request: 409;
 * - concurrent duplicates: the unique key makes the second wait for the first to commit.
 */
export async function idempotent(
  tx: Tx,
  scope: { tenantId: string; actorId: string; route: string; key: string | undefined },
  request: unknown,
  handler: () => Promise<StoredResponse>,
): Promise<StoredResponse> {
  const key = scope.key?.trim();
  if (!key) throw badRequest("Idempotency-Key header is required for this request.");
  if (key.length > 200) throw badRequest("Idempotency-Key is too long.");
  const hash = createHash("sha256").update(JSON.stringify(request ?? null)).digest("hex");

  const ins = await tx.query(
    `INSERT INTO idempotency_keys (tenant_id, actor_id, route, key, request_hash)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING 1`,
    [scope.tenantId, scope.actorId, scope.route, key, hash],
  );
  if (!ins.rowCount) {
    const prev = await tx.query<{ request_hash: string; response_status: number | null; response_json: unknown }>(
      `SELECT request_hash, response_status, response_json FROM idempotency_keys
        WHERE tenant_id = $1 AND actor_id = $2 AND route = $3 AND key = $4`,
      [scope.tenantId, scope.actorId, scope.route, key],
    );
    const p = prev.rows[0];
    if (!p || p.request_hash !== hash) {
      throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was already used for a different request.");
    }
    return { status: p.response_status ?? 200, body: p.response_json };
  }
  const res = await handler();
  await tx.query(
    `UPDATE idempotency_keys SET response_status = $5, response_json = $6
      WHERE tenant_id = $1 AND actor_id = $2 AND route = $3 AND key = $4`,
    [scope.tenantId, scope.actorId, scope.route, key, res.status, JSON.stringify(res.body)],
  );
  return res;
}

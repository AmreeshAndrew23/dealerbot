// Learning from conversations. The order assistant reports what retailers actually typed; staff
// decide what becomes an alias. Matching only ever uses APPROVED aliases (architecture 8.3).
import type { Tx } from "@fmcg/db";
import { normaliseText } from "./normalise";

export type LearningEvent =
  /** The matcher was unsure; the retailer picked this product for these words. */
  | { kind: "picked"; phrase: string; sku: string }
  /** These words matched no product at all. */
  | { kind: "unmatched"; phrase: string };

export async function recordLearning(tx: Tx, tenantId: string, events: LearningEvent[]): Promise<void> {
  for (const e of events) {
    const norm = normaliseText(e.phrase);
    if (!norm || norm.length > 80) continue;
    if (e.kind === "unmatched") {
      await tx.query(
        `INSERT INTO unmatched_phrases (tenant_id, phrase_norm, example) VALUES ($1,$2,$3)
         ON CONFLICT (tenant_id, phrase_norm) DO UPDATE
           SET times_seen = unmatched_phrases.times_seen + 1, last_seen_at = now(), example = EXCLUDED.example`,
        [tenantId, norm, e.phrase.trim()],
      );
      continue;
    }
    const sku = (await tx.query<{ id: string; name: string }>(`SELECT id, name FROM skus WHERE tenant_id = $1 AND sku_code = $2`, [tenantId, e.sku])).rows[0];
    if (!sku || normaliseText(sku.name) === norm) continue;
    // Approved or rejected rows keep their status; only the counters move.
    await tx.query(
      `INSERT INTO sku_aliases (tenant_id, sku_id, alias, alias_norm, status, source, times_seen, last_seen_at, position)
       VALUES ($1,$2,$3,$4,'suggested','chat',1,now(), 1000)
       ON CONFLICT (tenant_id, sku_id, alias_norm) DO UPDATE
         SET times_seen = sku_aliases.times_seen + 1, last_seen_at = now()`,
      [tenantId, sku.id, e.phrase.trim(), norm],
    );
  }
}

export interface AliasSuggestion {
  id: string;
  alias: string;
  sku_id: string;
  sku: string;
  product_name: string;
  times_seen: number;
  last_seen_at: string;
}

export interface UnmatchedPhrase {
  id: string;
  example: string;
  times_seen: number;
  last_seen_at: string;
}

export async function listLearning(tx: Tx): Promise<{ suggestions: AliasSuggestion[]; unmatched: UnmatchedPhrase[] }> {
  const suggestions = await tx.query<AliasSuggestion>(
    `SELECT a.id, a.alias, s.id AS sku_id, s.sku_code AS sku, s.name AS product_name, a.times_seen, a.last_seen_at
       FROM sku_aliases a JOIN skus s ON s.tenant_id = a.tenant_id AND s.id = a.sku_id
      WHERE a.status = 'suggested' AND s.active
      ORDER BY a.times_seen DESC, a.last_seen_at DESC LIMIT 200`,
  );
  const unmatched = await tx.query<UnmatchedPhrase>(
    `SELECT id, example, times_seen, last_seen_at FROM unmatched_phrases WHERE status = 'open'
      ORDER BY times_seen DESC, last_seen_at DESC LIMIT 200`,
  );
  return { suggestions: suggestions.rows, unmatched: unmatched.rows };
}

/** Approve or reject a suggested alias. Returns the SKU it belongs to, or null if not pending. */
export async function reviewAlias(tx: Tx, id: string, decision: "approved" | "rejected", userId: string): Promise<{ sku_id: string; alias: string } | null> {
  const r = await tx.query<{ sku_id: string; alias: string }>(
    `UPDATE sku_aliases a SET status = $2, reviewed_by = $3, reviewed_at = now(),
            position = CASE WHEN $2 = 'approved'
              THEN (SELECT coalesce(max(position), 0) + 1 FROM sku_aliases b WHERE b.tenant_id = a.tenant_id AND b.sku_id = a.sku_id AND b.status = 'approved')
              ELSE position END
      WHERE id = $1 AND status = 'suggested' RETURNING sku_id, alias`,
    [id, decision, userId],
  );
  return r.rows[0] ?? null;
}

/** Turn an unmatched phrase into an approved alias of a product, or ignore it. */
export async function reviewUnmatched(
  tx: Tx,
  tenantId: string,
  id: string,
  decision: { link_sku_id: string } | "ignore",
  userId: string,
): Promise<{ example: string } | null> {
  const row = (await tx.query<{ example: string; phrase_norm: string }>(`SELECT example, phrase_norm FROM unmatched_phrases WHERE id = $1 AND status = 'open' FOR UPDATE`, [id])).rows[0];
  if (!row) return null;
  if (decision === "ignore") {
    await tx.query(`UPDATE unmatched_phrases SET status = 'ignored', reviewed_by = $2, reviewed_at = now() WHERE id = $1`, [id, userId]);
    return { example: row.example };
  }
  await tx.query(
    `INSERT INTO sku_aliases (tenant_id, sku_id, alias, alias_norm, status, source, reviewed_by, reviewed_at, position)
     VALUES ($1,$2,$3,$4,'approved','chat',$5,now(),
             (SELECT coalesce(max(position), 0) + 1 FROM sku_aliases WHERE tenant_id = $1 AND sku_id = $2 AND status = 'approved'))
     ON CONFLICT (tenant_id, sku_id, alias_norm) DO UPDATE SET status = 'approved', reviewed_by = $5, reviewed_at = now()`,
    [tenantId, decision.link_sku_id, row.example, row.phrase_norm, userId],
  );
  await tx.query(`UPDATE unmatched_phrases SET status = 'linked', linked_sku_id = $2, reviewed_by = $3, reviewed_at = now() WHERE id = $1`, [id, decision.link_sku_id, userId]);
  return { example: row.example };
}

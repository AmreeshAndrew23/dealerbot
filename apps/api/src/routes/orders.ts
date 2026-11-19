// Orders (architecture 9.1): the review queue, one order with checks and history, and the staff
// decisions. Approve / reject / cancel need Idempotency-Key and If-Match (lock_version), 7.3.
// Export to Tally (E14) picks up the export job that approval queues.
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { withTenantTx } from "@fmcg/db";
import { approveOrder, getOrder, listOrders, orderCounts, rejectOrCancel, ReviewError, reviewView } from "@fmcg/orders";
import { requireStaff } from "../auth/plugin";
import { ApiError, badRequest, notFound } from "../lib/errors";
import { idempotent } from "../lib/idempotency";
import { decodeCursor, encodeCursor, parseLimit } from "../lib/pagination";
import { parse } from "../lib/validate";

const STATUSES = ["READY_FOR_REVIEW", "APPROVED", "EXPORTING", "EXPORTED", "EXPORT_UNCERTAIN", "EXPORT_FAILED", "REJECTED", "CANCELLED", "EXPIRED"] as const;

function ifMatch(req: FastifyRequest): number {
  const raw = String(req.headers["if-match"] ?? "").replace(/^W\//, "").replace(/"/g, "").trim();
  if (!/^\d+$/.test(raw)) throw new ApiError(428, "PRECONDITION_REQUIRED", "If-Match header with the order's lock_version is required.");
  return Number(raw);
}

async function mapErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ReviewError) throw new ApiError(e.status, e.code, e.message, e.details);
    throw e;
  }
}

export const orderRoutes: FastifyPluginAsync = async (app) => {
  app.get("/v1/orders", async (req) => {
    const s = requireStaff(req, "orders.view");
    const q = parse(
      z.object({ limit: z.string().optional(), cursor: z.string().optional(), status: z.string().optional() }),
      req.query,
    );
    const statuses = q.status ? q.status.split(",") : undefined;
    if (statuses?.some((x) => !(STATUSES as readonly string[]).includes(x))) throw badRequest("Unknown status filter.");
    const limit = parseLimit(q.limit, 50);
    const before = decodeCursor(q.cursor);
    const { rows, counts } = await withTenantTx(s.tenantId, async (tx) => ({
      rows: await listOrders(tx, { limit: limit + 1, statuses, before }),
      counts: await orderCounts(tx),
    }));
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { orders: page, counts, next_cursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null };
  });

  app.get("/v1/orders/:id", async (req) => {
    const s = requireStaff(req, "orders.view");
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const out = await withTenantTx(s.tenantId, async (tx) => {
      const order = await getOrder(tx, id);
      if (!order) return null;
      return { ...order, ...(await reviewView(tx, id))! };
    });
    if (!out) throw notFound("Order");
    return out;
  });

  app.post("/v1/orders/:id/approve", async (req, reply) => {
    const s = requireStaff(req, "orders.approve");
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const body = parse(
      z.object({ version: z.number().int().positive(), summary_hash: z.string().min(1), acknowledged_warnings: z.array(z.string()).max(20).default([]) }),
      req.body,
    );
    const lockVersion = ifMatch(req);
    const res = await mapErrors(() =>
      withTenantTx(s.tenantId, (tx) =>
        idempotent(tx, { tenantId: s.tenantId, actorId: s.userId, route: `POST /orders/${id}/approve`, key: req.headers["idempotency-key"] as string | undefined }, { ...body, lockVersion }, async () => {
          const r = await approveOrder(tx, { orderId: id, userId: s.userId, lockVersion, version: body.version, summaryHash: body.summary_hash, acknowledged: body.acknowledged_warnings });
          return { status: 202, body: r };
        }),
      ),
    );
    return reply.status(res.status).send(res.body);
  });

  for (const event of ["reject", "cancel"] as const) {
    app.post(`/v1/orders/:id/${event}`, async (req, reply) => {
      const s = requireStaff(req, "orders.approve");
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
      const body = parse(z.object({ reason: z.string().trim().min(3, "Please give a reason.").max(500) }), req.body);
      const lockVersion = ifMatch(req);
      const res = await mapErrors(() =>
        withTenantTx(s.tenantId, (tx) =>
          idempotent(tx, { tenantId: s.tenantId, actorId: s.userId, route: `POST /orders/${id}/${event}`, key: req.headers["idempotency-key"] as string | undefined }, { ...body, lockVersion }, async () => ({
            status: 200,
            body: await rejectOrCancel(tx, event, { orderId: id, userId: s.userId, lockVersion, reason: body.reason }),
          })),
        ),
      );
      return reply.status(res.status).send(res.body);
    });
  }
};

// Retailers: the shops this distributor serves and the WhatsApp number each orders from.
// Only a recorded, active number gets prices, the product list or the order assistant.
// Everyone with orders.view may see the list; adding or changing one is contacts.authorise.
// Customer app access: staff create a 6-digit access code for a retailer and pass it on. Only its
// hash is stored, so the code is shown once; a new code (or removing access) signs old devices out.
import type { FastifyPluginAsync } from "fastify";
import { randomInt } from "node:crypto";
import { z } from "zod";
import { withTenantTx, writeAudit } from "@fmcg/db";
import { diffRetailer, getRetailer, insertRetailer, listRetailers, RetailerInput, setAppCode, updateRetailer } from "@fmcg/orders";
import { hashPassword } from "../auth/password";
import { requireStaff } from "../auth/plugin";
import { ApiError, notFound } from "../lib/errors";
import { parse } from "../lib/validate";

const phoneTaken = (phone: string) =>
  new ApiError(409, "PHONE_EXISTS", `Another retailer already uses ${phone}.`, { field: "phone" });
const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === "23505";

export const retailerRoutes: FastifyPluginAsync<{ appUrl: string }> = async (app, { appUrl }) => {
  app.post("/v1/retailers/:id/app-code", async (req) => {
    const s = requireStaff(req, "contacts.authorise");
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const hash = await hashPassword(code);
    return withTenantTx(s.tenantId, async (tx) => {
      const retailer = await setAppCode(tx, id, hash);
      if (!retailer) throw notFound("Retailer");
      await writeAudit(tx, { tenant_id: s.tenantId, actor_type: "user", actor_id: s.userId, action: "retailer.app_code_created", entity_type: "retailer", entity_id: id, details: { shop_name: retailer.shop_name } });
      return { code, app_url: appUrl, retailer };
    });
  });

  app.delete("/v1/retailers/:id/app-code", async (req) => {
    const s = requireStaff(req, "contacts.authorise");
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    return withTenantTx(s.tenantId, async (tx) => {
      const retailer = await setAppCode(tx, id, null);
      if (!retailer) throw notFound("Retailer");
      await writeAudit(tx, { tenant_id: s.tenantId, actor_type: "user", actor_id: s.userId, action: "retailer.app_access_removed", entity_type: "retailer", entity_id: id, details: { shop_name: retailer.shop_name } });
      return retailer;
    });
  });

  /** Numbers that messaged but are not connected (newest first), so staff can add them. */
  app.get("/v1/retailers/unknown-senders", async (req) => {
    const s = requireStaff(req, "orders.view");
    return withTenantTx(s.tenantId, async (tx) => ({
      senders: (
        await tx.query(
          `SELECT u.phone_e164 AS phone, u.profile_name, u.last_text, u.reason, u.attempts, u.first_at, u.last_at, r.shop_name
             FROM unknown_senders u
             LEFT JOIN retailers r ON r.tenant_id = u.tenant_id AND r.phone_e164 = u.phone_e164
            WHERE r.id IS NULL OR NOT r.active
            ORDER BY u.last_at DESC LIMIT 100`,
        )
      ).rows,
    }));
  });

  app.delete("/v1/retailers/unknown-senders/:phone", async (req) => {
    const s = requireStaff(req, "contacts.authorise");
    const { phone } = parse(z.object({ phone: z.string().regex(/^\+[1-9]\d{7,14}$/) }), req.params);
    return withTenantTx(s.tenantId, async (tx) => {
      const r = await tx.query(`DELETE FROM unknown_senders WHERE phone_e164 = $1`, [phone]);
      if (!r.rowCount) throw notFound("Number");
      await writeAudit(tx, { tenant_id: s.tenantId, actor_type: "user", actor_id: s.userId, action: "unknown_sender.dismissed", entity_type: "unknown_sender", entity_id: null, details: { phone } });
      return { ok: true };
    });
  });

  app.get("/v1/retailers", async (req) => {
    const s = requireStaff(req, "orders.view");
    return withTenantTx(s.tenantId, async (tx) => ({ retailers: await listRetailers(tx) }));
  });

  app.post("/v1/retailers", async (req, reply) => {
    const s = requireStaff(req, "contacts.authorise");
    const body = parse(RetailerInput, req.body);
    try {
      const r = await withTenantTx(s.tenantId, async (tx) => {
        const created = await insertRetailer(tx, s.tenantId, body, s.userId);
        // Added from the "tried to order" list: it is handled now.
        await tx.query(`DELETE FROM unknown_senders WHERE phone_e164 = $1`, [created.phone]);
        await writeAudit(tx, {
          tenant_id: s.tenantId,
          actor_type: "user",
          actor_id: s.userId,
          action: "retailer.created",
          entity_type: "retailer",
          entity_id: created.id,
          details: { shop_name: created.shop_name, phone: created.phone, active: created.active },
        });
        return created;
      });
      reply.status(201);
      return r;
    } catch (e) {
      if (isUniqueViolation(e)) throw phoneTaken(body.phone);
      throw e;
    }
  });

  /** Partial update: send only the fields that change (e.g. { active: false }). */
  app.patch("/v1/retailers/:id", async (req) => {
    const s = requireStaff(req, "contacts.authorise");
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const patch = parse(z.record(z.string(), z.unknown()), req.body);
    let phone = "";
    try {
      return await withTenantTx(s.tenantId, async (tx) => {
        const cur = await getRetailer(tx, id);
        if (!cur) throw notFound("Retailer");
        const next = parse(RetailerInput, {
          shop_name: cur.shop_name,
          contact_name: cur.contact_name,
          phone: cur.phone,
          area: cur.area,
          notes: cur.notes,
          active: cur.active,
          ...patch,
        });
        phone = next.phone;
        const changes = diffRetailer(cur, next);
        if (!Object.keys(changes).length) return cur;
        const saved = (await updateRetailer(tx, id, next))!;
        await writeAudit(tx, {
          tenant_id: s.tenantId,
          actor_type: "user",
          actor_id: s.userId,
          action: "retailer.updated",
          entity_type: "retailer",
          entity_id: id,
          details: { shop_name: saved.shop_name, changes },
        });
        return saved;
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw phoneTaken(phone);
      throw e;
    }
  });
};

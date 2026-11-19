// Catalogue: products, pack sizes, prices and retailer names. Viewers read; owners and operators edit.
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { withTenantTx, writeAudit } from "@fmcg/db";
import {
  catalogueTemplateCsv,
  catalogueToCsv,
  CSV_SPEC,
  changeStock,
  diffProduct,
  getProduct,
  importCatalogue,
  insertProduct,
  listLearning,
  listProducts,
  ProductInput,
  reviewAlias,
  reviewUnmatched,
  stockHistory,
  updateProduct,
} from "@fmcg/catalogue";
import { requireStaff } from "../auth/plugin";
import { ApiError, badRequest, notFound } from "../lib/errors";
import { parse } from "../lib/validate";

const MAX_CSV_CHARS = 900_000; // stays under the 1 MB request body limit

const skuTaken = (sku: string) => new ApiError(409, "SKU_EXISTS", `Another product already uses SKU ${sku}.`, { field: "sku" });
const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === "23505";

export const catalogueRoutes: FastifyPluginAsync = async (app) => {
  app.get("/v1/catalogue/products", async (req) => {
    const s = requireStaff(req, "catalogue.view");
    return withTenantTx(s.tenantId, async (tx) => ({ products: await listProducts(tx) }));
  });

  // ---- stock: what we have to sell (base units). Retailers cannot order more than this. --------

  app.post("/v1/catalogue/products/:id/stock", async (req) => {
    const s = requireStaff(req, "catalogue.edit");
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const body = parse(
      z.object({
        mode: z.enum(["set", "add", "untrack"]),
        quantity: z.coerce.number().nonnegative().max(10_000_000).optional(),
        unit: z.string().trim().toUpperCase().optional(),
        note: z.string().trim().max(200).optional(),
      }),
      req.body,
    );
    return withTenantTx(s.tenantId, async (tx) => {
      const p = await getProduct(tx, id, true);
      if (!p) throw notFound("Product");
      let base: number | undefined;
      if (body.mode !== "untrack") {
        if (body.quantity === undefined) throw badRequest("Enter a quantity.", { fields: [{ path: "quantity", message: "is required" }] });
        const unit = body.unit || p.base_unit;
        const per = p.pack_units[unit];
        if (!per) throw badRequest(`${unit} is not a pack of this product.`, { fields: [{ path: "unit", message: "unknown pack" }] });
        base = body.quantity * per;
        if (!Number.isInteger(base)) throw badRequest("Stock must be a whole number of pieces.", { fields: [{ path: "quantity", message: "must be whole pieces" }] });
        if (body.mode === "add" && base === 0) throw badRequest("Enter how much was received.", { fields: [{ path: "quantity", message: "must be more than 0" }] });
      }
      const before = p.stock === null ? null : Number(p.stock);
      const after = await changeStock(tx, s.tenantId, id, { mode: body.mode, quantity: base, note: body.note }, { type: "user", id: s.userId });
      await writeAudit(tx, {
        tenant_id: s.tenantId,
        actor_type: "user",
        actor_id: s.userId,
        action: "stock.changed",
        entity_type: "product",
        entity_id: id,
        details: { sku: p.sku, mode: body.mode, quantity: body.quantity ?? null, unit: body.unit ?? p.base_unit, before, after },
      });
      return { ...(await getProduct(tx, id))!, history: await stockHistory(tx, id, 10) };
    });
  });

  app.get("/v1/catalogue/products/:id/stock", async (req) => {
    const s = requireStaff(req, "catalogue.view");
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    return withTenantTx(s.tenantId, async (tx) => {
      if (!(await getProduct(tx, id))) throw notFound("Product");
      return { history: await stockHistory(tx, id, 30) };
    });
  });

  // ---- learning from conversations: staff decide what becomes an alias ----------------------

  app.get("/v1/catalogue/learning", async (req) => {
    const s = requireStaff(req, "catalogue.view");
    return withTenantTx(s.tenantId, (tx) => listLearning(tx));
  });

  app.post("/v1/catalogue/aliases/:id/:decision", async (req) => {
    const s = requireStaff(req, "catalogue.edit");
    const { id, decision } = parse(z.object({ id: z.string().uuid(), decision: z.enum(["approve", "reject"]) }), req.params);
    return withTenantTx(s.tenantId, async (tx) => {
      const r = await reviewAlias(tx, id, decision === "approve" ? "approved" : "rejected", s.userId);
      if (!r) throw notFound("Suggestion");
      await writeAudit(tx, {
        tenant_id: s.tenantId,
        actor_type: "user",
        actor_id: s.userId,
        action: decision === "approve" ? "alias.approved" : "alias.rejected",
        entity_type: "product",
        entity_id: r.sku_id,
        details: { alias: r.alias, alias_id: id },
      });
      return { ok: true };
    });
  });

  app.post("/v1/catalogue/unmatched/:id/link", async (req) => {
    const s = requireStaff(req, "catalogue.edit");
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const { sku_id } = parse(z.object({ sku_id: z.string().uuid() }), req.body);
    return withTenantTx(s.tenantId, async (tx) => {
      if (!(await getProduct(tx, sku_id))) throw notFound("Product");
      const r = await reviewUnmatched(tx, s.tenantId, id, { link_sku_id: sku_id }, s.userId);
      if (!r) throw notFound("Phrase");
      await writeAudit(tx, { tenant_id: s.tenantId, actor_type: "user", actor_id: s.userId, action: "alias.linked", entity_type: "product", entity_id: sku_id, details: { alias: r.example, phrase_id: id } });
      return { ok: true };
    });
  });

  app.post("/v1/catalogue/unmatched/:id/ignore", async (req) => {
    const s = requireStaff(req, "catalogue.edit");
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    return withTenantTx(s.tenantId, async (tx) => {
      const r = await reviewUnmatched(tx, s.tenantId, id, "ignore", s.userId);
      if (!r) throw notFound("Phrase");
      await writeAudit(tx, { tenant_id: s.tenantId, actor_type: "user", actor_id: s.userId, action: "phrase.ignored", entity_type: "unmatched_phrase", entity_id: id, details: { phrase: r.example } });
      return { ok: true };
    });
  });

  app.post("/v1/catalogue/products", async (req, reply) => {
    const s = requireStaff(req, "catalogue.edit");
    const body = parse(ProductInput, req.body);
    // Optional opening stock, in any of the product's packs; saved in the same transaction.
    const opening = parse(
      z.object({ stock_qty: z.coerce.number().nonnegative().max(10_000_000).optional(), stock_unit: z.string().trim().toUpperCase().optional() }),
      req.body,
    );
    let openingBase: number | undefined;
    if (opening.stock_qty !== undefined) {
      const unit = opening.stock_unit || body.base_unit;
      const per = body.pack_units[unit];
      if (!per) throw badRequest(`${unit} is not a pack of this product.`, { fields: [{ path: "stock_unit", message: "unknown pack" }] });
      openingBase = opening.stock_qty * per;
      if (!Number.isInteger(openingBase)) throw badRequest("Stock must be a whole number of pieces.", { fields: [{ path: "stock_qty", message: "must be whole pieces" }] });
    }
    try {
      const p = await withTenantTx(s.tenantId, async (tx) => {
        const created = await insertProduct(tx, s.tenantId, body);
        if (openingBase !== undefined) {
          await changeStock(tx, s.tenantId, created.id, { mode: "set", quantity: openingBase, note: "Opening stock" }, { type: "user", id: s.userId });
        }
        await writeAudit(tx, {
          tenant_id: s.tenantId,
          actor_type: "user",
          actor_id: s.userId,
          action: "product.created",
          entity_type: "product",
          entity_id: created.id,
          details: { sku: created.sku, opening_stock: openingBase ?? null },
        });
        return (await getProduct(tx, created.id))!;
      });
      reply.status(201);
      return p;
    } catch (e) {
      if (isUniqueViolation(e)) throw skuTaken(body.sku);
      throw e;
    }
  });

  /** Partial update: send only the fields that change (e.g. { dealer_price: "8.75" } or { active: false }). */
  app.patch("/v1/catalogue/products/:id", async (req) => {
    const s = requireStaff(req, "catalogue.edit");
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const patch = parse(z.record(z.string(), z.unknown()), req.body);
    try {
      return await withTenantTx(s.tenantId, async (tx) => {
        const cur = await getProduct(tx, id, true);
        if (!cur) throw notFound("Product");
        const { id: _i, source: _s, created_at: _c, updated_at: _u, ...base } = cur;
        const next = parse(ProductInput, { ...base, ...patch });
        const changes = diffProduct(cur, next);
        if (next.sku === cur.sku && !Object.keys(changes).length) return cur;
        const saved = await updateProduct(tx, id, next);
        await writeAudit(tx, {
          tenant_id: s.tenantId,
          actor_type: "user",
          actor_id: s.userId,
          action: "product.updated",
          entity_type: "product",
          entity_id: id,
          details: { sku: saved.sku, ...(next.sku !== cur.sku ? { sku_from: cur.sku } : {}), changes },
        });
        return saved;
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw skuTaken(String(patch.sku ?? "").toUpperCase());
      throw e;
    }
  });

  /** CSV upload. dry_run: true returns the preview (new, changed, errors) without saving. */
  app.post("/v1/catalogue/import", async (req) => {
    const s = requireStaff(req, "catalogue.edit");
    const body = parse(
      z.object({
        csv: z.string().min(1, "The file is empty.").max(MAX_CSV_CHARS, "The file is too large (limit about 900 KB)."),
        dry_run: z.boolean().default(true),
        hide_missing: z.boolean().default(false),
      }),
      req.body,
    );
    return withTenantTx(s.tenantId, async (tx) => {
      const res = await importCatalogue(tx, s.tenantId, body.csv, { dryRun: body.dry_run, hideMissing: body.hide_missing, actor: { type: "user", id: s.userId } });
      if (res.applied) {
        await writeAudit(tx, {
          tenant_id: s.tenantId,
          actor_type: "user",
          actor_id: s.userId,
          action: "catalogue.imported",
          entity_type: "catalogue",
          entity_id: null,
          details: { counts: res.counts, hidden: res.hide.map((h) => h.sku) },
        });
      }
      return res;
    });
  });

  /** All products as CSV, in the same format the upload accepts (open in Excel, edit, upload back). */
  app.get("/v1/catalogue/export.csv", async (req, reply) => {
    const s = requireStaff(req, "catalogue.view");
    const products = await withTenantTx(s.tenantId, (tx) => listProducts(tx));
    const day = new Date().toISOString().slice(0, 10);
    reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="catalogue-${day}.csv"`);
    return "﻿" + catalogueToCsv(products); // BOM so Excel reads Tamil text as UTF-8
  });

  /** Blank bulk-upload template with two EXAMPLE rows (skipped on upload) and the column guide. */
  app.get("/v1/catalogue/template.csv", async (req, reply) => {
    requireStaff(req, "catalogue.view");
    reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="catalogue-upload-template.csv"`);
    return "﻿" + catalogueTemplateCsv();
  });

  /** The column guide shown next to the upload (same source as the parser, so it never drifts). */
  app.get("/v1/catalogue/template-columns", async (req) => {
    requireStaff(req, "catalogue.view");
    return { columns: CSV_SPEC.map((c) => ({ head: c.head, required: !!c.required, help: c.help, example: c.example[0] })) };
  });
};

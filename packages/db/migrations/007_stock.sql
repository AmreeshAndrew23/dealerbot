-- Stock (catalogue module). Architecture 8.4 reads stock from Tally snapshots and only warns; the
-- product owner asked for a hard stop: retailers cannot order more than is available.
-- available = what can still be sold, in base units (PCS). A product without a stock_levels row is
-- "not tracked" (unlimited). Confirming an order deducts (ORDER); rejecting/cancelling it gives the
-- same quantity back (RELEASE). Staff set counts (SET) or add received stock (RECEIVE).
-- When the Tally stock sync arrives (E07) it writes SET movements from the snapshot.

CREATE TABLE stock_levels (
  tenant_id   uuid NOT NULL,
  sku_id      uuid NOT NULL,
  available   numeric(14,3) NOT NULL CHECK (available >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, sku_id),
  FOREIGN KEY (tenant_id, sku_id) REFERENCES skus (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE stock_movements (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  sku_id         uuid NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('SET', 'RECEIVE', 'ORDER', 'RELEASE', 'UNTRACK')),
  quantity       numeric(14,3) NOT NULL,           -- change in base units (SET: the new level)
  balance_after  numeric(14,3),                    -- null after UNTRACK
  order_id       uuid,
  note           text,
  actor_type     text NOT NULL CHECK (actor_type IN ('user', 'system')),
  actor_id       text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, sku_id) REFERENCES skus (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id)
);
CREATE INDEX stock_movements_sku_idx ON stock_movements (tenant_id, sku_id, created_at DESC);
CREATE INDEX stock_movements_order_idx ON stock_movements (order_id) WHERE order_id IS NOT NULL;
CREATE TRIGGER stock_movements_append_only BEFORE UPDATE OR DELETE ON stock_movements FOR EACH ROW EXECUTE FUNCTION forbid_change();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['stock_levels', 'stock_movements']
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO fmcg_app', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (app_tenant_visible(tenant_id)) WITH CHECK (app_tenant_visible(tenant_id))', t);
  END LOOP;
END $$;

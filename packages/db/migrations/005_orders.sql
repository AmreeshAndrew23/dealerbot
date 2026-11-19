-- Orders module (architecture 3.2 / 5.1 / 6.2): orders, order_versions, order_lines, confirmations.
-- Versions and lines are append-only; a confirmation is bound to (order_version_id, summary_hash).
-- Order numbers come from a per-tenant sequence (architecture 12, item 13).

CREATE TABLE tenant_sequences (
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  name       text NOT NULL,
  last_value bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, name)
);

CREATE TABLE orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  order_number      bigint NOT NULL,
  status            text NOT NULL CHECK (status IN ('DRAFT','NEEDS_CLARIFICATION','AWAITING_RETAILER','READY_FOR_REVIEW','APPROVED',
                                                    'EXPORTING','EXPORTED','EXPORT_UNCERTAIN','EXPORT_FAILED','REJECTED','CANCELLED','EXPIRED')),
  -- Retailer identity (retailers / retailer_contacts) arrives with E09; until then the shop name and
  -- contact are recorded as given, so staff can see who ordered.
  retailer_name     text NOT NULL,
  contact_phone     text,
  conversation_id   uuid,
  channel           text NOT NULL CHECK (channel IN ('whatsapp', 'terminal')),
  current_version   integer NOT NULL,
  lock_version      integer NOT NULL DEFAULT 1,
  confirmed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, order_number)
);
CREATE INDEX orders_queue_idx ON orders (tenant_id, status, updated_at);

CREATE TABLE order_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  order_id      uuid NOT NULL,
  version       integer NOT NULL CHECK (version > 0),
  summary_hash  text NOT NULL,
  total         numeric(14,2) NOT NULL CHECK (total >= 0),
  price_list    text NOT NULL DEFAULT 'STANDARD',
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, order_id, version),
  UNIQUE (id, summary_hash),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id)
);

CREATE TABLE order_lines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  order_version_id uuid NOT NULL,
  line_no          integer NOT NULL CHECK (line_no > 0),
  sku_id           uuid NOT NULL,
  sku_code         text NOT NULL,                     -- snapshot at the time of the version
  name             text NOT NULL,
  unit             text NOT NULL,
  quantity         numeric(14,3) NOT NULL CHECK (quantity > 0),
  base_unit        text NOT NULL,
  base_quantity    numeric(14,3) NOT NULL CHECK (base_quantity > 0),
  unit_price       numeric(12,2) NOT NULL CHECK (unit_price >= 0),   -- per base unit
  amount           numeric(14,2) NOT NULL CHECK (amount >= 0),
  UNIQUE (order_version_id, line_no),
  FOREIGN KEY (tenant_id, order_version_id) REFERENCES order_versions (tenant_id, id),
  FOREIGN KEY (tenant_id, sku_id) REFERENCES skus (tenant_id, id)
);

CREATE TABLE confirmations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  order_version_id uuid NOT NULL,
  summary_hash     text NOT NULL,
  channel          text NOT NULL,
  evidence         text,                               -- the retailer's confirming message
  confirmed_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (order_version_id, summary_hash) REFERENCES order_versions (id, summary_hash)
);

-- Append-only: versions, lines and confirmations are never updated or deleted by the application.
CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$;
CREATE TRIGGER order_versions_append_only BEFORE UPDATE OR DELETE ON order_versions FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER order_lines_append_only BEFORE UPDATE OR DELETE ON order_lines FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER confirmations_append_only BEFORE UPDATE OR DELETE ON confirmations FOR EACH ROW EXECUTE FUNCTION forbid_change();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_sequences', 'orders', 'order_versions', 'order_lines', 'confirmations']
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO fmcg_app', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (app_tenant_visible(tenant_id)) WITH CHECK (app_tenant_visible(tenant_id))', t);
  END LOOP;
END $$;

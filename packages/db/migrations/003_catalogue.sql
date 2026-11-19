-- Catalogue module (architecture 3.2 / 6.1): skus, sku_units, sku_aliases, prices.
-- Masters normally arrive from Tally (E07, source = 'tally'); until the connector exists, staff
-- maintain them from the dashboard or a CSV upload (source = 'manual').
-- Composite foreign keys (tenant_id, sku_id) mean a row can never point into another tenant.

CREATE TABLE skus (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  sku_code        text NOT NULL,                     -- upper-case, unique per tenant
  name            text NOT NULL,
  category        text NOT NULL DEFAULT '',
  base_unit       text NOT NULL DEFAULT 'PCS',       -- prices and multipliers are per base unit
  mrp             numeric(12,2) NOT NULL CHECK (mrp >= 0),
  active          boolean NOT NULL DEFAULT true,     -- inactive SKUs are kept for history, never matched
  source          text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'tally')),
  source_id       text,                              -- Tally stock item GUID once synced
  source_revision text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, sku_code)
);
-- Becomes (tenant_id, company_id, source_id) when erp_companies arrives with the connector (E06/E07).
CREATE UNIQUE INDEX skus_source_idx ON skus (tenant_id, source_id) WHERE source_id IS NOT NULL;
CREATE INDEX skus_tenant_active_idx ON skus (tenant_id, active, name);

CREATE TABLE sku_units (
  tenant_id       uuid NOT NULL,
  sku_id          uuid NOT NULL,
  unit            text NOT NULL,                     -- PCS, BOX, CASE ...
  base_multiplier numeric(14,4) NOT NULL CHECK (base_multiplier > 0),
  PRIMARY KEY (tenant_id, sku_id, unit),
  FOREIGN KEY (tenant_id, sku_id) REFERENCES skus (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE sku_aliases (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  sku_id      uuid NOT NULL,
  alias       text NOT NULL,                         -- as typed: English, Tanglish or Tamil script
  alias_norm  text NOT NULL,                         -- normalised form used for matching
  position    integer NOT NULL DEFAULT 0,
  status      text NOT NULL DEFAULT 'approved' CHECK (status IN ('approved', 'suggested')),
  -- retailer_id (retailer-specific aliases) is added with the retailers table (E09).
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sku_id, alias_norm),
  FOREIGN KEY (tenant_id, sku_id) REFERENCES skus (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX sku_aliases_norm_idx ON sku_aliases (tenant_id, alias_norm);

CREATE TABLE prices (
  tenant_id   uuid NOT NULL,
  sku_id      uuid NOT NULL,
  price_list  text NOT NULL DEFAULT 'STANDARD',      -- retailer_price_lists map retailers to lists later
  rate        numeric(12,2) NOT NULL CHECK (rate >= 0),  -- dealer price per base unit, INR
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, sku_id, price_list),
  FOREIGN KEY (tenant_id, sku_id) REFERENCES skus (tenant_id, id) ON DELETE CASCADE
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['skus', 'sku_units', 'sku_aliases', 'prices']
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO fmcg_app', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (app_tenant_visible(tenant_id)) WITH CHECK (app_tenant_visible(tenant_id))', t);
  END LOOP;
END $$;

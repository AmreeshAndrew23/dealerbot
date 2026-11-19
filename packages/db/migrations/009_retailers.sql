-- Retailer identity (E09, first cut): the shops a distributor serves and the WhatsApp number each
-- orders from. Only a number recorded here (and active) gets the order assistant, prices or the
-- product list; any other number gets a neutral "not connected" reply (PRD flow E).
-- One WhatsApp number per retailer for now; unique per tenant (another distributor may serve the same shop).

CREATE TABLE retailers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  shop_name     text NOT NULL CHECK (length(btrim(shop_name)) BETWEEN 1 AND 120),
  contact_name  text CHECK (contact_name IS NULL OR length(contact_name) <= 80),
  phone_e164    text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  area          text CHECK (area IS NULL OR length(area) <= 80),
  notes         text CHECK (notes IS NULL OR length(notes) <= 500),
  active        boolean NOT NULL DEFAULT true,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, phone_e164)
);
CREATE INDEX retailers_tenant_name_idx ON retailers (tenant_id, shop_name);

GRANT SELECT, INSERT, UPDATE ON retailers TO fmcg_app;
ALTER TABLE retailers ENABLE ROW LEVEL SECURITY;
ALTER TABLE retailers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON retailers USING (app_tenant_visible(tenant_id)) WITH CHECK (app_tenant_visible(tenant_id));

-- Orders remember which retailer placed them (null for terminal tests and older orders).
ALTER TABLE orders ADD COLUMN retailer_id uuid;
ALTER TABLE orders ADD CONSTRAINT orders_retailer_fk FOREIGN KEY (tenant_id, retailer_id) REFERENCES retailers (tenant_id, id);
CREATE INDEX orders_retailer_idx ON orders (tenant_id, retailer_id) WHERE retailer_id IS NOT NULL;

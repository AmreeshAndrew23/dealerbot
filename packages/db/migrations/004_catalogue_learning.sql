-- Catalogue learning from conversations (architecture 8.3: matching uses APPROVED aliases only).
-- When a retailer picks a product for words the matcher was unsure about ("mb" -> Milk Bikis), the
-- pairing is stored as a SUGGESTED alias. Words that matched nothing are stored as unmatched phrases.
-- Staff approve, reject or link them on the Catalogue page; nothing becomes an alias by itself.

ALTER TABLE sku_aliases DROP CONSTRAINT sku_aliases_status_check;
ALTER TABLE sku_aliases ADD CONSTRAINT sku_aliases_status_check CHECK (status IN ('approved', 'suggested', 'rejected'));
ALTER TABLE sku_aliases
  ADD COLUMN source        text NOT NULL DEFAULT 'staff' CHECK (source IN ('staff', 'chat')),
  ADD COLUMN times_seen    integer NOT NULL DEFAULT 0,
  ADD COLUMN last_seen_at  timestamptz,
  ADD COLUMN reviewed_by   uuid,
  ADD COLUMN reviewed_at   timestamptz;

CREATE TABLE unmatched_phrases (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  phrase_norm    text NOT NULL,
  example        text NOT NULL,                  -- as the retailer typed it (latest)
  times_seen     integer NOT NULL DEFAULT 1,
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'linked', 'ignored')),
  linked_sku_id  uuid,
  reviewed_by    uuid,
  reviewed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, phrase_norm),
  FOREIGN KEY (tenant_id, linked_sku_id) REFERENCES skus (tenant_id, id)
);
CREATE INDEX unmatched_phrases_open_idx ON unmatched_phrases (tenant_id, status, last_seen_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON unmatched_phrases TO fmcg_app;
ALTER TABLE unmatched_phrases ENABLE ROW LEVEL SECURITY;
ALTER TABLE unmatched_phrases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON unmatched_phrases USING (app_tenant_visible(tenant_id)) WITH CHECK (app_tenant_visible(tenant_id));

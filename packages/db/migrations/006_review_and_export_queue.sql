-- Review and approval (architecture 5.1, 5.2, 6.2, 7.4; backlog E12) and the export queue the
-- Tally connector will lease from (E14). An approval is bound to (order_version_id, summary_hash).

ALTER TABLE orders
  ADD COLUMN status_reason text,          -- why it was rejected / cancelled
  ADD COLUMN reviewed_by   uuid,
  ADD COLUMN reviewed_at   timestamptz;

CREATE TABLE approvals (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id),
  order_version_id      uuid NOT NULL,
  summary_hash          text NOT NULL,
  approved_by           uuid NOT NULL,
  acknowledged_warnings jsonb NOT NULL DEFAULT '[]',   -- [{code, message}] the approver accepted
  approved_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (order_version_id, summary_hash) REFERENCES order_versions (id, summary_hash)
);
CREATE TRIGGER approvals_append_only BEFORE UPDATE OR DELETE ON approvals FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE TABLE export_jobs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  order_id            uuid NOT NULL,
  order_version_id    uuid NOT NULL,
  state               text NOT NULL DEFAULT 'QUEUED'
                        CHECK (state IN ('QUEUED','LEASED','SUBMITTING','SUCCEEDED','FAILED','UNCERTAIN','CONFLICT','CANCELLED')),
  external_reference  text NOT NULL,                    -- copilot reference written into the Tally Sales Order
  payload_hash        text NOT NULL,                    -- the connector echoes it back; a mismatch is rejected
  lease_token_hash    text,
  lease_expires_at    timestamptz,
  attempts            integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, order_version_id),
  UNIQUE (tenant_id, external_reference),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id),
  FOREIGN KEY (tenant_id, order_version_id) REFERENCES order_versions (tenant_id, id)
);
-- Architecture 12, item 3: at most one live export per order; FAILED / CANCELLED do not count.
CREATE UNIQUE INDEX export_jobs_one_live_per_order ON export_jobs (order_id) WHERE state IN ('LEASED','SUBMITTING','UNCERTAIN','SUCCEEDED');
CREATE INDEX export_jobs_lease_idx ON export_jobs (state, lease_expires_at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['approvals', 'export_jobs']
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO fmcg_app', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (app_tenant_visible(tenant_id)) WITH CHECK (app_tenant_visible(tenant_id))', t);
  END LOOP;
END $$;

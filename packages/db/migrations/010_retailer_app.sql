-- Customer app (apps/shop): retailers sign in with their phone number and an access code the
-- distributor gives them, chat with the order assistant inside the app, and see their orders.
-- The chat is stored in the same contacts / conversations / messages / outbound_messages tables as
-- WhatsApp, under a channel account with provider 'app', so staff handle it on the same dashboard.

-- Access code: only its hash is stored; staff see the code once, when they create it.
ALTER TABLE retailers
  ADD COLUMN app_code_hash        text,
  ADD COLUMN app_code_set_at      timestamptz,
  ADD COLUMN app_failed_attempts  integer NOT NULL DEFAULT 0,
  ADD COLUMN app_locked_until     timestamptz;

CREATE TABLE retailer_sessions (
  token_hash   text PRIMARY KEY,               -- sha256 of the cookie value; the token itself is never stored
  tenant_id    uuid NOT NULL,
  retailer_id  uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  user_agent   text,
  FOREIGN KEY (tenant_id, retailer_id) REFERENCES retailers (tenant_id, id)
);
CREATE INDEX retailer_sessions_retailer_idx ON retailer_sessions (tenant_id, retailer_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON retailer_sessions TO fmcg_app;
ALTER TABLE retailer_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE retailer_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON retailer_sessions USING (app_tenant_visible(tenant_id)) WITH CHECK (app_tenant_visible(tenant_id));

-- The assistant's order draft for an app chat (the API may restart between two messages).
ALTER TABLE conversations ADD COLUMN draft_json jsonb;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_channel_check;
ALTER TABLE orders ADD CONSTRAINT orders_channel_check CHECK (channel IN ('whatsapp', 'whatsapp_test', 'terminal', 'app'));

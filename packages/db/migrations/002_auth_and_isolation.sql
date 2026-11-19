-- E03: users, memberships, sessions, invitations, idempotency keys, and row-level security.

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_subject  text NOT NULL UNIQUE,         -- "local:<email>" now; OIDC "sub" when an IdP is added
  email         text NOT NULL,
  display_name  text NOT NULL,
  password_hash text,                         -- null for OIDC users
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_idx ON users (lower(email));

CREATE TABLE memberships (
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  user_id    uuid NOT NULL REFERENCES users(id),
  role       text NOT NULL CHECK (role IN ('OWNER','OPERATOR','VIEWER')),
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE sessions (
  token_hash   text PRIMARY KEY,              -- sha256 of the cookie value; the token itself is never stored
  user_id      uuid NOT NULL REFERENCES users(id),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  user_agent   text,
  ip           text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  email       text NOT NULL,
  role        text NOT NULL CHECK (role IN ('OWNER','OPERATOR','VIEWER')),
  token_hash  text NOT NULL UNIQUE,
  created_by  uuid NOT NULL REFERENCES users(id),
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE idempotency_keys (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  actor_id        uuid NOT NULL,
  route           text NOT NULL,
  key             text NOT NULL,
  request_hash    text NOT NULL,
  response_status integer,
  response_json   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (tenant_id, actor_id, route, key)
);

-- ---------------------------------------------------------------------------------------------
-- Row-level security. Staff requests run as role fmcg_app with app.tenant_id set for the
-- transaction, so a query can never see another tenant's rows even if a WHERE clause is missing.
-- Workers and CLIs are separately authorised (app.role = 'system').
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fmcg_app') THEN
    CREATE ROLE fmcg_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO fmcg_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO fmcg_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO fmcg_app;
-- pg-boss jobs are enqueued inside staff transactions (e.g. a human reply).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'pgboss') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA pgboss TO fmcg_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA pgboss TO fmcg_app';
  END IF;
END $$;

CREATE FUNCTION app_tenant_visible(row_tenant uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT current_setting('app.role', true) = 'system'
      OR row_tenant = nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['channel_accounts','contacts','consent_events','conversations','media_assets',
                           'messages','outbound_messages','audit_events','memberships','sessions',
                           'invitations','idempotency_keys']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (app_tenant_visible(tenant_id)) WITH CHECK (app_tenant_visible(tenant_id))', t);
  END LOOP;
END $$;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants USING (app_tenant_visible(id)) WITH CHECK (app_tenant_visible(id));
-- users is global (a person can belong to several tenants); access is mediated by memberships.
-- webhook_events is pre-tenant and only touched by system code.
REVOKE ALL ON webhook_events FROM fmcg_app;

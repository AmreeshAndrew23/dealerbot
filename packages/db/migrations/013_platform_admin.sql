-- Platform admin (user request, 20 Nov 2026): the people who run this service add dealers
-- (distributors = tenants) and maintain them from a separate admin app at /admin/.
-- Admins are NOT dealer staff: own table, own sessions, own cookie, and no membership in any
-- tenant. Only system code (app.role = 'system') reads these tables; staff requests cannot.

-- A suspended dealer: its staff cannot sign in, its shops cannot use the customer app.
-- Nothing is deleted; reactivating restores everything.
ALTER TABLE tenants
  ADD COLUMN status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  ADD COLUMN suspended_at     timestamptz,
  ADD COLUMN suspended_reason text;

CREATE TABLE platform_admins (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  display_name  text NOT NULL,
  password_hash text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX platform_admins_email_idx ON platform_admins (lower(email));

CREATE TABLE platform_admin_sessions (
  token_hash   text PRIMARY KEY,              -- sha256 of the cookie value
  admin_id     uuid NOT NULL REFERENCES platform_admins(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  user_agent   text,
  ip           text
);
CREATE INDEX platform_admin_sessions_admin_idx ON platform_admin_sessions (admin_id);

REVOKE ALL ON platform_admins FROM fmcg_app;
REVOKE ALL ON platform_admin_sessions FROM fmcg_app;

-- A dealer's first owner is invited by an admin, not by a staff user.
ALTER TABLE invitations ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE invitations ADD COLUMN created_by_admin uuid REFERENCES platform_admins(id);
ALTER TABLE invitations ADD CONSTRAINT invitations_created_by_someone CHECK (created_by IS NOT NULL OR created_by_admin IS NOT NULL);

-- WhatsApp channel slice (PRD E02/E08/E13): tenants, channel accounts, contacts, conversations,
-- messages, media, webhook intake, outbound messages, consent and audit.
-- Conventions: UUID keys, timestamptz in UTC, composite tenant foreign keys, no cascade deletes.

CREATE TABLE tenants (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  timezone            text NOT NULL DEFAULT 'Asia/Kolkata',
  settings_json       jsonb NOT NULL DEFAULT '{}',
  live_export_enabled boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE channel_accounts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  provider          text NOT NULL DEFAULT 'whatsapp_cloud',
  provider_phone_id text NOT NULL,
  waba_id           text,
  display_phone     text,
  secret_reference  text NOT NULL,          -- e.g. env:WHATSAPP_ACCESS_TOKEN, never the token itself
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('pending','active','disabled')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (provider_phone_id)                -- globally unique across tenants
);

CREATE TABLE contacts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  phone_e164         text NOT NULL CHECK (phone_e164 ~ '^\+[0-9]{6,15}$'),
  profile_name       text,
  preferred_language text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, phone_e164)
);

CREATE TABLE consent_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  contact_id   uuid NOT NULL,
  purpose      text NOT NULL,                -- e.g. 'order_messaging'
  action       text NOT NULL CHECK (action IN ('opt_in','opt_out')),
  evidence_ref text,                         -- e.g. message:<uuid>
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id)
);
CREATE INDEX consent_events_contact_idx ON consent_events (tenant_id, contact_id, purpose, occurred_at DESC);

CREATE TABLE conversations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  channel_account_id uuid NOT NULL,
  contact_id         uuid NOT NULL,
  owner_mode         text NOT NULL DEFAULT 'BOT' CHECK (owner_mode IN ('BOT','HUMAN')),
  assigned_user_id   uuid,
  last_inbound_at    timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, channel_account_id, contact_id),
  FOREIGN KEY (tenant_id, channel_account_id) REFERENCES channel_accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id)
);

CREATE TABLE media_assets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  storage_key  text NOT NULL,
  mime_type    text NOT NULL,
  size_bytes   bigint NOT NULL CHECK (size_bytes >= 0),
  duration_ms  integer,
  sha256       text NOT NULL,
  delete_after timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE messages (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                    uuid NOT NULL,
  conversation_id              uuid NOT NULL,
  channel_account_id           uuid NOT NULL,
  provider_message_id          text NOT NULL,
  direction                    text NOT NULL CHECK (direction IN ('inbound','outbound')),
  type                         text NOT NULL,
  body                         text,
  provider_media_id            text,
  media_mime_type              text,
  media_id                     uuid,
  interactive_reply_id         text,
  reply_to_provider_message_id text,
  review_reason                text,          -- set when media or content needs a human
  provider_timestamp           timestamptz,
  received_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (channel_account_id, provider_message_id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id),
  FOREIGN KEY (tenant_id, channel_account_id) REFERENCES channel_accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, media_id) REFERENCES media_assets (tenant_id, id)
);
CREATE INDEX messages_conversation_idx ON messages (tenant_id, conversation_id, received_at);

-- Raw provider events. Pre-tenant: the tenant is only known after routing by phone number ID.
CREATE TABLE webhook_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider          text NOT NULL,
  event_key         text NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('message','status')),
  provider_phone_id text NOT NULL,
  payload_json      jsonb NOT NULL,
  payload_ref       text,
  received_at       timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz,
  process_result    text,
  UNIQUE (provider, event_key)
);
CREATE INDEX webhook_events_unprocessed_idx ON webhook_events (received_at) WHERE processed_at IS NULL;

CREATE TABLE outbound_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  conversation_id uuid NOT NULL,
  dedupe_key      text NOT NULL,
  origin          text NOT NULL CHECK (origin IN ('bot','human','system')),
  sent_by         uuid,
  payload_json    jsonb NOT NULL,
  policy_result   text NOT NULL CHECK (policy_result IN ('ALLOW','DENY')),
  policy_reason   text NOT NULL,
  provider_id     text,
  status          text NOT NULL CHECK (status IN ('blocked','queued','sending','sent','delivered','read','failed')),
  error_json      jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  delivered_at    timestamptz,
  read_at         timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, dedupe_key),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id)
);
CREATE UNIQUE INDEX outbound_messages_provider_id_idx ON outbound_messages (provider_id) WHERE provider_id IS NOT NULL;

CREATE TABLE audit_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid,
  actor_type   text NOT NULL,
  actor_id     text,
  action       text NOT NULL,
  entity_type  text NOT NULL,
  entity_id    text,
  details_json jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_entity_idx ON audit_events (tenant_id, entity_type, entity_id, created_at);

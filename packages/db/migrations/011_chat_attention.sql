-- Chat flow fixes (review of 17 Nov 2026).
--
-- 1. Conversations the assistant could not finish on its own are flagged for staff: a question it
--    cannot answer, a request to cancel a confirmed order, a handoff, or a message that arrived
--    while the bridge was offline. Staff replying (or handing the chat back) clears the flag.
ALTER TABLE conversations
  ADD COLUMN needs_attention text CHECK (needs_attention IN ('question', 'cancel_request', 'handoff', 'missed_message')),
  ADD COLUMN attention_at    timestamptz;
CREATE INDEX conversations_attention_idx ON conversations (tenant_id, attention_at) WHERE needs_attention IS NOT NULL;

-- 2. Numbers that messaged but are not (or no longer) connected retailers, so staff can add them.
--    Nothing is replied beyond "not connected"; only the last message is kept, for recognising the sender.
CREATE TABLE unknown_senders (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  phone_e164    text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  profile_name  text,
  last_text     text CHECK (last_text IS NULL OR length(last_text) <= 300),
  reason        text NOT NULL CHECK (reason IN ('not_a_retailer', 'retailer_inactive')),
  attempts      integer NOT NULL DEFAULT 1,
  first_at      timestamptz NOT NULL DEFAULT now(),
  last_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, phone_e164)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON unknown_senders TO fmcg_app;
ALTER TABLE unknown_senders ENABLE ROW LEVEL SECURITY;
ALTER TABLE unknown_senders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON unknown_senders USING (app_tenant_visible(tenant_id)) WITH CHECK (app_tenant_visible(tenant_id));

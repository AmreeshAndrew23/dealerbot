-- Customer app with several dealers (user request, 19 Nov 2026): a shop may buy from more than one
-- distributor. One sign-in on the phone holds one row per dealer it was linked to; each link was
-- proven with THAT dealer's access code, so one dealer's code never opens another dealer's data.
-- A new code or removed access at a dealer deletes only that dealer's rows (setAppCode), and the
-- phone keeps the other dealers.

ALTER TABLE retailer_sessions DROP CONSTRAINT retailer_sessions_pkey;
ALTER TABLE retailer_sessions ADD PRIMARY KEY (token_hash, tenant_id);
CREATE INDEX retailer_sessions_token_idx ON retailer_sessions (token_hash);

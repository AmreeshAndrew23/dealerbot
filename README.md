# FMCG Distributor Order Assistant

WhatsApp order assistant for FMCG distributors, with a staff dashboard and a TallyPrime connector.
See the architecture summary for the full design.

## Status

Built so far: the **WhatsApp channel** (PRD E02, E08 and the messaging part of E13).

- `GET /webhooks/whatsapp`: Meta verification handshake
- `POST /webhooks/whatsapp`: signature check on the raw body, stored before the 200 is sent, duplicate
  deliveries ignored, 503 when storage fails so Meta retries
- Inbound worker: routes by phone number ID to the tenant, stores contact, conversation and message,
  normalises to the PRD event shape (text, voice, image, document, button replies, location)
- Media worker: downloads with the channel token, checks type and size, stores sha256 and a
  tenant-scoped key, and records a review reason when media is rejected
- Outbound: one policy gate (opt-out, 24 h service window or template, human takeover), dedupe key,
  send job with retry; an interrupted send is never repeated blindly
- Delivery statuses (sent, delivered, read, failed) only move forward and never create orders
- STOP / START opt-out and opt-in (English and Tamil), with consent evidence
- Neutral acknowledgement for unknown senders (PRD flow E), at most once per 30 minutes

Also built: **login, roles and the staff dashboard** (PRD E03 and the conversations part of E12/E13).

- Email + password login with HTTP-only session cookies (12 h), invitations by link, roles OWNER / OPERATOR / VIEWER
- Tenant isolation enforced twice: the tenant comes from the session, and PostgreSQL row-level security
  (staff queries run as role `fmcg_app` with `app.tenant_id` set per transaction)
- Staff API: `/v1/auth/*`, `/v1/users*`, `/v1/conversations*` (list, thread, takeover, resume, human reply
  with `Idempotency-Key`), `/v1/media/{id}`
- Dashboard (`apps/web`): Conversations (list, thread, voice/image playback, delivery status in words,
  24-hour window banner, takeover/hand back, composer), Users (invite, role change, remove), mobile layout

Also built: **catalogue** (catalogue module, ahead of the Tally sync in E07) and a **terminal order chat**.

- Tables `skus`, `sku_units`, `sku_aliases`, `prices` with composite tenant keys and RLS; `source` is `manual` until the
  connector syncs from Tally
- Dashboard Catalogue page: add, edit (prices, pack sizes, retailer names), hide/restore, CSV upload with a preview
  (all or nothing), CSV download in the same format
- Staff API: `/v1/catalogue/products` (GET, POST, PATCH), `/v1/catalogue/import`, `/v1/catalogue/export.csv`
- Matching in code (architecture 8.3): normalisation (NFC, Tamil numerals, Tanglish quantities, unit words), trigram
  search over names and approved aliases, ambiguity becomes a question with at most 3 choices (gate 5)
- Learning: when the matcher is unsure it asks (never assumes); the retailer's pick is saved as a suggested alias and
  unknown names as unmatched phrases. Staff approve, reject or link them on the Catalogue page ("Learned from chats");
  only approved aliases are matched. `pnpm chat` logs every turn to `storage/chat-logs/<date>.jsonl`
- `pnpm chat`: the LLM (`OPENAI_MODEL`, default gpt-4.1) only extracts candidate lines; code matches, converts packs,
  prices and writes every reply. Drafts are not saved yet (orders, versions and confirmations come with E11), and the
  chat assumes an authorised retailer (identity is E09), so it is not connected to WhatsApp

Also built: **orders from chat** (orders module, first part of E11).

- Tables `orders`, `order_versions`, `order_lines`, `confirmations` (versions, lines and confirmations are append-only;
  a confirmation is bound to the version's summary hash), per-distributor order numbers `ORD-000001`
- When the retailer confirms, one transaction saves the order as `READY_FOR_REVIEW`, and the reply is a bill-style
  order copy (shop, order number, date and time, lines, total; "not a tax invoice")
- The assistant asks once: English or தமிழ் (Tamil script replies); retailers may type in any language
- Staff API `GET /v1/orders`, `GET /v1/orders/{id}`; dashboard Orders page. Approve and export to Tally are next (E12, E14)

Also built: **review and approval** (E12) and **stock**.

- Orders page is a review workbench: checks before approval (blockers, warnings to acknowledge), approve / reject /
  cancel with If-Match + Idempotency-Key, history. Approval writes `approvals` + a QUEUED `export_jobs` row for Tally
- Stock (`stock_levels`, `stock_movements`): staff set counts or add received stock (Catalogue → Stock, or CSV
  `stock_pcs`). The assistant refuses more than is available; confirming an order takes the stock in the same
  transaction (all or nothing), rejecting/cancelling gives it back. Products without a count are not tracked

Bulk catalogue upload: Catalogue → Template downloads a CSV (Item Code, Item Name, Category, Base Unit, Pack Sizes,
MRP, Purchase Rate, Selling Rate, Stock Qty, Stock Unit, Retailer Names, Active) with EXAMPLE rows that are skipped.
Headings match loosely (older `sku_code`-style files still work). Purchase rate is stored as price list `PURCHASE`
(staff only, never quoted); selling rate is `STANDARD`.

## Run locally

```sh
pnpm install
pnpm db:migrate
pnpm user:create --tenant "Demo Distributor" --email you@example.com --name "Your Name" --role OWNER
pnpm dev:api       # http://localhost:3100
pnpm dev:worker
pnpm dev:web       # http://localhost:5180  staff dashboard (proxies /v1 to the API)
pnpm dev:shop      # http://localhost:5181  customer app (proxies only /v1/app)
pnpm wa:simulate --from +919840011111 --name "Murugan Stores" --text "2 case Good Day 100g"
pnpm catalogue:import --file data/britannia/catalogue.csv   # sample products (placeholder prices)
pnpm chat --debug  # order as a retailer in the terminal; needs OPENAI_API_KEY
```

## Layout

```
apps/api            Fastify server: webhooks, health; CLI scripts in src/cli
apps/worker         pg-boss consumers: whatsapp-inbound, whatsapp-media, whatsapp-send
apps/web            staff dashboard (React + Vite + TanStack Query)
apps/shop           customer app: retailers chat with the assistant and see their orders
packages/channel    WhatsApp adapter, policy gate, inbound/outbound/media logic
packages/catalogue  SKUs, units, aliases, prices; CSV import/export; normalisation and matching
packages/orders     order drafting: LLM extraction (schema-checked) + code-side clarification and pricing
packages/contracts  Zod schemas: normalised events, outbound payloads, job payloads
packages/db         PostgreSQL pool, transactions, audit, migrations
packages/config     .env loading and validation, secret references
docs/               setup guides
```

## Commands

```sh
pnpm install
pnpm db:migrate
pnpm channel:add --tenant "Demo Distributor" --phone-number-id <id>
pnpm dev:api
pnpm dev:worker
pnpm wa:send-template --to +91XXXXXXXXXX
pnpm wa:simulate --text "2 case Product A 100g"
pnpm test        # unit tests; integration tests need TEST_DATABASE_URL=.../fmcg_assistant_test
pnpm typecheck
```

To connect a real WhatsApp number, follow [docs/whatsapp-setup.md](docs/whatsapp-setup.md).

## Customer app (`apps/shop`)

Retailers order in our own app instead of WhatsApp; staff handle the chats and orders on the dashboard.

1. Dashboard **Retailers** > open a shop > **Create access code**. The 6-digit code is shown once,
   with a message to send to the shop (app address, phone number, code). Only its hash is stored.
2. The shop opens the app (`RETAILER_APP_URL`, port 5181 locally), signs in with its phone number and
   the code, and stays signed in for 90 days. Five wrong codes lock that number for 15 minutes.
   **Create new code** signs out phones that used the old one; **Remove access** or **Disconnect** closes the app.
3. **Several dealers**: a shop that buys from other distributors adds each one under **Add a dealer**
   with the access code *that* dealer gave it (same phone number). One sign-in holds one
   `retailer_sessions` row per dealer; a code only ever opens its own dealer. A new code or removed
   access at one dealer drops only that dealer from the phone.
4. Screens (the URL hash, so the back button works): **Dealers** (last message, unread, orders
   waiting), **All orders** (every dealer), **Account** (phone, dealers, remove, sign out). Per dealer:
   - **Chat**: every message runs the same assistant turn as WhatsApp (`runRetailerTurn`); the draft is
     kept in `conversations.draft_json`. A "YES, place the order" button shows only while the
     assistant waits for YES.
   - **Price list**: that dealer's products with MRP, the shop's rate, margin on MRP and out-of-stock
     tags (never the purchase rate or stock counts); search and categories; a cart per dealer kept on
     the phone. **Send order to chat** posts it as one message, matched by SKU without the model; the
     order is placed only when the shop replies YES.
   - **Orders**: status, what happened (placed, changed, accepted ...), items, **Order again** (fills
     the cart at today's prices) and **Ask about this order**.
5. On the dashboard each dealer sees only its own chat under **Conversations** (marked "App").
   **Take over** silences the assistant; staff replies show in the shop's app at once (WhatsApp's
   24-hour rule does not apply).

The app has its own sign-in (`fmcg_retailer` cookie) and can only call `/v1/app/*`; every route under
`/v1/app/dealers/:dealer` checks that the phone is linked to that dealer and runs in that dealer's
tenant (row-level security). It polls for new messages every 4 s; there are no push notifications yet.

## WhatsApp test bridge (testing only, until the Meta Cloud API number is live)

`apps/wa-test` links a WhatsApp number through WhatsApp Web (unofficial library Baileys) and runs the
same order assistant as `pnpm chat`. Confirmed orders are saved with channel `whatsapp_test` and show on
the Orders page as "WhatsApp test". Use a spare SIM, never the business's main number: WhatsApp may ban
numbers that run unofficial clients. Delete this app once the Cloud API webhook is live.

1. On the dashboard **Retailers** page, add each shop with the WhatsApp number it orders from
   (Owner or Operator). Only active numbers listed there get the price list and the assistant; any
   other number gets "this number is not connected" (no prices or products), at most every 30 minutes.
   Ten digits are saved as an Indian number; a foreign number needs its country code (`+1 925 ...`).
2. `pnpm wa:test`, then on the test phone: WhatsApp > Settings > Linked devices > Link a device, scan the QR.
   The link is saved in `storage/wa-test-session`; `pnpm wa:test --relink` shows a new QR.
3. From a retailer's phone, message the linked number. The first reply is the price list (selling rates
   per pack, out-of-stock marked; never the purchase rate) and the language question. *LIST* sends it
   again anytime. `/reset` starts a new order, `/lang` asks the language again.

Groups, status updates and messages older than 5 minutes are ignored. Drafts are kept in memory, so a
restart starts fresh drafts (saved orders are in the database).

Retailers' chats on the bridge appear on the dashboard **Conversations** page, with that retailer's
orders above the chat. **Take over** silences the assistant for that chat and sends staff replies
through the bridge; **Hand back to assistant** starts a fresh order. Run only one bridge at a time:
two fight over the WhatsApp session (`440 conflict` in the log) and split the drafts between them.

## Chat flow rules (review of 17 Nov 2026)

- **Placing an order needs a clear YES** (yes, confirm, சரி, seri, podunga ...). A bare "ok" or 👍 gets
  "Shall I place this order? Reply YES". "ok" can still answer "Did you mean X?".
- **The retailer hears the decision.** Approve / Reject / Cancel on the Orders page sends a message in the
  retailer's language (app: at once; WhatsApp test bridge: within seconds), in the same transaction as the
  decision. The reject/cancel reason is shown to the retailer.
- **Never guessing on edits.** "remove good day" with two Good Days asks which; "bourbon 5" when Bourbon is in
  the order as case and box asks which pack; "bourbon 3 box" changes only the box line.
- **Messages before the language choice are kept** (anything that is not a pure greeting), and handled once
  the language is chosen or picked automatically.
- **After confirming, until staff accept the order:** new items, quantity changes and removals go into the
  *same* order. The retailer sees the whole order and replies YES; it is saved as the next version (same order
  number, stock re-reserved, `order.changed_by_retailer` in its history). A reviewer looking at the old version
  gets a conflict and must reload. Removing every item is refused; "cancel" drops the changes (a second
  "cancel" asks staff). If staff accept or decline it at that moment, nothing changes and only the extra
  items are offered as a new order.
- **After the order is accepted:** new items start a separate order and the retailer is told so; "cancel" asks
  staff to cancel (flagged); "where is my order?" answers from the orders.
- **Needs reply:** when the assistant promises a person (a question, a cancel request, STAFF, or a message that
  arrived while the bridge was offline), the chat is flagged on Conversations ("Needs reply" filter). Replying,
  handing back or "Mark done" clears it. Staff see the retailer's unconfirmed items, and they are kept when the
  chat is handed back. The WhatsApp bridge now saves drafts in the database, so a restart loses nothing.
- **Tried to order:** numbers that are not connected are listed on the Retailers page with their last message;
  "Add as retailer" fills in the number.

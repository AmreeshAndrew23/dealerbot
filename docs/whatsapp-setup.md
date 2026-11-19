# Connecting WhatsApp (Meta Cloud API)

This guide takes you from an empty Meta account to a real WhatsApp message arriving in the database
and the assistant replying. Allow about 30 minutes the first time.

## What you need

| Item | Where it comes from | Goes into |
|---|---|---|
| App secret | Meta app > App settings > Basic > App secret | `.env` `WHATSAPP_APP_SECRET` |
| Verify token | Any random string you make up | `.env` `WHATSAPP_VERIFY_TOKEN` and the Meta webhook form |
| Access token | WhatsApp > API Setup (temporary, 24 h) or a System User token (permanent) | `.env` `WHATSAPP_ACCESS_TOKEN` |
| Phone number ID | WhatsApp > API Setup, under the "From" number | `pnpm channel:add --phone-number-id` |
| WhatsApp Business Account ID | WhatsApp > API Setup | `pnpm channel:add --waba` (optional) |
| Public HTTPS URL | ngrok while developing; your domain in production | Meta webhook "Callback URL" |

## 1. Create the Meta app (once)

1. Go to <https://developers.facebook.com/apps> and choose **Create app**.
2. Use case: **Other**, then app type **Business**. Pick your Meta Business portfolio.
3. In the app dashboard, add the **WhatsApp** product and click **Set up**.
4. Meta creates a **test phone number** for you. Under **To**, add your own mobile number and confirm the
   code that WhatsApp sends you. Test numbers can only message up to 5 verified recipients.

## 2. Fill in `.env`

```sh
cp .env.example .env
```

Set `DATABASE_URL`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` and `WHATSAPP_ACCESS_TOKEN`.
Never commit `.env`; it is in `.gitignore`.

## 3. Database and app

```sh
pnpm install
psql -U postgres -c "CREATE DATABASE fmcg_assistant"
pnpm db:migrate
pnpm channel:add --tenant "Demo Distributor" --phone-number-id <PHONE_NUMBER_ID> --display "+1 555 ..." --waba <WABA_ID>
```

Run the API and the worker in two terminals:

```sh
pnpm dev:api      # http://localhost:3100
pnpm dev:worker
```

## 4. Check sending first (no webhook needed)

```sh
pnpm wa:send-template --to +91XXXXXXXXXX
```

You should receive Meta's "Hello World" template on your phone. If this fails, the token or phone
number ID is wrong. Fix that before setting up the webhook.

## 5. Expose the API with a tunnel

Meta cannot reach `localhost`. In a third terminal:

```sh
ngrok http 3100
```

Copy the `https://....ngrok-free.app` address. The free ngrok URL changes every time ngrok
restarts; update the Meta webhook when it does.

## 6. Register the webhook in Meta

1. App dashboard > **WhatsApp > Configuration > Webhook > Edit**.
2. Callback URL: `https://<your-ngrok-host>/webhooks/whatsapp`
3. Verify token: the same value as `WHATSAPP_VERIFY_TOKEN`.
4. Click **Verify and save**. The API log shows `whatsapp webhook verified`.
5. Under **Webhook fields**, subscribe to **messages**.

## 7. End-to-end test

Reply to the Hello World message from your phone (any text). Within a few seconds:

- the API log shows `webhook stored`;
- the worker log shows `MESSAGE_STORED` and a send job;
- your phone receives the neutral acknowledgement in English and Tamil.

Also try: a **voice note** (saved under `storage/t/<tenant>/media/...`), **STOP** (opt-out confirmed,
then the bot goes silent), and **START** (subscribed again).

Useful queries:

```sql
SELECT direction, type, body, received_at FROM messages ORDER BY received_at DESC LIMIT 10;
SELECT status, policy_result, policy_reason, provider_id FROM outbound_messages ORDER BY created_at DESC LIMIT 10;
SELECT kind, event_key, process_result FROM webhook_events ORDER BY received_at DESC LIMIT 10;
```

## Without a phone

`pnpm wa:simulate --from +919876543210 --text "2 case Product A 100g"` posts a correctly signed,
Meta-shaped webhook to the local API. Add `--repeat 3` to watch duplicate protection work.
Replies to simulated numbers fail at Meta (the number is not a real recipient); that is expected.

## Common errors

| Symptom | Cause |
|---|---|
| Webhook "Verify and save" fails | API not reachable through ngrok, or verify token differs from `.env` |
| `401 INVALID_SIGNATURE` in the API log | `WHATSAPP_APP_SECRET` is not this app's secret |
| Graph API error 190 | Access token expired (temporary tokens last 24 h) |
| Graph API error 131030 | Recipient is not in the test number's allowed list |
| Graph API error 131047 | More than 24 h since the customer's last message: only templates are allowed |
| `UNKNOWN_PHONE_NUMBER_ID` in `webhook_events.process_result` | `pnpm channel:add` was run with a different phone number ID |

## Going to production

- Replace the temporary token with a **System User** access token (Business settings > System users),
  and move it to AWS Secrets Manager (`secret_reference` = `aws-sm:...`, to be added).
- Add and verify the distributor's real business number, and complete Meta business verification.
- Create message templates for outside the 24-hour window (for example an order-ready notice) and get
  them approved.
- Point the webhook at the production domain instead of ngrok.

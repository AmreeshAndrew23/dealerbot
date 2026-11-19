// TESTING ONLY: a WhatsApp Web bridge (unofficial Baileys library) so testers can order from a real
// phone until the Meta Cloud API number is approved. Production traffic goes through the Cloud API
// webhook (apps/api) and worker; delete this app once that is live.
//
//   pnpm wa:test            first run prints a QR code: WhatsApp on the TEST phone > Linked devices > Link a device
//   pnpm wa:test --relink   forget the linked session and show a new QR code
//   pnpm wa:test --pair 919876543210   link with an 8-character code instead of the QR code
//                           (phone: Linked devices > Link a device > Link with phone number instead)
// The QR code is also saved as storage/wa-qr.png, for terminals that cannot show it.
// Only one bridge may run at a time (they would share one WhatsApp session and knock each other off).
//
// Every message runs the same turn as `pnpm chat` (runRetailerTurn): the model only extracts,
// code matches the Catalogue, prices and writes every reply. Confirmed orders are saved with channel
// 'whatsapp_test' and appear on the dashboard Orders page for review.
//
// Who gets what: a number recorded as an active retailer (dashboard > Retailers) gets the assistant,
// starting with the price list. Any other number gets only "this number is not connected" (no prices
// or products), at most once every 30 minutes, and is not recorded.
// Retailers' chats are recorded for the dashboard Conversations page (packages/orders chatlog.ts). When staff take
// a chat over there, the assistant stays silent and their replies go out through this bridge. Groups, status updates, our own messages and messages
// older than 5 minutes (backlog after a restart) are ignored.
// Testers can send /reset (new order) and /lang (choose language again).
import { parseArgs } from "node:util";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  isJidGroup,
  isJidStatusBroadcast,
  isPnUser,
  useMultiFileAuthState,
  type WAMessage,
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";
import QRCode from "qrcode";
import { getConfig, repoRoot } from "@fmcg/config";
import { closePool, withTenantTx, withTx } from "@fmcg/db";
import { listProducts } from "@fmcg/catalogue";
import {
  claimStaffReplies,
  ensureDirectChannel,
  findRetailerByPhone,
  finishStaffReply,
  flagAttention,
  loadDraft,
  newDraft,
  notConnected,
  recordInbound,
  recordSentReply,
  recordUnknownSender,
  resumeAfterStaff,
  runRetailerTurn,
  saveDraft,
  setOwnerMode,
} from "@fmcg/orders";
import { resolveTenant } from "./tenant";

const { values } = parseArgs({ options: { relink: { type: "boolean", default: false }, pair: { type: "string" }, tenant: { type: "string" } } });

// ---- one bridge at a time --------------------------------------------------------------------
const lockFile = path.join(repoRoot, "storage", "wa-test.lock");
mkdirSync(path.dirname(lockFile), { recursive: true });
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
if (existsSync(lockFile)) {
  const other = Number(readFileSync(lockFile, "utf8").trim());
  if (other && other !== process.pid && alive(other)) {
    console.error(`Another WhatsApp test bridge is already running (process ${other}). Close that terminal, or end node.exe process ${other} in Task Manager, first:`);
    console.error("two bridges share one WhatsApp session and keep cancelling each other's QR codes.");
    process.exit(1);
  }
}
writeFileSync(lockFile, String(process.pid));
process.on("exit", () => {
  try {
    if (readFileSync(lockFile, "utf8").trim() === String(process.pid)) rmSync(lockFile);
  } catch {
    /* already gone */
  }
});

const cfg = getConfig();
if (!cfg.OPENAI_API_KEY) {
  console.error("Set OPENAI_API_KEY in .env first.");
  process.exit(1);
}

const digits = (s: string) => s.replace(/\D/g, "");

const tenant = await withTx((tx) => resolveTenant(tx, values.tenant)).catch(async (err) => {
  console.error((err as Error).message);
  await closePool();
  process.exit(1);
});
const productCount = (await withTenantTx(tenant.id, (tx) => listProducts(tx, { activeOnly: true }))).length;
if (!productCount) {
  console.error(`${tenant.name} has no products yet. Add them on the Catalogue page first.`);
  await closePool();
  process.exit(1);
}

const sessionDir = path.join(repoRoot, "storage", "wa-test-session");
const qrFile = path.join(repoRoot, "storage", "wa-qr.png");
const pairNumber = values.pair ? digits(values.pair) : "";
if (values.pair && !/^[1-9]\d{9,14}$/.test(pairNumber)) {
  console.error("--pair needs the bot phone's number with country code, e.g. --pair 919876543210");
  process.exit(1);
}
let pairRequested = false;
if (values.relink) rmSync(sessionDir, { recursive: true, force: true });
const logDir = path.join(repoRoot, "storage", "chat-logs");
mkdirSync(logDir, { recursive: true });
const log = (o: Record<string, unknown>) => {
  try {
    appendFileSync(path.join(logDir, `${new Date().toISOString().slice(0, 10)}.jsonl`), JSON.stringify({ at: new Date().toISOString(), channel: "whatsapp_test", ...o }) + "\n");
  } catch {
    /* logging must never break the bridge */
  }
};
const say = (s: string) => console.log(`[${new Date().toLocaleTimeString()}] ${s}`);

console.log(`${tenant.name} WhatsApp TEST bridge (unofficial WhatsApp Web; testing only)`);
console.log(`${productCount} products, extraction by ${cfg.OPENAI_MODEL}`);
const retailerCount = await withTenantTx(tenant.id, async (tx) => Number((await tx.query<{ n: string }>("SELECT count(*) AS n FROM retailers WHERE active")).rows[0]!.n));
console.log(`${retailerCount} active retailer number(s). Other numbers only get "not connected". Add retailers on the dashboard Retailers page.`);

let accountId = await withTx((tx) => ensureDirectChannel(tx, tenant.id, "whatsapp_test", null));
/** Where to reach each retailer (WhatsApp may address a chat by a private id instead of the number). */
const jidOf = new Map<string, string>();

// Each retailer's unconfirmed order is saved on their conversation (as in the customer app), so it
// survives a restart and staff can see it on the dashboard.
/** One message at a time per sender, so quick follow-ups never race each other. */
const lanes = new Map<string, Promise<void>>();
const MAX_AGE_S = 5 * 60;
const NOT_CONNECTED_EVERY_MS = 30 * 60 * 1000;
const notConnectedSent = new Map<string, number>();
let failures = 0;

function textOf(m: WAMessage): string | null {
  const c = m.message;
  if (!c) return null;
  return c.conversation ?? c.extendedTextMessage?.text ?? c.ephemeralMessage?.message?.extendedTextMessage?.text ?? c.ephemeralMessage?.message?.conversation ?? null;
}

/** The sender's phone number: WhatsApp may address chats by a private id (LID), with the number as the alternate. */
function phoneOf(m: WAMessage): string | null {
  for (const jid of [m.key.remoteJid, m.key.remoteJidAlt]) if (jid && isPnUser(jid)) return digits(jid.split("@")[0]!.split(":")[0]!);
  return null;
}

async function start(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const version = await fetchLatestBaileysVersion()
    .then((v) => v.version)
    .catch(() => undefined);
  const sock = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: "silent" }) as never,
    browser: ["FMCG Order Assistant (test)", "Chrome", "1.0"],
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (u) => {
    if (u.qr && pairNumber) {
      if (!pairRequested) {
        pairRequested = true;
        sock
          .requestPairingCode(pairNumber)
          .then((code) => {
            console.log(`\nLink code for +${pairNumber}:   ${code.slice(0, 4)}-${code.slice(4)}\n`);
            console.log("On that phone: WhatsApp > Settings > Linked devices > Link a device > Link with phone number instead, then type the code.\n");
          })
          .catch((e) => say(`could not get a link code: ${(e as Error).message}`));
      }
    } else if (u.qr) {
      console.log("\nScan with the TEST phone: WhatsApp > Settings > Linked devices > Link a device\n");
      qrcode.generate(u.qr, { small: true });
      QRCode.toFile(qrFile, u.qr, { width: 420, margin: 2 })
        .then(() => console.log(`Can't see or scan it? Open this image instead (it refreshes every ~20 s): ${qrFile}\n`))
        .catch(() => undefined);
    }
    if (u.connection === "open") {
      failures = 0;
      rmSync(qrFile, { force: true });
    }
    if (u.connection === "open") {
      const own = digits(sock.user?.id.split(":")[0] ?? "");
      void withTx((tx) => ensureDirectChannel(tx, tenant.id, "whatsapp_test", own ? `+${own}` : null))
        .then((id) => (accountId = id))
        .catch(() => undefined);
      current = sock;
    }
    if (u.connection === "close" && current === sock) current = null;
    if (u.connection === "open") say(`linked as +${digits(sock.user?.id.split(":")[0] ?? "")}. Waiting for messages...`);
    if (u.connection === "close") {
      const err = u.lastDisconnect?.error as { message?: string; output?: { statusCode?: number }; data?: { code?: string } } | undefined;
      const code = err?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        say("this device was logged out from the phone. Run  pnpm wa:test --relink  to link again.");
        void closePool().then(() => process.exit(1));
        return;
      }
      if (code === DisconnectReason.restartRequired) return void start();
      if (code === DisconnectReason.timedOut && /QR refs/i.test(err?.message ?? "")) {
        // Nobody scanned in time: start over with fresh codes straight away (not an error).
        say(pairNumber ? "link code expired; getting a new one..." : "QR code expired; showing a new one...");
        pairRequested = false;
        return void start();
      }
      failures++;
      const wait = Math.min(60, 3 * 2 ** Math.min(failures - 1, 5));
      say(`connection closed (${code ?? "unknown"}: ${err?.message ?? "no reason given"}); retrying in ${wait}s`);
      if (/certificate|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(`${err?.message} ${err?.data?.code}`) && failures === 1) {
        say("  An antivirus, VPN or office proxy is intercepting HTTPS. Allow node.exe / web.whatsapp.com in it,");
        say("  or set NODE_EXTRA_CA_CERTS to its root certificate (.pem) before running pnpm wa:test.");
      }
      setTimeout(() => void start(), wait * 1000);
    }
  });

  sock.ev.on("messages.upsert", ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages) {
      const jid = m.key.remoteJid;
      if (!jid || m.key.fromMe || isJidGroup(jid) || isJidBroadcast(jid) || isJidStatusBroadcast(jid)) continue;
      const phone = phoneOf(m);
      const who = phone ? `+${phone}` : jid;
      if (!phone) {
        say(`ignored message from ${who}: WhatsApp did not share the phone number`);
        continue;
      }
      // Sent while the bridge was offline: recorded and flagged for staff, but not answered by the
      // assistant (an automatic reply to an old order message could be wrong by now).
      const age = Date.now() / 1000 - Number(m.messageTimestamp ?? 0);
      const late = age > MAX_AGE_S;
      if (late) say(`late message from ${who} (${Math.round(age / 60)} min old): recorded for staff, no automatic reply`);
      const prev = lanes.get(jid) ?? Promise.resolve();
      const next = prev.then(() => handle(sock, m, jid, phone, late)).catch((err) => say(`error for ${who}: ${(err as Error).message}`));
      lanes.set(jid, next);
    }
  });
}

type Sock = ReturnType<typeof makeWASocket>;
/** The connected socket, for sending staff replies. */
let current: Sock | null = null;

/** Sends what staff typed on the dashboard (Conversations > Take over). */
let sendingStaff = false;
async function sendStaffReplies(): Promise<void> {
  const sock = current;
  if (!sock || sendingStaff) return;
  sendingStaff = true;
  try {
    for (const r of await withTx((tx) => claimStaffReplies(tx, tenant.id, accountId))) {
      let error: string | null = null;
      try {
        if (r.payload.kind !== "text" || !r.payload.text) throw new Error("The test bridge can only send plain text.");
        const jid = jidOf.get(r.phone) ?? `${digits(r.phone)}@s.whatsapp.net`;
        for (const part of chunks(r.payload.text)) await sock.sendMessage(jid, { text: part });
        say(`staff > ${r.phone}: ${r.payload.text.split("\n")[0]}`);
      } catch (err) {
        error = (err as Error).message;
        say(`could not send the staff reply to ${r.phone}: ${error}`);
      }
      await withTx((tx) => finishStaffReply(tx, tenant.id, r.id, error));
    }
  } catch (err) {
    say(`staff replies: ${(err as Error).message}`);
  } finally {
    sendingStaff = false;
  }
}
setInterval(() => void sendStaffReplies(), 2000);

/** WhatsApp caps a message at 4096 characters; long price lists go in parts, split between lines. */
function chunks(text: string, max = 3500): string[] {
  const out: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if (cur && cur.length + line.length + 1 > max) {
      out.push(cur);
      cur = line;
    } else cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) out.push(cur);
  return out;
}

async function handle(sock: Sock, m: WAMessage, jid: string, phone: string, late = false): Promise<void> {
  let conversationId: string | null = null;
  let replies = 0;
  const reply = async (text: string) => {
    for (const part of chunks(text)) await sock.sendMessage(jid, { text: part });
    const conv = conversationId;
    if (conv) {
      await withTx((tx) => recordSentReply(tx, { tenantId: tenant.id, conversationId: conv, key: `wa-test:${m.key.id}:${replies++}`, text })).catch((e) =>
        say(`could not record the reply: ${(e as Error).message}`),
      );
    }
  };
  await sock.readMessages([m.key]).catch(() => undefined);
  const retailer = await withTenantTx(tenant.id, (tx) => findRetailerByPhone(tx, `+${phone}`));
  if (!retailer || !retailer.active) {
    const last = notConnectedSent.get(jid) ?? 0;
    const why = retailer ? "retailer is inactive" : "number is not a retailer";
    log({ phone: `+${phone}`, message: textOf(m), not_connected: why });
    // Listed on the Retailers page under "Tried to order", so staff can add the number.
    await withTx((tx) =>
      recordUnknownSender(tx, { tenantId: tenant.id, phone: `+${phone}`, profileName: m.pushName ?? null, text: textOf(m), reason: retailer ? "retailer_inactive" : "not_a_retailer" }),
    ).catch((e) => say(`could not record the unknown number: ${(e as Error).message}`));
    if (late) return;
    if (Date.now() - last < NOT_CONNECTED_EVERY_MS) return say(`+${phone}${m.pushName ? ` (${m.pushName})` : ""}: ${why}; no reply (already told)`);
    notConnectedSent.set(jid, Date.now());
    say(`+${phone}${m.pushName ? ` (${m.pushName})` : ""}: ${why}; sent "not connected"`);
    await reply(notConnected(tenant.name));
    return;
  }
  const text = textOf(m)?.trim();
  jidOf.set(`+${phone}`, jid);
  const recorded = await withTx((tx) =>
    recordInbound(tx, {
      tenantId: tenant.id,
      accountId,
      phone: `+${phone}`,
      profileName: m.pushName ?? null,
      providerMessageId: m.key.id ?? `${jid}:${m.messageTimestamp}`,
      text: text || null,
      at: new Date(Number(m.messageTimestamp ?? Date.now() / 1000) * 1000),
    }),
  );
  conversationId = recorded.conversationId;
  if (late) {
    await withTx((tx) => flagAttention(tx, tenant.id, recorded.conversationId, "missed_message"));
    return;
  }
  if (recorded.ownerMode === "HUMAN") {
    say(`${retailer.shop_name} (+${phone}) > ${text || "(not a text message)"}   [with staff on the dashboard: no automatic reply]`);
    return;
  }
  if (!text) {
    await reply("Please type your order as a message (photos and voice notes are not read yet).\nஉங்கள் ஆர்டரை தட்டச்சு செய்து அனுப்பவும் (படங்கள், குரல் செய்திகள் இன்னும் படிக்கப்படாது).");
    return;
  }
  const conv = recorded.conversationId;
  // Staff handed the chat back on the dashboard: the retailer's unconfirmed items are kept.
  const state = resumeAfterStaff((await withTx((tx) => loadDraft(tx, tenant.id, conv))) ?? newDraft());
  if (text === "/reset" || text === "/lang") {
    await withTx((tx) => saveDraft(tx, tenant.id, conv, { ...newDraft(text === "/lang" ? null : state.lang, state.list_sent), last_order: state.last_order ?? null }));
    await reply(text === "/lang" ? "OK, choose again: reply English or தமிழ்." : "OK, starting a new order.");
    return;
  }
  const shopName = retailer.shop_name;
  say(`${shopName} (+${phone}) > ${text}`);
  await sock.sendPresenceUpdate("composing", jid).catch(() => undefined);
  try {
    const turn = await runRetailerTurn({ tenant, state, text, shopName, retailerName: retailer.contact_name ?? undefined, channel: "whatsapp_test", contactPhone: `+${phone}`, retailerId: retailer.id, conversationId });
    await withTx(async (tx) => {
      await saveDraft(tx, tenant.id, conv, turn.state);
      if (turn.state.status === "WITH_STAFF") await setOwnerMode(tx, tenant.id, conv, "HUMAN");
    });
    log({ phone: `+${phone}`, message: text, reply: turn.reply, status_before: state.status, status: turn.state.status, trace: turn.trace, learn: turn.learn });
    if (turn.reply === null) {
      say(`(no automated reply: conversation is with staff)`);
    } else {
      await reply(turn.reply);
      say(`bot > ${turn.reply.split("\n")[0]}${turn.reply.includes("\n") ? " ..." : ""}`);
    }
  } catch (err) {
    log({ phone: `+${phone}`, message: text, error: (err as Error).message });
    say(`error: ${(err as Error).message}`);
    await reply("Sorry, something went wrong on our side. Please send that again in a minute.\nமன்னிக்கவும், ஒரு பிழை ஏற்பட்டது. சிறிது நேரம் கழித்து மீண்டும் அனுப்பவும்.");
  } finally {
    await sock.sendPresenceUpdate("paused", jid).catch(() => undefined);
  }
}

const shutdown = async () => {
  await closePool();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await start();

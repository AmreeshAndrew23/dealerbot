// Talk to the order assistant from the terminal, as an already-authorised retailer would on WhatsApp.
//   pnpm chat [--shop "Murugan Stores"] [--name "Murugan anna"] [--lang en|ta] [--tenant "..."] [--debug]
// When the retailer confirms, the order is saved (orders module: READY_FOR_REVIEW, version 1, lines,
// confirmation) and the reply is a bill-style order copy with the order number. It then appears on
// the dashboard Orders page. --shop is the shop name on the order (retailer identity is E09).
// The assistant first asks English or Tamil (skip with --lang); the retailer may type in any language.
// /reset starts a new order (the language is kept), /lang asks again, /exit (or Ctrl+C) quits.
// --debug shows what the model extracted.
//
// Architecture 8.3: the model only extracts intent and candidate lines; products, packs, prices,
// totals and every reply come from code and the Catalogue (re-read for every message, so dashboard
// edits apply to the next reply). Nothing is ordered here: orders and versions arrive with E11.
//
// Learning: words the matcher was unsure about and the product the retailer then picked are saved
// as suggested aliases, and words that matched nothing as unmatched phrases. Staff review both on
// the Catalogue page. Every turn is also appended to storage/chat-logs/<date>.jsonl for tuning.
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { stdin, stdout } from "node:process";
import { getConfig, repoRoot } from "@fmcg/config";
import { closePool, withTenantTx, withTx } from "@fmcg/db";
import { listProducts } from "@fmcg/catalogue";
import { newDraft, runRetailerTurn } from "@fmcg/orders";
import { resolveTenant } from "./tenant";

const { values } = parseArgs({
  options: {
    tenant: { type: "string" },
    shop: { type: "string", default: "Test Shop (terminal)" },
    name: { type: "string" },
    lang: { type: "string" },
    debug: { type: "boolean", default: false },
  },
});
if (values.lang && values.lang !== "en" && values.lang !== "ta") {
  console.error("--lang must be en or ta");
  process.exit(1);
}

const cfg = getConfig();
if (!cfg.OPENAI_API_KEY) {
  console.error("Set OPENAI_API_KEY in .env first.");
  process.exit(1);
}

const load = () =>
  withTx(async (tx) => {
    const tenant = await resolveTenant(tx, values.tenant);
    return tenant;
  }).then(async (tenant) => ({ tenant, products: await withTenantTx(tenant.id, (tx) => listProducts(tx, { activeOnly: true })) }));

let first: Awaited<ReturnType<typeof load>>;
try {
  first = await load();
} catch (err) {
  console.error((err as Error).message);
  await closePool();
  process.exit(1);
}
if (!first.products.length) {
  console.error(`${first.tenant.name} has no products yet. Add them on the Catalogue page, or run:`);
  console.error("  pnpm catalogue:import --file data/britannia/catalogue.csv");
  await closePool();
  process.exit(1);
}

const logDir = path.join(repoRoot, "storage", "chat-logs");
mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
let session = randomUUID();
const log = (o: Record<string, unknown>) => {
  try {
    appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), session, ...o }) + "\n");
  } catch {
    /* logging must never break the chat */
  }
};

let state = newDraft((values.lang as "en" | "ta" | undefined) ?? null);
console.log(`${first.tenant.name} order assistant (${first.products.length} products, extraction by ${cfg.OPENAI_MODEL})`);
console.log("Type as a retailer, in any language. /reset = new order, /lang = choose language again, /exit = quit.");
console.log(`Turns are logged to ${path.relative(repoRoot, logFile)}\n`);

const rl = createInterface({ input: stdin, output: stdout, prompt: "you > " });
const quit = async () => {
  rl.close();
  await closePool();
  process.exit(0);
};
rl.on("SIGINT", () => void quit());

rl.prompt();
for await (const line of rl) {
  const text = line.trim();
  if (text === "/exit") break;
  if (text === "/reset" || text === "/lang") {
    state = newDraft(text === "/lang" ? null : state.lang);
    session = randomUUID();
    console.log(text === "/lang" ? "(the language will be asked again)\n" : "(new order)\n");
  } else if (text) {
    try {
      const before = state.status;
      const turn = await runRetailerTurn({ tenant: first.tenant, state, text, shopName: values.shop!, retailerName: values.name, channel: "terminal" });
      state = turn.state;
      log({ message: text, reply: turn.reply, status_before: before, status: state.status, version: state.version, trace: turn.trace, learn: turn.learn });
      if (values.debug && turn.trace.intent) {
        console.log(`  [${turn.trace.prompt_version} intent=${turn.trace.intent} lang=${turn.trace.language} choice=${turn.trace.choice}] ${JSON.stringify(turn.trace.extraction)}`);
      }
      console.log(turn.reply === null ? "\n(conversation is with staff: no automated reply)\n" : `\ndealer > ${turn.reply.replace(/\n/g, "\n         ")}\n`);
      if (values.debug) {
        console.log(`  [${state.status}${state.version ? `, version ${state.version}` : ""}${turn.learn.length ? `, learned: ${turn.learn.map((l) => (l.kind === "picked" ? `"${l.phrase}" -> ${l.sku}` : `"${l.phrase}" unmatched`)).join("; ")}` : ""}]\n`);
      }
    } catch (err) {
      log({ message: text, error: (err as Error).message });
      console.error(`\n(error: ${(err as Error).message})\n`);
    }
  }
  rl.prompt();
}
await quit();

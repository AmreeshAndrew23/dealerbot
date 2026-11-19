// Text normalisation for matching (architecture 8.3 step 1): Unicode NFC, Tamil numerals, rupee
// prefixes, common Romanised/Tamil unit words and number words. Pure functions, no I/O.

const TAMIL_DIGITS = "௦௧௨௩௪௫௬௭௮௯";

/** Lower-case, NFC, Tamil digits -> ASCII, "Rs10"/"₹10" -> "10", "250g" -> "250 g", punctuation -> space. */
export function normaliseText(s: string): string {
  return s
    .normalize("NFC")
    .toLowerCase()
    .replace(/[௦-௯]/g, (d) => String(TAMIL_DIGITS.indexOf(d)))
    .replace(/(?:\brs\.?|₹)\s*(?=\d)/g, " ")
    .replace(/(\d)([a-z])/g, "$1 $2")
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// ---- market vocabulary used only for matching (stored data is never rewritten) -----------------

/** Common spellings and short forms retailers type, mapped to the word used on packs. */
const WORD_SYNONYMS: Record<string, string> = {
  biskut: "biscuit", biscut: "biscuit", biskit: "biscuit", bisket: "biscuit", biscuts: "biscuits", biskets: "biscuits",
  cookie: "cookies", cooky: "cookies", kukis: "cookies",
  choco: "chocolate", choc: "chocolate", chocolat: "chocolate", chakleet: "chocolate",
  gluco: "glucose", glucos: "glucose", glukose: "glucose",
  crm: "cream", creme: "cream", crem: "cream",
  bred: "bread", brad: "bread", rusks: "rusk", rask: "rusk",
  cake: "cake", kek: "cake", cakes: "cake",
  digestiv: "digestive", digetive: "digestive",
  cashews: "cashew", kaju: "cashew", mundhiri: "cashew", munthiri: "cashew",
  butr: "butter", buttr: "butter", pista: "pista", badam: "badam",
  gm: "g", gms: "g", gram: "g", grams: "g", grm: "g", kg: "kg", kgs: "kg",
  big: "big", periya: "big", periyadhu: "big", large: "big",
  small: "small", chinna: "small", chinnadhu: "small", chotta: "small",
};

/** Words that carry no product meaning in an order line ("anna", "venum", "please"...). */
const FILLER = new Set([
  "anna", "annachi", "bro", "sir", "madam", "pa", "da", "ma", "ji", "boss", "thambi",
  "venum", "vennum", "veanum", "venam", "kudunga", "kodunga", "anuppunga", "anupunga", "podunga", "podu", "send", "pls", "please", "plz",
  "the", "of", "and", "also", "um", "innum", "more", "rupees", "rupee", "rs", "ruba", "rooba", "rupa", "only",
]);

/** Words that describe a kind of product, not which one ("marie biscuit" = Marie). */
const GENERIC = new Set(["biscuit", "biscuits", "cookies", "item", "items", "product", "brand", "variety", "flavour", "flavor"]);

/** matchForm without generic words, or "" when nothing specific would be left. */
export function specificForm(form: string): string {
  const words = form.split(" ").filter((w) => w && !GENERIC.has(w));
  return words.length && words.length < form.split(" ").length ? words.join(" ") : "";
}

/** Normalised text with synonyms applied and filler words removed: what the matcher compares. */
export function matchForm(s: string): string {
  return normaliseText(s)
    .split(" ")
    .map((w) => WORD_SYNONYMS[w] ?? w)
    .filter((w) => w && !FILLER.has(w))
    .join(" ");
}

const NUMBER_WORDS: Record<string, number> = {
  // English
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, a: 1, an: 1, dozen: 12,
  // Romanised Tamil (common spellings)
  oru: 1, onnu: 1, ondru: 1, rendu: 2, irandu: 2, randu: 2, moonu: 3, munu: 3, moondru: 3, naalu: 4, nalu: 4,
  anju: 5, ainthu: 5, aindhu: 5, aaru: 6, aru: 6, ezhu: 7, elu: 7, ettu: 8, onbadhu: 9, ombodhu: 9, ombathu: 9,
  pathu: 10, patthu: 10, paththu: 10,
  // Tamil script
  "ஒன்று": 1, "ஒரு": 1, "இரண்டு": 2, "ரெண்டு": 2, "மூன்று": 3, "நான்கு": 4, "நாலு": 4, "ஐந்து": 5, "அஞ்சு": 5,
  "ஆறு": 6, "ஏழு": 7, "எட்டு": 8, "ஒன்பது": 9, "பத்து": 10,
};

/** Whole positive quantity from "2", "௨", "rendu", "two"; null when unclear (asks the retailer). */
export function parseQuantity(text: string): number | null {
  const t = normaliseText(text);
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    return n > 0 && n <= 100_000 ? n : null;
  }
  return NUMBER_WORDS[t] ?? null;
}

const UNIT_WORDS: Record<string, string> = {
  box: "BOX", boxes: "BOX", bx: "BOX", bxs: "BOX", bxes: "BOX", petti: "BOX", petty: "BOX", pettis: "BOX", petiti: "BOX",
  dabba: "BOX", dappa: "BOX", "பெட்டி": "BOX", "டப்பா": "BOX",
  case: "CASE", cases: "CASE", cs: "CASE", cse: "CASE", css: "CASE", carton: "CASE", cartons: "CASE", ctn: "CASE", ctns: "CASE",
  kes: "CASE", "கேஸ்": "CASE",
  pcs: "PCS", pc: "PCS", piece: "PCS", pieces: "PCS", peice: "PCS", peices: "PCS", nos: "PCS", no: "PCS",
  pkt: "PCS", pkts: "PCS", packet: "PCS", packets: "PCS", pack: "PCS", packs: "PCS", "பீஸ்": "PCS", "பாக்கெட்": "PCS",
  katta: "BUNDLE", kattu: "BUNDLE", bundle: "BUNDLE", bundles: "BUNDLE", bdl: "BUNDLE", "கட்டு": "BUNDLE",
  strip: "STRIP", strips: "STRIP", tray: "TRAY", trays: "TRAY",
  dozen: "DOZEN", dozens: "DOZEN", dz: "DOZEN", doz: "DOZEN",
};

/** "1 dozen" means 12 pieces even when no DOZEN pack is defined. */
export const DOZEN_PIECES = 12;

/** Canonical unit code ("petti" -> "BOX"), the upper-cased text if unknown, or null if empty. */
export function parseUnit(text: string): string | null {
  const t = normaliseText(text);
  if (!t) return null;
  return UNIT_WORDS[t] ?? t.toUpperCase().replace(/\s+/g, "");
}

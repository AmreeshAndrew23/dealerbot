// Catalogue search (architecture 8.3 step 3): finds real SKUs for a product phrase using names and
// approved aliases. Trigram scoring mirrors PostgreSQL pg_trgm so it can move into SQL later.
// The result says whether the phrase is resolved, ambiguous (needs a question, gate 5) or unknown.
import { matchForm, normaliseText, specificForm } from "./normalise";

export interface Matchable {
  sku: string;
  name: string;
  category?: string;
  aliases: string[];
  active: boolean;
}

const singular = (s: string) => matchForm(s).replace(/(e?s)\b/g, "");

export interface Candidate {
  sku: string;
  score: number;
  /** The name or alias that matched best. */
  via: string;
}

export type MatchResult =
  | { kind: "resolved"; sku: string; candidates: Candidate[] }
  | { kind: "ambiguous"; candidates: Candidate[] }
  | { kind: "none"; candidates: Candidate[] };

export const MATCH_MIN = 0.45; // below this a candidate is not offered at all
export const MATCH_MARGIN = 0.15; // the winner must lead the runner-up by this much

function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of s.split(" ").filter(Boolean)) {
    const p = `  ${w} `;
    const chars = [...p];
    for (let i = 0; i + 3 <= chars.length; i++) out.add(chars.slice(i, i + 3).join(""));
  }
  return out;
}

/** 0..1: half pg_trgm similarity (Jaccard), half how much of the query appears in the text. */
export function phraseScore(query: string, text: string): number {
  return scoreForms(matchForm(query), matchForm(text));
}

/**
 * Retailers shorten brands to initials: "gd" = Good Day, "mg" = Marie Gold, "nc" = NutriChoice.
 * A 2-4 letter token equal to the initials of the product name's leading words is read as those words.
 */
export function expandInitials(queryForm: string, nameForm: string): string {
  const words = nameForm.split(" ").filter((w) => /^\p{L}/u.test(w) && w.length > 1);
  if (words.length < 2) return queryForm;
  return queryForm
    .split(" ")
    .map((tok) => {
      if (!/^[a-z]{2,4}$/.test(tok)) return tok;
      for (let k = Math.min(4, words.length); k >= 2; k--) {
        if (words.slice(0, k).map((w) => w[0]).join("") === tok) return words.slice(0, k).join(" ");
      }
      return tok;
    })
    .join(" ");
}

function scoreForms(q: string, t: string): number {
  if (!q || !t) return 0;
  if (q === t) return 1;
  const a = trigrams(q);
  const b = trigrams(t);
  let common = 0;
  for (const g of a) if (b.has(g)) common++;
  const jaccard = common / (a.size + b.size - common);
  const containment = common / a.size;
  let score = 0.5 * jaccard + 0.5 * containment;
  // Pack sizes and price points are numbers: "bourbon 30" must not settle on "bourbon 10".
  const qn: string[] = q.match(/\d+/g) ?? [];
  const tn: string[] = t.match(/\d+/g) ?? [];
  if (qn.length && tn.length && !qn.some((n) => tn.includes(n))) score *= 0.5;
  return Math.min(score, 0.99); // only an exact name/alias scores 1
}

export function matchProduct(phrase: string, products: Matchable[]): MatchResult {
  const candidates = products
    .filter((p) => p.active)
    .map((p) => {
      const exactPhrase = normaliseText(phrase);
      const nameForm = matchForm(p.name);
      const q = matchForm(phrase);
      const qx = expandInitials(q, nameForm);
      const qs = specificForm(q);
      let best: Candidate = { sku: p.sku, score: 0, via: p.name };
      for (const text of [p.name, ...p.aliases]) {
        // Exact = the words the retailer typed are this product's name or an approved alias
        // (only case, punctuation, Tamil digits and "Rs" are ignored). Nothing else is assumed.
        if (exactPhrase && exactPhrase === normaliseText(text)) {
          best = { sku: p.sku, score: 1, via: text };
          break;
        }
        // Everything below is a guess (spelling, synonyms, initials, generic words) and is only
        // ever offered to the retailer as a choice.
        const t = matchForm(text);
        const s = Math.min(
          0.99,
          Math.max(scoreForms(q, t), qx !== q ? scoreForms(qx, t) : 0, qs ? scoreForms(qs, t) : 0),
        );
        if (s > best.score) best = { sku: p.sku, score: s, via: text };
      }
      return best;
    })
    .filter((c) => c.score >= MATCH_MIN)
    .sort((x, y) => y.score - x.score || x.sku.localeCompare(y.sku));

  const exact = candidates.filter((c) => c.score === 1);
  if (exact.length === 1) return { kind: "resolved", sku: exact[0]!.sku, candidates };

  // "2 boxes biscuit": a category word is never a product, even if some alias contains it.
  const qc = singular(phrase);
  const inCategory = products.filter((p) => p.active && p.category && singular(p.category) === qc);
  if (inCategory.length > 1 && !exact.length) {
    const ranked = inCategory
      .map((p) => candidates.find((c) => c.sku === p.sku) ?? { sku: p.sku, score: 0, via: p.name })
      .sort((x, y) => y.score - x.score || x.sku.localeCompare(y.sku));
    return { kind: "ambiguous", candidates: ranked.slice(0, 3) };
  }

  const top = candidates[0];
  if (!top) return { kind: "none", candidates: [] };
  // One or more guesses: the retailer picks ("Did you mean ...?" when there is only one).
  return { kind: "ambiguous", candidates: candidates.filter((c) => c.score >= top.score - MATCH_MARGIN).slice(0, 3) };
}

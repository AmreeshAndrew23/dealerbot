import { badRequest } from "./errors";

export const MAX_LIMIT = 100;

export function parseLimit(v: unknown, def = 50): number {
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw badRequest("limit must be a positive integer");
  return Math.min(n, MAX_LIMIT);
}

/** Opaque cursor over (timestamp, id) for stable keyset pagination. */
export function encodeCursor(t: Date | string, id: string): string {
  return Buffer.from(JSON.stringify([new Date(t).toISOString(), id])).toString("base64url");
}

export function decodeCursor(c: unknown): { t: string; id: string } | null {
  if (c === undefined || c === "") return null;
  try {
    const [t, id] = JSON.parse(Buffer.from(String(c), "base64url").toString("utf8"));
    if (typeof t !== "string" || typeof id !== "string" || Number.isNaN(Date.parse(t))) throw new Error();
    return { t, id };
  } catch {
    throw badRequest("Invalid cursor");
  }
}

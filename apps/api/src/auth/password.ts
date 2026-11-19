import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

const scrypt = (pw: string, salt: Buffer, len: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(pw, salt, len, opts, (e, k) => (e ? reject(e) : resolve(k))));

const N = 2 ** 15;
const r = 8;
const p = 1;
const LEN = 64;

/** Format: scrypt$N$r$p$saltB64$hashB64 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, LEN, { N, r, p, maxmem: 128 * N * r * 2 });
  return ["scrypt", N, r, p, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [alg, n, rr, pp, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const key = await scrypt(password, Buffer.from(salt, "base64"), expected.length, {
    N: Number(n),
    r: Number(rr),
    p: Number(pp),
    maxmem: 128 * Number(n) * Number(rr) * 2,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export function passwordProblem(pw: unknown): string | null {
  if (typeof pw !== "string") return "Password is required.";
  if (pw.length < 10) return "Password must be at least 10 characters.";
  if (pw.length > 200) return "Password is too long.";
  return null;
}

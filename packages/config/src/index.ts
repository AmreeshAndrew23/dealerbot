import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";

// Repo root .env, regardless of which app directory the process starts in.
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
loadDotenv({ path: path.join(repoRoot, ".env"), quiet: true } as never);

const schema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().default(3100),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  WHATSAPP_APP_SECRET: z.string().default(""),
  WHATSAPP_VERIFY_TOKEN: z.string().default(""),
  GRAPH_API_VERSION: z.string().regex(/^v\d+\.\d+$/).default("v23.0"),
  MEDIA_STORAGE_DIR: z.string().default("./storage"),
  MEDIA_MAX_BYTES: z.coerce.number().int().positive().default(16 * 1024 * 1024),
  MEDIA_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  OPENAI_API_KEY: z.string().default(""),
  OPENAI_MODEL: z.string().default("gpt-4.1"),
  /** Where retailers open the customer app (apps/shop); staff share this link with the access code. */
  RETAILER_APP_URL: z.string().url().default("http://localhost:5181"),
  /** Hosting (Railway): serve the built dashboard at / and the customer app at /shop/ from the API. */
  SERVE_STATIC: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  /** Behind a hosting proxy (Railway): take the visitor's IP from X-Forwarded-For (login throttling). */
  TRUST_PROXY: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
});

export type AppConfig = z.infer<typeof schema>;

let cached: AppConfig | undefined;

export function getConfig(): AppConfig {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment (check .env at ${repoRoot}):\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Absolute media directory (relative paths are resolved from the repo root). */
export function mediaDir(cfg: AppConfig = getConfig()): string {
  return path.isAbsolute(cfg.MEDIA_STORAGE_DIR) ? cfg.MEDIA_STORAGE_DIR : path.join(repoRoot, cfg.MEDIA_STORAGE_DIR);
}

/**
 * Resolves a secret reference stored in the database. Credentials are never stored in tables.
 * Supported now: "env:NAME". Production adds "aws-sm:<arn>" (Secrets Manager).
 */
export function resolveSecret(reference: string): string {
  const [scheme, name] = reference.split(":", 2);
  if (scheme === "env" && name) {
    const value = process.env[name];
    if (!value) throw new Error(`Secret ${reference} is not set in the environment`);
    return value;
  }
  throw new Error(`Unsupported secret reference scheme: ${scheme}`);
}

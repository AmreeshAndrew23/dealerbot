import fp from "fastify-plugin";
import type { FastifyRequest } from "fastify";
import { can, type Permission } from "./permissions";
import { loadSession, SESSION_COOKIE, type SessionUser } from "./sessions";
import { forbidden, unauthenticated } from "../lib/errors";

declare module "fastify" {
  interface FastifyRequest {
    staff?: SessionUser;
  }
}

/** Attaches req.staff for /v1 requests that carry a valid session cookie. */
export const authPlugin = fp(async (app) => {
  app.addHook("onRequest", async (req) => {
    if (!req.url.startsWith("/v1/")) return;
    const token = req.cookies?.[SESSION_COOKIE];
    const s = await loadSession(token);
    if (s) req.staff = s;
  });
});

export function requireStaff(req: FastifyRequest, perm?: Permission): SessionUser {
  const s = req.staff;
  if (!s) throw unauthenticated();
  if (perm && !can(s.role, perm)) throw forbidden();
  return s;
}

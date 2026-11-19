// Role permissions. PRD section 2 is not legible in the supplied copy (open decision #4);
// this matrix follows the readable parts and must be confirmed against the original.
export type Role = "OWNER" | "OPERATOR" | "VIEWER";

export type Permission =
  | "orders.view"
  | "conversations.view"
  | "conversations.reply" // takeover, resume, human reply
  | "orders.edit"
  | "orders.approve"
  | "contacts.authorise"
  | "catalogue.view"
  | "catalogue.edit" // add/edit products and prices, CSV upload
  | "catalogue.approve"
  | "consent.manage"
  | "users.manage"
  | "settings.manage";

const MATRIX: Record<Role, ReadonlySet<Permission>> = {
  OWNER: new Set<Permission>([
    "orders.view",
    "conversations.view",
    "conversations.reply",
    "orders.edit",
    "orders.approve",
    "contacts.authorise",
    "catalogue.view",
    "catalogue.edit",
    "catalogue.approve",
    "consent.manage",
    "users.manage",
    "settings.manage",
  ]),
  OPERATOR: new Set<Permission>([
    "orders.view",
    "conversations.view",
    "conversations.reply",
    "orders.edit",
    "orders.approve",
    "contacts.authorise",
    "catalogue.view",
    "catalogue.edit",
    "catalogue.approve",
  ]),
  VIEWER: new Set<Permission>(["orders.view", "conversations.view", "catalogue.view"]),
};

export function can(role: Role, perm: Permission): boolean {
  return MATRIX[role].has(perm);
}

export function permissionsFor(role: Role): Permission[] {
  return [...MATRIX[role]];
}

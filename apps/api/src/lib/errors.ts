/** Errors that map to the PRD error envelope: { error: { code, message, details, request_id } }. */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const unauthenticated = () => new ApiError(401, "UNAUTHENTICATED", "Please sign in.");
export const forbidden = (msg = "You do not have permission to do this.") => new ApiError(403, "FORBIDDEN", msg);
export const notFound = (what = "Resource") => new ApiError(404, "NOT_FOUND", `${what} not found.`);
export const badRequest = (msg: string, details: Record<string, unknown> = {}) => new ApiError(400, "MALFORMED_REQUEST", msg, details);

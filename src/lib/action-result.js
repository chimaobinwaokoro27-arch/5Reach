/**
 * Result envelope for the Contacts / Campaigns server actions.
 *
 * Why this exists: in a production build Next.js replaces any error thrown
 * inside a Server Action with the generic message "An error occurred in the
 * Server Components render. The specific message is omitted in production
 * builds to avoid leaking sensitive details." and ships only a digest. Throwing
 * therefore destroys every validation and permission message we write, and the
 * client can no longer tell a signed-out session from a genuine failure.
 *
 * Returning a result instead of throwing keeps the user-safe message intact
 * and lets the client branch on a stable error code.
 */

export const ACTION_ERROR_CODES = {
  /** The caller has no valid session. */
  AUTH_REQUIRED: "AUTH_REQUIRED",
  /** The caller's organization role does not allow this action. */
  PERMISSION_DENIED: "PERMISSION_DENIED",
  /** The record does not exist inside the caller's organization. */
  NOT_FOUND: "NOT_FOUND",
  /** The input failed validation. */
  VALIDATION: "VALIDATION",
  /** The input conflicts with data that already exists. */
  CONFLICT: "CONFLICT",
  /** Anything unexpected. The underlying cause is logged, not returned. */
  UNKNOWN: "UNKNOWN",
};

/** A successful action result. */
export function actionSuccess(data) {
  return { ok: true, data };
}

/** A failed action result carrying a message that is safe to show a user. */
export function actionFailure(message, code = ACTION_ERROR_CODES.UNKNOWN) {
  return { ok: false, error: message, code };
}

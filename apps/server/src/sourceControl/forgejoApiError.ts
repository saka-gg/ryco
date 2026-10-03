import { Option, Schema } from "effect";

export class ForgejoApiError extends Schema.TaggedError<ForgejoApiError>()("ForgejoApiError", {
  operation: Schema.String,
  detail: Schema.String,
  status: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Forgejo API failed in ${this.operation}: ${this.detail}`;
  }
}

export function isForgejoApiError(cause: unknown): cause is ForgejoApiError {
  return Schema.is(ForgejoApiError)(cause);
}

/** Forgejo's REST error body (`APIError`): `{ "message": "...", "url": "..." }`. */
const ForgejoErrorBodySchema = Schema.Struct({
  message: Schema.optional(Schema.NullOr(Schema.String)),
  errors: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
});
const decodeForgejoErrorBody = Schema.decodeUnknownOption(ForgejoErrorBodySchema);

/**
 * The human part of a Forgejo error response: the JSON `message` when there
 * is one (e.g. `head out of date`), else the trimmed raw body.
 */
export function forgejoErrorMessage(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) return "";
  try {
    const decoded = decodeForgejoErrorBody(JSON.parse(trimmed));
    const message = Option.isSome(decoded) ? decoded.value.message?.trim() : undefined;
    if (message) return message;
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return trimmed.length > 500 ? `${trimmed.slice(0, 500)}…` : trimmed;
}

export const FORGEJO_STALE_HEAD_DETAIL =
  "The pull request's head changed since it was loaded. Refresh and review the new commits, then try again.";

export function forgejoStaleHeadError(operation: string): ForgejoApiError {
  return new ForgejoApiError({ operation, status: 409, detail: FORGEJO_STALE_HEAD_DETAIL });
}

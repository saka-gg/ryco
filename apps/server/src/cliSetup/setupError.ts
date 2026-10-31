import { Data } from "effect";

/**
 * A `ryco setup` or `ryco config` failure, printed as its message. It lives apart from the
 * setup guide (`setupFlow.ts`) so the CLI can raise it without loading the guide, which loads
 * only when a command opens it.
 */
export class SetupError extends Data.TaggedError("SetupError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

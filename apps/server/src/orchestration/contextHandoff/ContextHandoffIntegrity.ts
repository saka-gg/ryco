import { Data, Effect, Schema } from "effect";

import { sha256Hex } from "../../canonicalJson.ts";
import {
  type ContextHandoffArtifact,
  ContextHandoffDocument,
  countContextHandoffEntries,
  stableStringifyContextHandoff,
} from "./ContextHandoffBuilder.ts";

export class ContextHandoffIntegrityError extends Data.TaggedError("ContextHandoffIntegrityError")<{
  readonly reason: "digest-mismatch" | "invalid-stored-context";
}> {}

/**
 * Verifies a stored context document against its stored digest, then decodes it.
 *
 * The digest covers the canonical JSON of the value as it was stored, so it is checked before
 * decoding: decoding normalises values (it trims strings and drops undeclared keys), and a
 * document whose stored bytes are intact must never fail on what decoding changed. Any edit to
 * the stored JSON still changes the digest. The returned canonical JSON and digest are the
 * stored ones; callers use them as they are and never recompute them from the decoded document.
 */
export const verifyStoredContextHandoffDocument = Effect.fn(
  "ContextHandoffIntegrity.verifyStoredDocument",
)(function* (stored: unknown, storedDigest: string) {
  const canonicalJson = stableStringifyContextHandoff(stored);
  const digest = sha256Hex(canonicalJson);
  if (digest !== storedDigest) {
    return yield* new ContextHandoffIntegrityError({ reason: "digest-mismatch" });
  }
  const document = yield* Schema.decodeUnknownEffect(ContextHandoffDocument)(stored).pipe(
    Effect.mapError(() => new ContextHandoffIntegrityError({ reason: "invalid-stored-context" })),
  );
  return {
    document,
    canonicalJson,
    digest,
    entryCount: countContextHandoffEntries(document),
  } satisfies ContextHandoffArtifact;
});

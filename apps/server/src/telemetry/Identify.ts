import { Effect, FileSystem, Schema } from "effect";
import * as Crypto from "node:crypto";
import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";

class IdentifyUserError extends Schema.TaggedError<IdentifyUserError>()("IdentifyUserError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const hash = (value: string) =>
  Effect.try({
    try: () => Crypto.createHash("sha256").update(value).digest("hex"),
    catch: (error) =>
      new IdentifyUserError({
        message: "Failed to hash identifier",
        cause: error,
      }),
  });

const upsertAnonymousId = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const { anonymousIdPath } = yield* ServerConfig;

  // Only a missing file starts a new id: any other read failure fails here
  // rather than replacing the stored id.
  const storedId = yield* fileSystem.readFileString(anonymousIdPath).pipe(
    Effect.map((value) => value.trim()),
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(""),
    ),
  );
  if (storedId.length > 0) {
    return storedId;
  }

  const randomId = yield* Effect.sync(() => Crypto.randomUUID());
  yield* writeFileStringAtomically({ filePath: anonymousIdPath, contents: randomId });
  return randomId;
});

/**
 * getTelemetryIdentifier - A hash of this installation's random id (the state
 * dir's `anonymous-id`) scoped to the analytics project key it is sent with. It
 * is never derived from provider accounts or other files outside Ryco's state,
 * and the ids sent to two projects cannot be matched to each other.
 */
export const getTelemetryIdentifier = (projectKey: string) =>
  upsertAnonymousId.pipe(
    Effect.flatMap((installId) => hash(`${projectKey}\n${installId}`)),
    Effect.tapError((error) => Effect.logWarning("Failed to get identifier", { cause: error })),
    Effect.orElseSucceed(() => null),
  );

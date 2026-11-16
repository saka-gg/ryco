import * as Crypto from "node:crypto";

import { Effect, FileSystem, Layer, Path, Predicate } from "effect";
import * as PlatformError from "effect/PlatformError";

import { ServerConfig } from "../../config.ts";
import {
  SecretStoreError,
  ServerSecretStore,
  type ServerSecretStoreShape,
} from "../Services/ServerSecretStore.ts";

export const makeServerSecretStore = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;

  yield* fileSystem.makeDirectory(serverConfig.secretsDir, { recursive: true });
  yield* fileSystem.chmod(serverConfig.secretsDir, 0o700).pipe(
    Effect.mapError(
      (cause) =>
        new SecretStoreError({
          message: `Failed to secure secrets directory ${serverConfig.secretsDir}.`,
          cause,
        }),
    ),
  );

  const resolveSecretPath = (name: string) => path.join(serverConfig.secretsDir, `${name}.bin`);

  const ensureSecretDirectory = (secretPath: string) => {
    const directory = path.dirname(secretPath);
    return fileSystem
      .makeDirectory(directory, { recursive: true })
      .pipe(Effect.flatMap(() => fileSystem.chmod(directory, 0o700)));
  };

  const isPlatformError = (u: unknown): u is PlatformError.PlatformError =>
    Predicate.isTagged(u, "PlatformError");

  const get: ServerSecretStoreShape["get"] = (name) =>
    fileSystem.readFile(resolveSecretPath(name)).pipe(
      Effect.map((bytes) => Uint8Array.from(bytes)),
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed(null)
          : Effect.fail(
              new SecretStoreError({
                message: `Failed to read secret ${name}.`,
                cause,
              }),
            ),
      ),
    );

  // Deliberately not the shared `writeFileAtomically` (atomicWrite.ts): a credential store keeps
  // its own short, auditable write path, with the temp file and the secret both chmod'ed to 0600
  // explicitly inside the 0700 secrets folder.
  const set: ServerSecretStoreShape["set"] = (name, value) => {
    const secretPath = resolveSecretPath(name);
    const tempPath = `${secretPath}.${Crypto.randomUUID()}.tmp`;
    return Effect.gen(function* () {
      yield* ensureSecretDirectory(secretPath);
      yield* fileSystem.writeFile(tempPath, value);
      yield* fileSystem.chmod(tempPath, 0o600);
      yield* fileSystem.rename(tempPath, secretPath);
      yield* fileSystem.chmod(secretPath, 0o600);
    }).pipe(
      Effect.catch((cause) =>
        fileSystem.remove(tempPath).pipe(
          Effect.ignore,
          Effect.flatMap(() =>
            Effect.fail(
              new SecretStoreError({
                message: `Failed to persist secret ${name}.`,
                cause,
              }),
            ),
          ),
        ),
      ),
    );
  };

  // Create-if-absent without ever exposing a half-written secret: the bytes go to a private temp
  // file first, and only a complete, flushed file is hard-linked to the final name. `link` fails
  // with AlreadyExists when another writer got there first, and never replaces its file.
  const create: ServerSecretStoreShape["set"] = (name, value) => {
    const secretPath = resolveSecretPath(name);
    const tempPath = `${secretPath}.${Crypto.randomUUID()}.tmp`;
    return Effect.gen(function* () {
      yield* ensureSecretDirectory(secretPath);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fileSystem.open(tempPath, {
            flag: "wx",
            mode: 0o600,
          });
          yield* file.writeAll(value);
          yield* file.sync;
        }),
      );
      yield* fileSystem.chmod(tempPath, 0o600);
      yield* fileSystem.link(tempPath, secretPath);
    }).pipe(
      Effect.ensuring(fileSystem.remove(tempPath).pipe(Effect.ignore)),
      Effect.mapError(
        (cause) =>
          new SecretStoreError({
            message: `Failed to persist secret ${name}.`,
            cause,
          }),
      ),
    );
  };

  const getOrCreateRandom: ServerSecretStoreShape["getOrCreateRandom"] = (name, bytes) => {
    // A stored secret of the wrong length is never handed out: an empty or short signing key
    // would make every token it signs forgeable. Such a file can only be left behind by an
    // interrupted write from an older build, so it is replaced with a fresh secret, which ends
    // whatever was signed with the broken one.
    const replaceCorrupt = (found: Uint8Array) => {
      const generated = Uint8Array.from(Crypto.randomBytes(bytes));
      return Effect.logWarning("Replacing a stored secret of the wrong length.", {
        name,
        expectedBytes: bytes,
        foundBytes: found.byteLength,
      }).pipe(Effect.andThen(set(name, generated)), Effect.as(generated));
    };

    const accept = (
      found: Uint8Array | null,
      onMissing: () => Effect.Effect<Uint8Array, SecretStoreError>,
    ): Effect.Effect<Uint8Array, SecretStoreError> =>
      found === null
        ? onMissing()
        : found.byteLength === bytes
          ? Effect.succeed(found)
          : replaceCorrupt(found);

    const createNew = () => {
      const generated = Uint8Array.from(Crypto.randomBytes(bytes));
      return create(name, generated).pipe(
        Effect.as(generated),
        Effect.catchTag("SecretStoreError", (error) =>
          isPlatformError(error.cause) && error.cause.reason._tag === "AlreadyExists"
            ? get(name).pipe(
                Effect.flatMap((created) =>
                  accept(created, () =>
                    Effect.fail(
                      new SecretStoreError({
                        message: `Failed to read secret ${name} after concurrent creation.`,
                      }),
                    ),
                  ),
                ),
              )
            : Effect.fail(error),
        ),
      );
    };

    return get(name).pipe(Effect.flatMap((existing) => accept(existing, createNew)));
  };

  const remove: ServerSecretStoreShape["remove"] = (name) =>
    fileSystem.remove(resolveSecretPath(name)).pipe(
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.void
          : Effect.fail(
              new SecretStoreError({
                message: `Failed to remove secret ${name}.`,
                cause,
              }),
            ),
      ),
    );

  return {
    get,
    set,
    getOrCreateRandom,
    remove,
  } satisfies ServerSecretStoreShape;
});

export const ServerSecretStoreLive = Layer.effect(ServerSecretStore, makeServerSecretStore);

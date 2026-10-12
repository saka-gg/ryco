/**
 * Probe fingerprints — the identity of everything a provider status probe observes.
 *
 * A persisted provider snapshot may stand in for a cold probe after a restart only while the
 * inputs that produced it are unchanged: the same server build, the same instance settings
 * (config, environment, presentation) and the same CLI binary on disk. The binary is identified
 * by its resolved path plus `stat` metadata (mtime, size, inode), so package-manager upgrades,
 * reinstalls and PATH changes invalidate the snapshot without spawning `--version`. File-based
 * credential stores are stat'ed the same way so a login or logout re-probes auth.
 *
 * Computing a fingerprint never spawns a process. It walks PATH once (lazily, never during driver
 * construction, with async per-entry-bounded checks) and issues one bounded `stat`.
 *
 * @module provider/providerProbeFingerprint
 */
import { createHash } from "node:crypto";

import type { ProviderDriverKind } from "@ryco/contracts";
import { resolveCommandPathAsync } from "@ryco/shared/shell";
import { Duration, Effect, FileSystem, Option } from "effect";

import packageJson from "../../package.json" with { type: "json" };

/** Bump when probe semantics change in a way older persisted snapshots cannot express. */
const PROBE_FINGERPRINT_FORMAT = 1;
const BINARY_STAT_TIMEOUT = Duration.seconds(2);

const stableJson = (value: unknown): string =>
  JSON.stringify(value, (_key, nested: unknown) => {
    if (nested === null || typeof nested !== "object" || Array.isArray(nested)) {
      return nested;
    }
    return Object.fromEntries(
      Object.entries(nested as Record<string, unknown>).toSorted(([left], [right]) =>
        left.localeCompare(right),
      ),
    );
  });

export interface ProviderProbeFingerprintInput {
  readonly driverKind: ProviderDriverKind;
  /** Commands the probe may spawn (configured binary plus any preferred alternative). */
  readonly binaryPaths: ReadonlyArray<string>;
  /** Environment used to resolve `binaryPaths` on PATH. */
  readonly env: NodeJS.ProcessEnv;
  /** Everything else the probe result depends on (decoded config, environment, presentation). */
  readonly settings: unknown;
  /** Credential files whose replacement changes the probed auth state. */
  readonly authFiles?: ReadonlyArray<string>;
  /** Inputs that can change while the instance lives (e.g. a remotely refreshed model catalog). */
  readonly dynamicInputs?: Effect.Effect<unknown>;
}

const describeFileInfo = (info: FileSystem.File.Info): string => {
  const mtimeMs = Option.match(info.mtime, {
    onNone: () => "?",
    onSome: (mtime) => String(mtime.getTime()),
  });
  const inode = Option.match(info.ino, { onNone: () => "?", onSome: String });
  return `${mtimeMs}:${String(info.size)}:${inode}`;
};

/** `stat` signature of a file, or `None` when it is missing or the stat does not finish in time. */
const statSignature = (
  fileSystem: FileSystem.FileSystem,
  filePath: string,
): Effect.Effect<Option.Option<string>> =>
  fileSystem.stat(filePath).pipe(
    Effect.timeoutOption(BINARY_STAT_TIMEOUT),
    Effect.map(Option.map(describeFileInfo)),
    Effect.catch(() => Effect.succeed(Option.none<string>())),
  );

const describeBinary = Effect.fn("describeProviderProbeBinary")(function* (
  binaryPath: string,
  env: NodeJS.ProcessEnv,
) {
  const trimmed = binaryPath.trim();
  if (!trimmed) {
    return "none";
  }
  // Async and bounded per PATH entry: a stalled mount must not block the event loop.
  const resolved = yield* Effect.promise(() => resolveCommandPathAsync(trimmed, { env }));
  if (!resolved) {
    return `missing:${trimmed}`;
  }
  const signature = yield* statSignature(yield* FileSystem.FileSystem, resolved);
  if (Option.isNone(signature)) {
    // Unknown identity: never matches a persisted fingerprint, so the next demand probes.
    return `unstattable:${resolved}:${crypto.randomUUID()}`;
  }
  return `${resolved}:${signature.value}`;
});

const describeAuthFiles = Effect.fn("describeProviderProbeAuthFiles")(function* (
  authFiles: ReadonlyArray<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* Effect.forEach(
    authFiles,
    (filePath) =>
      statSignature(fileSystem, filePath).pipe(
        Effect.map((signature) => `${filePath}:${Option.getOrElse(signature, () => "missing")}`),
      ),
    { concurrency: "unbounded" },
  );
});

/**
 * Compute the fingerprint of one provider instance's probe inputs. Callers should memoize the
 * settings part implicitly by holding one input per instance; the binary part is re-read on every
 * call so a CLI upgrade is noticed without rebuilding the instance.
 */
export const computeProviderProbeFingerprint = Effect.fn("computeProviderProbeFingerprint")(
  function* (input: ProviderProbeFingerprintInput) {
    const binaries = yield* Effect.forEach(input.binaryPaths, (binaryPath) =>
      describeBinary(binaryPath, input.env),
    );
    const authFiles = yield* describeAuthFiles(input.authFiles ?? []);
    const dynamicInputs = input.dynamicInputs ? yield* input.dynamicInputs : null;
    return createHash("sha256")
      .update(
        stableJson({
          format: PROBE_FINGERPRINT_FORMAT,
          server: packageJson.version,
          driver: input.driverKind,
          binaries,
          authFiles,
          settings: input.settings,
          dynamicInputs,
        }),
      )
      .digest("hex");
  },
);

/**
 * Bind a fingerprint computation to the driver's file system so it fits
 * `ServerProviderShape.probeFingerprint` (`R = never`).
 */
export const makeProviderProbeFingerprint = Effect.fn("makeProviderProbeFingerprint")(function* (
  input: ProviderProbeFingerprintInput,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  return computeProviderProbeFingerprint(input).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
  );
});

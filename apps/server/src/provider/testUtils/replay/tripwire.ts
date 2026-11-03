// Adapted from pingdotgg/t3code packages/provider-testing/src/fakeCli.ts
// (91992bd5d464d6a01b2a5c1e7926e68ad09ea40e). Copyright (c) 2026 T3 Tools Inc. MIT; see
// THIRD_PARTY_NOTICES.md.
/**
 * Tripwire provider binaries for replay tests. Replay configures this path as the provider
 * binary, so a launch that bypasses the replay spawner (a capability probe, an SDK spawning the
 * CLI itself) runs the tripwire instead of a real CLI against a real home, leaves a marker and
 * fails. POSIX only: replay suites skip Windows.
 *
 * @module provider/testUtils/replay/tripwire
 */
import { Effect, FileSystem, Path, Schema } from "effect";

const TRIPWIRE_SUFFIX = ".tripwire";
/** The tripwire's exit status, distinct from the statuses real CLIs use. */
export const TRIPWIRE_EXIT_CODE = 97;

export class ReplayTripwireTouchedError extends Schema.TaggedError<ReplayTripwireTouchedError>()(
  "ReplayTripwireTouchedError",
  {
    directory: Schema.String,
    /** One line per run: the argv the tripwire was started with. */
    invocations: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `A replay tripwire binary in ${this.directory} was run: ${this.invocations.join("; ")}`;
  }
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * Writes `<dir>/<name>`: a script that appends its argv to `<dir>/<name>.tripwire` and exits
 * with {@link TRIPWIRE_EXIT_CODE}. Returns its path.
 */
export const writeTripwireBinary = Effect.fn("writeTripwireBinary")(function* (
  directory: string,
  name: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(directory, { recursive: true });
  const binaryPath = path.join(directory, name);
  const markerPath = path.join(directory, `${name}${TRIPWIRE_SUFFIX}`);
  yield* fileSystem.writeFileString(
    binaryPath,
    [
      "#!/bin/sh",
      "# Replay tripwire: a test launched a provider CLI it must only replay.",
      `printf '%s\\n' "$*" >> ${shellQuote(markerPath)}`,
      `exit ${TRIPWIRE_EXIT_CODE}`,
      "",
    ].join("\n"),
  );
  yield* fileSystem.chmod(binaryPath, 0o755);
  return binaryPath;
});

/** Fails when any tripwire in `directory` was run. */
export const assertTripwireUntouched = Effect.fn("assertTripwireUntouched")(function* (
  directory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const markers = (yield* fileSystem.readDirectory(directory)).filter((file) =>
    file.endsWith(TRIPWIRE_SUFFIX),
  );
  if (markers.length === 0) return;
  const invocations: Array<string> = [];
  for (const marker of markers.toSorted()) {
    const text = yield* fileSystem.readFileString(path.join(directory, marker));
    const name = marker.slice(0, -TRIPWIRE_SUFFIX.length);
    for (const line of text.split("\n").filter((entry) => entry.length > 0)) {
      invocations.push(`${name} ${line}`);
    }
  }
  return yield* new ReplayTripwireTouchedError({ directory, invocations });
});

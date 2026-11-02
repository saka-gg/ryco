/**
 * nodeAutoSkip - the Ryco releases this node no longer installs on its own.
 *
 * Loaded with unattended updates (`unattendedUpdates.ts`), never on boot. The node's unattended
 * self-update (`nodeAutoUpdater.ts`) adds a release before it starts installing it and takes it
 * off again only when nothing was changed: the update was refused, or postponed with the previous
 * release back in place. So a release whose unattended run failed, was rolled back after the
 * restart, or was cut off by a crash at any point stays here, and is never tried unattended again.
 * A manual update still installs it.
 *
 * One JSON file in the update directory (`<stateDir>/node-update/auto-skip.json`, which every
 * update keeps), written through a temp file and a rename. A missing file skips nothing; a file
 * that cannot be read skips everything until it can (fail closed), which the updater tells the
 * owner; one that does not decode is logged and starts over, so a damaged file cannot stop
 * unattended updates for good.
 *
 * @module nodeAutoSkip
 */
import { Data, Effect, FileSystem, Option, Path, Schema } from "effect";

import { writeFileStringAtomically } from "../atomicWrite.ts";

/** The newest releases kept; older ones are long behind the node's own version. */
export const NODE_AUTO_SKIP_MAX_VERSIONS = 32;

const AutoSkipFile = Schema.fromJsonString(
  Schema.Struct({ versions: Schema.Array(Schema.String) }),
);
const decodeAutoSkipFile = Schema.decodeUnknownEffect(AutoSkipFile);
const encodeAutoSkipFile = Schema.encodeEffect(AutoSkipFile);

/** The skip list could not record a release, so nothing may be installed unattended. */
export class NodeAutoSkipError extends Data.TaggedError("NodeAutoSkipError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * What the list says about a release: `skipped` and `unreadable` both keep unattended updates
 * away from it; `unreadable` keeps them away from every release.
 */
export type NodeAutoSkipStatus = "allowed" | "skipped" | "unreadable";

export interface NodeAutoSkipList {
  readonly status: (version: string) => Effect.Effect<NodeAutoSkipStatus>;
  /** Records `version`; fails when it cannot, and then nothing may be installed unattended. */
  readonly add: (version: string) => Effect.Effect<void, NodeAutoSkipError>;
  /** Takes `version` off again; best effort. */
  readonly remove: (version: string) => Effect.Effect<void>;
}

export function makeNodeAutoSkipList(input: {
  readonly filePath: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}): NodeAutoSkipList {
  const { filePath, fileSystem } = input;
  const io = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, input.path),
    );

  /** The recorded versions, `None` when the file exists but cannot be read. */
  const read = Effect.gen(function* () {
    if (!(yield* fileSystem.exists(filePath))) return Option.some<ReadonlyArray<string>>([]);
    const raw = yield* fileSystem.readFileString(filePath);
    const decoded = yield* decodeAutoSkipFile(raw).pipe(Effect.option);
    if (Option.isNone(decoded)) {
      yield* Effect.logWarning("The list of skipped automatic updates is damaged; starting over", {
        filePath,
      });
      return Option.some<ReadonlyArray<string>>([]);
    }
    return Option.some(decoded.value.versions);
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("The list of skipped automatic updates could not be read", {
        filePath,
        cause,
      }).pipe(Effect.as(Option.none<ReadonlyArray<string>>())),
    ),
  );

  const write = (versions: ReadonlyArray<string>) =>
    encodeAutoSkipFile({ versions: versions.slice(-NODE_AUTO_SKIP_MAX_VERSIONS) }).pipe(
      Effect.flatMap((contents) =>
        io(writeFileStringAtomically({ filePath, contents: `${contents}\n` })),
      ),
    );

  return {
    status: (version) =>
      Effect.map(read, (versions) =>
        Option.match(versions, {
          onNone: (): NodeAutoSkipStatus => "unreadable",
          onSome: (list) => (list.includes(version) ? "skipped" : "allowed"),
        }),
      ),
    add: (version) =>
      Effect.gen(function* () {
        const versions = yield* read;
        if (Option.isNone(versions)) {
          return yield* new NodeAutoSkipError({ message: "The skip list cannot be read." });
        }
        if (versions.value.includes(version)) return;
        yield* write([...versions.value, version]).pipe(
          Effect.mapError(
            (cause) =>
              new NodeAutoSkipError({ message: "The skip list cannot be written.", cause }),
          ),
        );
      }),
    remove: (version) =>
      Effect.gen(function* () {
        const versions = yield* read;
        if (Option.isNone(versions) || !versions.value.includes(version)) return;
        yield* write(versions.value.filter((entry) => entry !== version));
      }).pipe(Effect.ignoreCause({ log: true })),
  };
}

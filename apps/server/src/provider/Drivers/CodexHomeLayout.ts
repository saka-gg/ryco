import {
  ProviderDriverKind,
  type CodexSettings,
  type ProviderInstanceEnvironment,
} from "@ryco/contracts";
import { Effect, FileSystem, Path, Schema } from "effect";
import * as PlatformError from "effect/PlatformError";

import {
  mergeProviderInstanceEnvironment,
  normalizeProviderHomeEnvironment,
} from "../ProviderInstanceEnvironment.ts";
import { parseProviderSourcePaths } from "../ProviderSourcePaths.ts";

export interface CodexHomeLayout {
  readonly mode: "direct" | "authOverlay";
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string | undefined;
  readonly continuationKey: string;
}

const KNOWN_SHARED_DIRECTORIES = [
  "sessions",
  "archived_sessions",
  "sqlite",
  "shell_snapshots",
  "worktrees",
  "skills",
  "plugins",
  "cache",
  "logs",
] as const;

const PRIVATE_ENTRY_NAMES = new Set(["auth.json", "models_cache.json"]);
const SHADOW_LOCAL_ENTRY_NAMES = new Set(["log", "memories", "tmp"]);

// SQLite databases and their WAL/SHM/journal sidecars are never linked into a shadow home:
// SQLite derives sidecar paths from the path it opened a database through, and on Windows
// deleting a sidecar through a link removes only the link, so per-file links let two processes
// write two WALs for one database ("database disk image is malformed"). An auth overlay points
// `CODEX_SQLITE_HOME` at the shared home instead (`codexProcessEnvironment`).
const SQLITE_STATE_ENTRY_PATTERN = /^.+\.sqlite(?:-(?:wal|shm|journal))?$/;

function isSqliteStateEntry(entryName: string): boolean {
  return SQLITE_STATE_ENTRY_PATTERN.test(entryName);
}

export const resolveCodexHomeLayout = Effect.fn("resolveCodexHomeLayout")(function* (
  config: CodexSettings,
  env: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<CodexHomeLayout, never, Path.Path> {
  yield* Path.Path;
  const parsed = parseProviderSourcePaths("codex", config, env);
  const sharedHomePath = parsed.root;
  const shadowHomePath = config.shadowHomePath.trim();
  if (shadowHomePath.length === 0) {
    return {
      mode: "direct",
      sharedHomePath,
      // Leave Codex's default-home bootstrap intact when CODEX_HOME was not
      // explicitly selected; forcing a missing default path breaks first run.
      effectiveHomePath:
        config.homePath.trim() || env.CODEX_HOME?.trim() ? sharedHomePath : undefined,
      continuationKey: `codex:home:${sharedHomePath}`,
    };
  }

  const effectiveHomePath = parsed.shadow!;
  return {
    mode: "authOverlay",
    sharedHomePath,
    effectiveHomePath,
    continuationKey: `codex:home:${sharedHomePath}`,
  };
});

/**
 * The environment and home layout of a Codex provider instance: the instance's variables over the
 * server's, HOME normalized, and the layout resolved from that environment rather than the
 * server's. The driver, MCP settings, reset credits and history sources all resolve an instance
 * through this, so they agree on its homes.
 */
export const resolveCodexInstanceLayout = Effect.fn("resolveCodexInstanceLayout")(function* (
  config: CodexSettings,
  instanceEnvironment: ProviderInstanceEnvironment | undefined,
): Effect.fn.Return<
  { readonly environment: NodeJS.ProcessEnv; readonly layout: CodexHomeLayout },
  never,
  Path.Path
> {
  const environment = normalizeProviderHomeEnvironment(
    mergeProviderInstanceEnvironment(instanceEnvironment),
  );
  const layout = yield* resolveCodexHomeLayout(config, environment);
  return { environment, layout };
});

/**
 * The environment every Codex process of a layout runs with: `CODEX_HOME` is the effective home,
 * and an auth overlay keeps SQLite state in the shared home through `CODEX_SQLITE_HOME`, so all
 * processes open the same databases through one path. A `CODEX_SQLITE_HOME` already in the
 * environment is kept.
 */
export function codexProcessEnvironment(
  layout: CodexHomeLayout,
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    ...(layout.effectiveHomePath ? { CODEX_HOME: layout.effectiveHomePath } : {}),
    ...(layout.mode === "authOverlay" && !baseEnv.CODEX_SQLITE_HOME?.trim()
      ? { CODEX_SQLITE_HOME: layout.sharedHomePath }
      : {}),
  };
}

export class CodexShadowHomeError extends Schema.TaggedError<CodexShadowHomeError>()(
  "CodexShadowHomeError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

type LinkState =
  | {
      readonly _tag: "Missing";
    }
  | {
      readonly _tag: "NotSymlink";
    }
  | {
      readonly _tag: "Symlink";
      readonly target: string;
    };

function toShadowHomeError(cause: unknown): CodexShadowHomeError {
  return Schema.is(CodexShadowHomeError)(cause)
    ? cause
    : new CodexShadowHomeError({
        detail: "Failed to materialize Codex shadow home.",
        cause,
      });
}

function normalizeShadowHomeError<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, CodexShadowHomeError, R> {
  return effect.pipe(Effect.mapError(toShadowHomeError));
}

function isNotSymlinkError(error: PlatformError.PlatformError): boolean {
  const cause = error.reason.cause;
  return (
    error.reason._tag === "Unknown" &&
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "EINVAL"
  );
}

const readLinkState = Effect.fn("CodexHomeLayout.readLinkState")(function* (
  fileSystem: FileSystem.FileSystem,
  linkPath: string,
): Effect.fn.Return<LinkState, CodexShadowHomeError> {
  return yield* fileSystem.readLink(linkPath).pipe(
    Effect.map((target): LinkState => ({ _tag: "Symlink", target })),
    Effect.catch((error) => {
      if (error.reason._tag === "NotFound") {
        return Effect.succeed<LinkState>({ _tag: "Missing" });
      }
      if (isNotSymlinkError(error)) {
        return Effect.succeed<LinkState>({ _tag: "NotSymlink" });
      }
      return Effect.fail(toShadowHomeError(error));
    }),
  );
});

/** Removes a shadow-home entry only when it is a link; a real file or directory is kept. */
const removeShadowSymlink = Effect.fn("CodexHomeLayout.removeShadowSymlink")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly shadowPath: string;
  readonly entryName: string;
}): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  const entryPath = path.join(input.shadowPath, input.entryName);
  const state = yield* readLinkState(input.fileSystem, entryPath);
  if (state._tag === "Symlink") {
    yield* normalizeShadowHomeError(input.fileSystem.remove(entryPath));
  }
});

const ensureSymlink = Effect.fn("CodexHomeLayout.ensureSymlink")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly shadowPath: string;
  readonly sharedPath: string;
  readonly entryName: string;
}): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  const target = path.join(input.sharedPath, input.entryName);
  const link = path.join(input.shadowPath, input.entryName);
  const state = yield* readLinkState(input.fileSystem, link);

  if (state._tag === "NotSymlink") {
    return yield* new CodexShadowHomeError({
      detail: `Cannot create Codex shadow home because '${link}' already exists and is not a symlink.`,
    });
  }

  if (state._tag === "Missing") {
    return yield* normalizeShadowHomeError(input.fileSystem.symlink(target, link));
  }

  const resolvedExisting = path.resolve(path.dirname(link), state.target);
  if (resolvedExisting !== target) {
    yield* normalizeShadowHomeError(input.fileSystem.remove(link));
    yield* normalizeShadowHomeError(input.fileSystem.symlink(target, link));
  }
});

const ensureShadowAuthIsPrivate = Effect.fn("CodexHomeLayout.ensureShadowAuthIsPrivate")(function* (
  fileSystem: FileSystem.FileSystem,
  shadowPath: string,
): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  const authPath = path.join(shadowPath, "auth.json");
  const state = yield* readLinkState(fileSystem, authPath);
  if (state._tag === "Symlink") {
    return yield* new CodexShadowHomeError({
      detail: `Codex shadow auth file '${authPath}' must be a real file, not a symlink.`,
    });
  }
});

export const materializeCodexShadowHome = Effect.fn("materializeCodexShadowHome")(function* (
  layout: CodexHomeLayout,
) {
  if (layout.mode !== "authOverlay") return;
  const effectiveHomePath = layout.effectiveHomePath;
  if (!effectiveHomePath) return;
  if (layout.sharedHomePath === effectiveHomePath) {
    return yield* new CodexShadowHomeError({
      detail: "Codex shadow home path must be different from the shared home path.",
    });
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* normalizeShadowHomeError(
    Effect.all(
      [
        fileSystem.makeDirectory(layout.sharedHomePath, { recursive: true }),
        fileSystem.makeDirectory(effectiveHomePath, { recursive: true }),
        ...KNOWN_SHARED_DIRECTORIES.map((directory) =>
          fileSystem.makeDirectory(path.join(layout.sharedHomePath, directory), {
            recursive: true,
          }),
        ),
      ],
      { concurrency: "unbounded" },
    ),
  );

  const sharedEntryNames = yield* normalizeShadowHomeError(
    fileSystem.readDirectory(layout.sharedHomePath),
  );
  const entries = new Set<string>(KNOWN_SHARED_DIRECTORIES);
  for (const entryName of sharedEntryNames) {
    if (
      !PRIVATE_ENTRY_NAMES.has(entryName) &&
      !SHADOW_LOCAL_ENTRY_NAMES.has(entryName) &&
      !isSqliteStateEntry(entryName)
    ) {
      entries.add(entryName);
    }
  }

  yield* Effect.forEach(
    PRIVATE_ENTRY_NAMES,
    (entryName) =>
      entryName === "auth.json"
        ? Effect.void
        : removeShadowSymlink({
            fileSystem,
            shadowPath: effectiveHomePath,
            entryName,
          }),
    { discard: true },
  );

  // Earlier releases linked SQLite state into the shadow home.
  const shadowEntryNames = yield* normalizeShadowHomeError(
    fileSystem.readDirectory(effectiveHomePath),
  );
  yield* Effect.forEach(
    shadowEntryNames.filter(isSqliteStateEntry),
    (entryName) =>
      removeShadowSymlink({
        fileSystem,
        shadowPath: effectiveHomePath,
        entryName,
      }),
    { discard: true },
  );

  yield* Effect.forEach(
    entries,
    (entryName) => {
      if (PRIVATE_ENTRY_NAMES.has(entryName)) {
        return Effect.void;
      }
      return ensureSymlink({
        fileSystem,
        shadowPath: effectiveHomePath,
        sharedPath: layout.sharedHomePath,
        entryName,
      });
    },
    { discard: true },
  );

  yield* ensureShadowAuthIsPrivate(fileSystem, effectiveHomePath);
});

export function codexContinuationIdentity(layout: CodexHomeLayout) {
  return {
    driverKind: ProviderDriverKind.make("codex"),
    continuationKey: layout.continuationKey,
  };
}

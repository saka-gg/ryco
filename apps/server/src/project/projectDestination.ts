/**
 * ProjectDestination - the checks every verdict on "may a project folder go here?" shares.
 *
 * Chat promotion (`judgePromotionDestination`) and project copy
 * (`NodePaths.judgeProjectDestination`, behind `projects.previewDestination` and the import's
 * preflight) both build on {@link locateDestination}: the same path hygiene, the same access
 * policy checks on the path and its canonical form, and the same storage-admission fence, so a
 * folder is never accepted by one and refused by the other, and never registered where turns
 * would be refused.
 *
 * @module ProjectDestination
 */
import { constants as fsConstants } from "node:fs";
import { access, lstat, stat } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";

import { containsPath } from "../workspace/checkoutInspection.ts";
import type { WorkspaceAccessPolicyShape } from "../workspace/Services/WorkspaceAccessPolicy.ts";
import type { ChatFoldersShape } from "./chatFolders.ts";
import { canonicalizeWorktreePath } from "./worktreeRoot.ts";

/** `-2` … `-100`; past that no free name is suggested. */
const FREE_DESTINATION_MAX_SUFFIX = 100;

/** Drive (`C:\`, `C:/`) or UNC (`\\server\share`) roots: the only absolute Windows forms. */
const WINDOWS_ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/;

// Filesystem input must not contain control characters.
// oxlint-disable-next-line no-control-regex -- control characters are what it refuses
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;

/** Volumes Ryco treats as case-insensitive, as storage admission and the relocation locks do. */
export const foldsPathCase = (platform: NodeJS.Platform = process.platform) =>
  platform === "darwin" || platform === "win32";

/** A path as compared for identity: lowercased on case-insensitive volumes. */
export const foldPathCase = (target: string, platform: NodeJS.Platform = process.platform) =>
  foldsPathCase(platform) ? target.toLowerCase() : target;

const pathFor = (platform: NodeJS.Platform) => (platform === "win32" ? path.win32 : path.posix);

/**
 * A path as the user typed it, made absolute without guessing. Only `~` and `~/` (and `~\` on
 * Windows) expand to `homeDir`. Anything that is not then absolute for `platform` (`~user`,
 * `C:foo` or `\foo` on Windows, another platform's form, a relative path) is refused, never
 * resolved against the server's working directory. Null when refused; otherwise normalized,
 * without a trailing separator.
 */
export const parseDestinationPath = (
  raw: string,
  options: { readonly homeDir: string; readonly platform?: NodeJS.Platform | undefined },
): string | null => {
  const platform = options.platform ?? process.platform;
  const paths = pathFor(platform);
  const trimmed = raw.trim();
  if (!trimmed || CONTROL_CHARACTERS.test(trimmed)) return null;
  const expanded =
    trimmed === "~"
      ? options.homeDir
      : trimmed.startsWith("~/") || (platform === "win32" && trimmed.startsWith("~\\"))
        ? paths.join(options.homeDir, trimmed.slice(2))
        : trimmed;
  const absolute =
    platform === "win32" ? WINDOWS_ABSOLUTE_PATH.test(expanded) : expanded.startsWith("/");
  return absolute ? paths.resolve(expanded) : null;
};

/** Whether anything (a broken symlink included) is at `target`. Fails on other errors. */
export const pathExists = async (target: string): Promise<boolean> => {
  try {
    await lstat(target);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
};

/** Whether `target` is a directory, following symlinks; false on any error. */
export const isDirectoryPath = (target: string): Promise<boolean> =>
  stat(target).then(
    (entry) => entry.isDirectory(),
    () => false,
  );

/** Whether `<directory>/.git` exists (a directory, or a file for worktrees and submodules). */
export const hasGitEntry = (directory: string): Promise<boolean> =>
  lstat(path.join(directory, ".git")).then(
    (entry) => entry.isDirectory() || entry.isFile(),
    () => false,
  );

/** A directory this process may create entries in. */
export const isWritableDirectory = async (target: string): Promise<boolean> =>
  (await isDirectoryPath(target)) &&
  access(target, fsConstants.W_OK | fsConstants.X_OK).then(
    () => true,
    () => false,
  );

/**
 * `base` when nothing is there, else the first free `<base>-2`, `<base>-3`, … up to `-100`.
 * With `skipBase` the search starts at `-2`. Null when every name is taken, and at the first name
 * that cannot be checked (an unreadable parent, such as a folder macOS guards): probing on would
 * only repeat the refusal.
 */
export const firstFreeDestination = async (
  base: string,
  options: { readonly skipBase?: boolean } = {},
): Promise<string | null> => {
  const candidates = [
    ...(options.skipBase ? [] : [base]),
    ...Array.from(
      { length: FREE_DESTINATION_MAX_SUFFIX - 1 },
      (_, index) => `${base}-${index + 2}`,
    ),
  ];
  for (const candidate of candidates) {
    try {
      if (!(await pathExists(candidate))) return candidate;
    } catch {
      // The siblings share one parent: one that cannot be read there hides all of them.
      return null;
    }
  }
  return null;
};

/**
 * The chats root by realpath (as configured when it cannot be resolved), or undefined when the
 * node offers no chats: no destination may lie inside it.
 */
export const canonicalChatsRoot = (chatFolders: Pick<ChatFoldersShape, "capability">) =>
  chatFolders.capability.pipe(
    Effect.flatMap((capability) => {
      const root = capability.root;
      return root === undefined
        ? Effect.succeed(undefined)
        : Effect.promise(() => canonicalizeWorktreePath(root).catch(() => root));
    }),
  );

/**
 * Where a destination lands, before what is at it is judged. `destination` is what was judged,
 * for display: trimmed, with `~` expanded and normalized (the raw input, trimmed, when invalid).
 */
export type DestinationLocation<Reason, Fenced> =
  | { readonly status: "invalid"; readonly destination: string }
  | { readonly status: "access-denied"; readonly destination: string }
  /** Its path cannot be resolved: a broken symlink or an unreadable folder on the way. */
  | {
      readonly status: "unresolvable";
      readonly destination: string;
      readonly leafExists: boolean;
    }
  /** Inside one of the excluded folders (a chat's own folder, the chats root). */
  | {
      readonly status: "excluded";
      readonly destination: string;
      readonly canonical: string;
      readonly reason: Reason;
    }
  /** Storage admission refuses it; see the caller's `fenced`. */
  | {
      readonly status: "fenced";
      readonly destination: string;
      readonly canonical: string;
      readonly verdict: Fenced;
    }
  | {
      readonly status: "located";
      readonly destination: string;
      /** Symlinks in the nearest existing ancestor (or the existing leaf) resolved. */
      readonly canonical: string;
      readonly leafExists: boolean;
    };

/**
 * Locate a destination: parse it ({@link parseDestinationPath}), refuse a filesystem root,
 * check the access policy on the path and again on its canonical form (a symlinked parent can
 * lead out of the allowed root), refuse it inside an excluded folder (checked in order), and ask
 * storage admission through `fenced`, which turns a blocker into the caller's verdict. Storage
 * admission runs before the caller looks at what exists there: another name in the same place
 * would be refused just the same.
 */
export const locateDestination = Effect.fn("locateDestination")(function* <
  Reason,
  Fenced,
  E,
>(input: {
  readonly raw: string;
  readonly homeDir: string;
  readonly policy: WorkspaceAccessPolicyShape;
  /** Names the check in access-policy errors. */
  readonly operation: string;
  readonly excludedRoots: ReadonlyArray<{ readonly root: string; readonly reason: Reason }>;
  /** Storage admission's verdict for a canonical path, or null when it admits the path. */
  readonly fenced: (canonical: string) => Effect.Effect<Fenced | null, E>;
}) {
  const located = (location: DestinationLocation<Reason, Fenced>) => location;
  const destination = parseDestinationPath(input.raw, { homeDir: input.homeDir });
  if (destination === null) return located({ status: "invalid", destination: input.raw.trim() });
  // A filesystem root has no parent to create it in.
  if (path.dirname(destination) === destination) return located({ status: "invalid", destination });
  const allowed = (candidate: string) =>
    input.policy.assertPath({ path: candidate, operation: input.operation }).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    );
  if (!(yield* allowed(destination))) return located({ status: "access-denied", destination });
  const leafExists = yield* Effect.promise(() => pathExists(destination).catch(() => true));
  const canonical = yield* Effect.promise(() =>
    canonicalizeWorktreePath(destination).catch(() => null),
  );
  if (canonical === null) return located({ status: "unresolvable", destination, leafExists });
  if (!(yield* allowed(canonical))) return located({ status: "access-denied", destination });
  for (const excluded of input.excludedRoots) {
    if (containsPath(excluded.root, canonical)) {
      return located({ status: "excluded", destination, canonical, reason: excluded.reason });
    }
  }
  const fenced = yield* input.fenced(canonical);
  if (fenced !== null)
    return located({ status: "fenced", destination, canonical, verdict: fenced });
  return located({ status: "located", destination, canonical, leafExists });
});

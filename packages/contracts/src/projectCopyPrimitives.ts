/**
 * The project copy fields an Agent Control copy plan names: ids, paths, a branch,
 * a remote URL, the destination's state and the setup command.
 *
 * Every proposal the app decodes can carry a copy plan, so these load with the
 * app. The rest of the copy contracts (`./projectCopy.ts`, which re-exports
 * these) and the copy RPCs (`@ryco/contracts/project-copy-rpc`) load with the
 * first copy.
 *
 * @module projectCopyPrimitives
 */
import * as Schema from "effect/Schema";

import { ProjectId, TrimmedNonEmptyString, rejectExcessProperties } from "./baseSchemas.ts";

// ── Limits ────────────────────────────────────────────────────────────

export const PROJECT_COPY_ABSOLUTE_PATH_MAX_CHARS = 4_096;
export const PROJECT_COPY_REMOTE_URL_MAX_CHARS = 2_048;
export const PROJECT_COPY_SETUP_COMMAND_MAX_CHARS = 4_000;

// ── Ids ───────────────────────────────────────────────────────────────

/**
 * Client-minted (version 4), or derived by Agent Control for the import an approved
 * `importProject` runs: `uuidv5(operationId, "project-import")` (version 5), so a retried
 * execution finds the same job. Either way lowercase and safe as a file name.
 */
export const ProjectImportId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, {
    message: "Expected a lowercase version 4 or 5 UUID",
  }),
).pipe(Schema.brand("ProjectImportId"));
export type ProjectImportId = typeof ProjectImportId.Type;

/**
 * The client-minted id of the destination project. It names the project's avatar
 * file, so it is limited to the characters the avatar route accepts.
 */
export const PortableProjectId = ProjectId.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/, {
    message: "Expected 1-128 letters, digits, '_' or '-'",
  }),
);

// ── Input hygiene ─────────────────────────────────────────────────────

/**
 * The shape `git check-ref-format --branch` accepts, minus a leading `-`. The
 * destination still runs `check-ref-format` before using it.
 *
 * Its lookaheads (and those of `ProjectCopyRelativePath`) run with the `s` flag:
 * without it `.` stops at U+2028/U+2029, which the body accepts, and a line
 * separator would hide every later `..`, `/.` or `.lock` from them.
 */
export const GitBranchName = Schema.String.check(
  Schema.isMaxLength(256),
  Schema.isPattern(
    // oxlint-disable-next-line no-control-regex -- control characters are exactly what git rejects
    /^(?!-)(?!\/)(?!.*\/$)(?!.*\/\/)(?!.*\.\.)(?!.*@\{)(?!@$)(?!.*\.$)(?!(?:.*\/)?\.)(?!.*\.lock(?:\/|$))[^\x00-\x20\x7f~^:?*[\\]+$/s,
    { message: "Expected a valid git branch name" },
  ),
);
export type GitBranchName = typeof GitBranchName.Type;

/**
 * A password in a remote URL, unanchored. Either `user:password@` after `scheme:`
 * and any run of slashes or backslashes, or scp-style `user:password@host:path`.
 * The slash count matters: git hands `https:///…` to curl, which skips up to three
 * slashes before the authority and sends its credentials, and WHATWG `URL` (the
 * server's clone check) skips any number of slashes and backslashes. The user info
 * runs to the authority's last `@`; it has a password when its first `:` comes
 * before that `@`. The slash run is always taken whole (`(?![\\/])`), so a long
 * run cannot make the match quadratic.
 */
const REMOTE_URL_PASSWORD_SOURCE = String.raw`(?:[a-z][a-z0-9+.-]*:[\\/]+(?![\\/])[^/?#:]*:[^/?#]*@|[^/\\@:]+:[^/\\@]*@)`;

/**
 * Matches a remote URL that carries a password: what `ProjectCopyRemoteUrl` refuses,
 * and the rule `@ryco/shared/gitRemoteUrl` checks URLs with.
 */
export const REMOTE_URL_PASSWORD_PATTERN = new RegExp(`^${REMOTE_URL_PASSWORD_SOURCE}`, "i");

/**
 * A remote URL a client may hand to a node: bounded, no control characters, no
 * leading `-`, and never a password (`REMOTE_URL_PASSWORD_PATTERN`): neither
 * `scheme://user:password@host` (however many slashes) nor scp-style
 * `user:password@host:path`. Usernames (`git@…`, `ssh://git@…`) stay.
 */
export const ProjectCopyRemoteUrl = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROJECT_COPY_REMOTE_URL_MAX_CHARS),
  // oxlint-disable-next-line no-control-regex -- control characters are what it refuses
  Schema.isPattern(/^(?!-)(?![\s\S]*[\x00-\x1f\x7f])/, {
    message: "Remote URLs must not start with '-' or contain control characters",
  }),
  Schema.isPattern(new RegExp(`^(?!${REMOTE_URL_PASSWORD_SOURCE})`, "i"), {
    message: "Remote URLs must not contain a password",
  }),
);
export type ProjectCopyRemoteUrl = typeof ProjectCopyRemoteUrl.Type;

/** POSIX `/…`, Windows `C:\…` / `C:/…` or UNC `\\…`. */
export const ProjectCopyAbsolutePath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROJECT_COPY_ABSOLUTE_PATH_MAX_CHARS),
  Schema.isPattern(/^(?:\/|[A-Za-z]:[\\/]|\\\\)[^\0]*$/, { message: "Expected an absolute path" }),
);
export type ProjectCopyAbsolutePath = typeof ProjectCopyAbsolutePath.Type;

/** An absolute path, or `~` / `~/…` for the node's home directory (only those expand). */
export const ProjectCopyDestinationPath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROJECT_COPY_ABSOLUTE_PATH_MAX_CHARS),
  Schema.isPattern(/^(?:~(?:[\\/][^\0]*)?|(?:\/|[A-Za-z]:[\\/]|\\\\)[^\0]*)$/, {
    message: "Expected an absolute path or one starting with '~/'",
  }),
);
export type ProjectCopyDestinationPath = typeof ProjectCopyDestinationPath.Type;

/** One folder name, e.g. the leaf an agent asks for under the node's code directory. */
export const ProjectCopyDirectoryName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, {
    message: "Expected a folder name of letters, digits, '.', '_' or '-'",
  }),
);
export type ProjectCopyDirectoryName = typeof ProjectCopyDirectoryName.Type;

// ── Destination and setup ─────────────────────────────────────────────

export const ProjectDestinationState = Schema.Literals([
  "available",
  "exists-empty",
  "exists-not-empty",
  "is-git-repository",
  /** Under a retired checkout or a moved project's old path: turns there are refused. */
  "retired-checkout",
  "access-denied",
  "invalid",
]);
export type ProjectDestinationState = typeof ProjectDestinationState.Type;

export const ProjectSetupCommand = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROJECT_COPY_SETUP_COMMAND_MAX_CHARS),
);

/**
 * The exact command the destination runs in the project root after the import
 * (login shell, stdin closed, 30 min). `saveAsScript` also keeps it as the
 * project's worktree setup script.
 */
export const ProjectImportSetup = Schema.Struct({
  command: ProjectSetupCommand,
  saveAsScript: Schema.Boolean,
}).pipe(rejectExcessProperties);
export type ProjectImportSetup = typeof ProjectImportSetup.Type;

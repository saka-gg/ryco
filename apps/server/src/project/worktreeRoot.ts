import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import path from "node:path";

import type { ServerSettings } from "@ryco/contracts";
import { Effect, Schema } from "effect";

import { resolveManagedWorktreesRoot, type ServerConfigShape } from "../config.ts";
import { expandHomePath } from "../pathExpansion.ts";
import type { WorkspaceAccessPolicyShape } from "../workspace/Services/WorkspaceAccessPolicy.ts";

export class WorktreeRootError extends Schema.TaggedError<WorktreeRootError>()(
  "WorktreeRootError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

/** Resolve missing descendants through the nearest existing directory, including symlink aliases.
 * Do not turn permission errors or dangling symlinks into nonexistent ancestors.
 * No directories are created while validating a preference.
 */
export async function canonicalizeWorktreeDirectory(candidate: string): Promise<string> {
  let ancestor = candidate;
  while (true) {
    try {
      await lstat(ancestor);
      const canonical = await realpath(ancestor);
      if (!(await lstat(canonical)).isDirectory()) {
        throw new Error("Worktree root must be a directory.");
      }
      await access(canonical, constants.W_OK | constants.X_OK);
      return path.join(canonical, path.relative(ancestor, candidate));
    } catch (cause) {
      // A dangling link exists, so realpath's ENOENT must not walk past it.
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      const entry = await lstat(ancestor).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      if (entry !== null) throw new Error("Worktree root contains a dangling symlink.", { cause });
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw cause;
      ancestor = parent;
    }
  }
}

export const validateWorktreeRoot = (value: string, policy: WorkspaceAccessPolicyShape) =>
  Effect.gen(function* () {
    const trimmed = value.trim();
    const expanded = expandHomePath(trimmed);
    // Reject control characters and Windows drive-relative/root-relative forms. A path is
    // interpreted on this node, never on the browser's operating system.
    if (
      !trimmed ||
      // Filesystem inputs must not contain control characters.
      // eslint-disable-next-line no-control-regex
      /[\x00-\x1f\x7f]/.test(trimmed) ||
      !path.isAbsolute(expanded) ||
      (process.platform === "win32" && !/^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(expanded))
    ) {
      return yield* new WorktreeRootError({
        detail: "Worktree root must be an absolute directory on this node or start with ~/.",
      });
    }
    const operation = "worktree root";
    const authorized = yield* policy
      .assertPath({ path: path.normalize(expanded), operation })
      .pipe(Effect.mapError((cause) => new WorktreeRootError({ detail: cause.message })));
    const canonical = yield* Effect.tryPromise({
      try: () => canonicalizeWorktreeDirectory(authorized),
      catch: () =>
        new WorktreeRootError({
          detail:
            "Worktree root must resolve to a writable directory (or have a writable existing parent), without broken symlinks.",
        }),
    });
    return yield* policy
      .assertPath({ path: canonical, operation })
      .pipe(Effect.mapError((cause) => new WorktreeRootError({ detail: cause.message })));
  });

/** Storage selection only: this never grants access to the selected directory's contents. */
export const selectConfiguredWorktreeRoot = (input: {
  readonly settings: Pick<ServerSettings, "worktreeRoot" | "projectWorktreeRoots">;
  readonly projectId?: string | undefined;
  readonly config: Pick<ServerConfigShape, "worktreesDir" | "workspaceAccessRoot">;
}) =>
  (input.projectId && Object.hasOwn(input.settings.projectWorktreeRoots, input.projectId)
    ? input.settings.projectWorktreeRoots[input.projectId]
    : null) ||
  input.settings.worktreeRoot ||
  resolveManagedWorktreesRoot(input.config);

export const resolveConfiguredWorktreeRoot = (
  input: Parameters<typeof selectConfiguredWorktreeRoot>[0] & {
    readonly policy: WorkspaceAccessPolicyShape;
  },
) => validateWorktreeRoot(selectConfiguredWorktreeRoot(input), input.policy);

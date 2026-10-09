import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { GitCommandError, type ProjectId, type WorktreeCheckoutLocation } from "@ryco/contracts";
import { directorySlug } from "@ryco/shared/directorySlug";
import { Effect, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { resolveProjectWorktreesDir } from "./projectMetadataPaths.ts";

export const createWorktreeDirectoryId = (): string => randomBytes(4).toString("hex");

export function worktreeDirectorySlug(value: string, fallback = "new-worktree"): string {
  return directorySlug(value, fallback);
}

export function buildWorktreeCheckoutDirectoryName(
  initialName: string,
  id = createWorktreeDirectoryId(),
): string {
  return `${id}_${worktreeDirectorySlug(initialName)}`;
}

/** Temporary branches are identifiers, not useful checkout names. */
export function initialWorktreeName(
  title: string | null | undefined,
  branch: string,
  fallbackTitle?: string,
): string {
  // Custom (including empty) namespaces use the same eight-hex temporary token.
  // This is a naming hint, never evidence that a branch or path is Ryco-owned.
  const temporaryBranch =
    /(?:^|\/)[a-f0-9]{8}$/i.test(branch) || /^(?:ryco|codex)\/[a-f0-9-]{8,}$/i.test(branch);
  if (
    title?.trim() &&
    !/^(?:new thread|new conversation|new worktree|untitled)$/i.test(title.trim()) &&
    !(temporaryBranch && title.trim() === branch) &&
    !/^(?:ryco|codex)\/[a-f0-9-]{8,}$/i.test(title.trim())
  )
    return title;
  if (fallbackTitle?.trim()) return fallbackTitle;
  return temporaryBranch || /^(?:HEAD|origin\/HEAD)$/i.test(branch) ? "new-worktree" : branch;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.lstat(candidate);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}

/** Persisted once per project; project and branch renames never change disk paths. */
export function resolveManagedProjectDirectory(projectId: string, title: string, root?: string) {
  return Effect.gen(function* () {
    const storage = yield* Effect.serviceOption(SqlClient.SqlClient);
    if (Option.isNone(storage))
      return buildWorktreeCheckoutDirectoryName(worktreeDirectorySlug(title, "project"));
    const sql = storage.value;
    const existing = yield* sql<{
      directory_name: string;
    }>`SELECT directory_name FROM managed_worktree_projects WHERE project_id = ${projectId}`;
    if (existing[0]) return existing[0].directory_name;
    for (let attempt = 0; attempt < 8; attempt++) {
      const name = `${createWorktreeDirectoryId()}_${worktreeDirectorySlug(title, "project")}`;
      if (root && (yield* Effect.tryPromise(() => pathExists(path.join(root, name))))) continue;
      yield* sql`INSERT OR IGNORE INTO managed_worktree_projects (project_id, directory_name) VALUES (${projectId}, ${name})`;
      const rows = yield* sql<{
        directory_name: string;
      }>`SELECT directory_name FROM managed_worktree_projects WHERE project_id = ${projectId}`;
      if (rows[0]) return rows[0].directory_name;
    }
    return yield* Effect.fail(new Error("Could not allocate a unique project directory."));
  });
}

/** Reserve before Git runs, including destinations whose creation is interrupted. */
export function allocateWorktreeCheckoutPath(
  directory: string,
  initialName: string,
  createId: () => string = createWorktreeDirectoryId,
) {
  return Effect.gen(function* () {
    const storage = yield* Effect.serviceOption(SqlClient.SqlClient);
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = path.join(
        directory,
        buildWorktreeCheckoutDirectoryName(initialName, createId()),
      );
      if (yield* Effect.tryPromise(() => pathExists(candidate))) continue;
      if (Option.isSome(storage)) {
        const reserved = yield* storage.value<{
          path: string;
        }>`INSERT OR IGNORE INTO managed_worktree_paths (path, allocated_at) VALUES (${candidate}, ${new Date().toISOString()}) RETURNING path`;
        if (!reserved.length) continue;
      }
      return candidate;
    }
    return yield* Effect.fail(
      new Error("Could not allocate a unique worktree directory after eight attempts."),
    );
  });
}

export function resolveWorktreeCheckoutPath(input: {
  readonly location: WorktreeCheckoutLocation | undefined;
  readonly appWorktreesRoot: string;
  readonly projectId: ProjectId | string;
  readonly projectTitle?: string | undefined;
  readonly initialName?: string | null | undefined;
  readonly fallbackName?: string | undefined;
  readonly workspaceRoot: string;
  readonly projectMetadataDir: string | null | undefined;
  readonly branchName: string;
}) {
  return Effect.gen(function* () {
    const directory =
      input.location === "projectMetadata"
        ? resolveProjectWorktreesDir(input.workspaceRoot, input.projectMetadataDir)
        : path.join(
            input.appWorktreesRoot,
            yield* resolveManagedProjectDirectory(
              input.projectId,
              input.projectTitle ?? path.basename(input.workspaceRoot),
              input.appWorktreesRoot,
            ),
          );
    return yield* allocateWorktreeCheckoutPath(
      directory,
      initialWorktreeName(input.initialName, input.branchName, input.fallbackName),
    );
  }).pipe(
    Effect.mapError(
      (cause) =>
        new GitCommandError({
          operation: "worktree.allocatePath",
          cwd: input.workspaceRoot,
          command: "git worktree add",
          detail: cause.message,
          cause,
        }),
    ),
  );
}

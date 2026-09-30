import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { Effect, Schema } from "effect";
import { WorktreeSubmoduleRepositoryConfig, type ServerSettings } from "@ryco/contracts";
import { selectWorktreeSubmodules } from "@ryco/shared/worktreeSubmodules";
import type { WorkspaceAccessPolicyShape } from "../workspace/Services/WorkspaceAccessPolicy.ts";

/** Fixed checkout-owned file. Never search parents, follow includes, or accept caller paths. */
export const WORKTREE_SUBMODULE_CONFIG_FILE = "ryco.json";
export const WORKTREE_SUBMODULE_CONFIG_MAX_BYTES = 64 * 1024;

export class WorktreeSubmodulesError extends Schema.TaggedError<WorktreeSubmodulesError>()(
  "WorktreeSubmodulesError",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail;
  }
}

/** One server boundary for node -> branch file -> explicit project override.
 * Call only after creating and authorizing a fresh checkout, never on an existing checkout.
 * Missing config inherits. Invalid/unreadable/oversized config fails visibly; no silent reset.
 */
export const resolveWorktreeSubmodules = (input: {
  readonly checkoutPath: string;
  readonly projectId?: string | undefined;
  readonly settings: Pick<ServerSettings, "worktreeSubmodules" | "projectWorktreeSubmodules">;
  readonly policy: WorkspaceAccessPolicyShape;
}) =>
  Effect.gen(function* () {
    const checkoutPath = yield* input.policy
      .assertExistingPath({ path: input.checkoutPath, operation: "resolveWorktreeSubmodules" })
      .pipe(Effect.mapError((cause) => new WorktreeSubmodulesError({ detail: cause.message })));
    const selected = selectWorktreeSubmodules({
      settings: input.settings,
      projectId: input.projectId,
    });
    if (selected.source === "project") return selected;
    const configPath = path.join(checkoutPath, WORKTREE_SUBMODULE_CONFIG_FILE);
    const repositoryMode = yield* Effect.tryPromise({
      try: async () => {
        const entry = await lstat(configPath).catch((cause: NodeJS.ErrnoException) => {
          if (cause.code === "ENOENT") return null;
          throw cause;
        });
        if (!entry) return undefined;
        if (!entry.isFile() || entry.isSymbolicLink())
          throw new Error("ryco.json must be a regular file, not a symlink.");
        return entry;
      },
      catch: (cause) =>
        new WorktreeSubmodulesError({
          detail: `Cannot inspect ryco.json: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    }).pipe(
      Effect.flatMap((entry) =>
        entry === undefined
          ? Effect.succeed(undefined)
          : Effect.gen(function* () {
              const authorizedPath = yield* input.policy
                .assertExistingPath({ path: configPath, operation: "resolveWorktreeSubmodules" })
                .pipe(
                  Effect.mapError(
                    (cause) => new WorktreeSubmodulesError({ detail: cause.message }),
                  ),
                );
              if (path.resolve(authorizedPath) !== path.resolve(configPath))
                return yield* new WorktreeSubmodulesError({
                  detail: "ryco.json must not resolve through a symlink.",
                });
              return yield* Effect.tryPromise({
                try: async () => {
                  const file = await open(
                    configPath,
                    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
                  );
                  try {
                    const stat = await file.stat();
                    if (!stat.isFile()) throw new Error("ryco.json must be a regular file.");
                    // O_NOFOLLOW is platform dependent. Verify descriptor identity as
                    // well so a replacement/symlink race cannot redirect the read.
                    if (stat.dev !== entry.dev || stat.ino !== entry.ino)
                      throw new Error(
                        "ryco.json changed while opening it. Retry worktree creation.",
                      );
                    if (stat.size > WORKTREE_SUBMODULE_CONFIG_MAX_BYTES)
                      throw new Error("ryco.json exceeds the 64 KiB limit.");
                    const buffer = Buffer.alloc(WORKTREE_SUBMODULE_CONFIG_MAX_BYTES + 1);
                    let size = 0;
                    while (size < buffer.length) {
                      const read = await file.read(buffer, size, buffer.length - size, null);
                      if (read.bytesRead === 0) break;
                      size += read.bytesRead;
                    }
                    if (size > WORKTREE_SUBMODULE_CONFIG_MAX_BYTES)
                      throw new Error("ryco.json exceeds the 64 KiB limit.");
                    return Schema.decodeUnknownSync(WorktreeSubmoduleRepositoryConfig)(
                      JSON.parse(buffer.subarray(0, size).toString("utf8")),
                    ).worktreeSubmodules;
                  } finally {
                    await file.close();
                  }
                },
                catch: (cause) =>
                  new WorktreeSubmodulesError({
                    detail: `Cannot read worktree submodule configuration from ryco.json. Fix the file or remove worktreeSubmodules: ${cause instanceof Error ? cause.message : String(cause)}`,
                  }),
              });
            }),
      ),
    );
    return selectWorktreeSubmodules({
      settings: input.settings,
      projectId: input.projectId,
      repositoryMode,
    });
  });

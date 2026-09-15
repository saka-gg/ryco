import path from "node:path";
import { Effect } from "effect";
import { GitCommandError } from "@ryco/contracts";
import { WorkspaceAccessPolicy } from "../workspace/Services/WorkspaceAccessPolicy.ts";
import type { GitVcsDriverShape } from "./GitVcsDriver.ts";

/** Reuse the process-wide path policy before even repository-kind discovery. */
export const authorizeGitReadCwd = Effect.fn("authorizeGitReadCwd")(function* (
  requestedCwd: string,
  operation: string,
) {
  const policy = yield* WorkspaceAccessPolicy;
  return yield* policy.assertExistingPath({ path: requestedCwd, operation }).pipe(
    Effect.mapError(
      (error) =>
        new GitCommandError({
          operation,
          cwd: requestedCwd,
          command: "git read",
          detail: error.message,
        }),
    ),
  );
});

/** Existing workspace policy applied before discovery and again to Git's actual worktree root. */
export const authorizeGitReadWorkspace = Effect.fn("authorizeGitReadWorkspace")(function* (
  execute: GitVcsDriverShape["execute"],
  requestedCwd: string,
  operation: string,
) {
  const cwd = yield* authorizeGitReadCwd(requestedCwd, operation);
  const result = yield* execute({
    operation,
    cwd,
    args: ["rev-parse", "--show-toplevel"],
    env: { GIT_OPTIONAL_LOCKS: "0" },
    timeoutMs: 10_000,
    maxOutputBytes: 8192,
  });
  // Remove the output terminator only; spaces are legal parts of directory names.
  const root = result.stdout.replace(/\r?\n$/, "");
  if (!path.isAbsolute(root))
    return yield* new GitCommandError({
      operation,
      cwd,
      command: "git read",
      detail: "Git did not return an absolute worktree root.",
    });
  return yield* authorizeGitReadCwd(root, operation);
});

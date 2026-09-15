import { authorizeGitReadWorkspace } from "./GitReadWorkspace.ts";
import type { WorkspaceAccessPolicy } from "../workspace/Services/WorkspaceAccessPolicy.ts";
import { createHash } from "node:crypto";
import { Effect, Option, Schema } from "effect";
import {
  GitCommandError,
  GitReadComparisonInput,
  type GitReadComparisonResult,
} from "@ryco/contracts";
import type { GitVcsDriverShape } from "./GitVcsDriver.ts";

/** Read-only, bounded comparison of two immutable commits. Never runs external diff/textconv. */
export const readGitComparison = Effect.fn("readGitComparison")(function* (
  execute: GitVcsDriverShape["execute"],
  input: GitReadComparisonInput,
): Effect.fn.Return<GitReadComparisonResult, GitCommandError, WorkspaceAccessPolicy> {
  const fail = (detail: string) =>
    new GitCommandError({
      operation: "readComparison",
      command: "git comparison",
      cwd: input.cwd,
      detail,
    });
  if (Option.isNone(Schema.decodeUnknownOption(GitReadComparisonInput)(input))) {
    return yield* fail(
      "Enter a branch, tag, or commit ID; revision expressions and options are not supported.",
    );
  }
  const worktreePath = yield* authorizeGitReadWorkspace(execute, input.cwd, "readComparison");
  const run = (args: readonly string[], maxOutputBytes = 4096) =>
    execute({
      operation: "readComparison",
      cwd: worktreePath,
      args,
      env: { GIT_OPTIONAL_LOCKS: "0" },
      timeoutMs: 15_000,
      maxOutputBytes,
    });
  const resolve = (ref: string) =>
    run(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).pipe(
      Effect.flatMap((result) =>
        result.stderr.trim() || !/^[0-9a-f]{40,64}$/.test(result.stdout.trim())
          ? Effect.fail(fail(`Reference '${ref}' is ambiguous or does not resolve to a commit.`))
          : Effect.succeed(result.stdout.trim()),
      ),
    );
  const refOid = yield* resolve(input.selection.ref);
  const headOid = yield* resolve("HEAD");
  const repositoryPath = (yield* run([
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ])).stdout.trim();
  let baseOid = refOid;
  if (input.selection.mode === "mergeBase") {
    const bases = (yield* run(["merge-base", "--all", refOid, headOid]).pipe(
      Effect.mapError(() =>
        fail("No merge-base is available. Use Commit to HEAD for unrelated histories."),
      ),
    )).stdout
      .trim()
      .split("\n");
    if (bases.length !== 1 || !/^[0-9a-f]{40,64}$/.test(bases[0] ?? "")) {
      return yield* fail(
        "No unique merge-base is available. Use Commit to HEAD for a direct comparison.",
      );
    }
    baseOid = bases[0]!;
  }
  const patch = (yield* run(
    [
      "diff",
      "--patch",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--unified=3",
      "--submodule=short",
      ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
      baseOid,
      headOid,
      "--",
    ],
    2_000_000,
  )).stdout;
  // Do not label an old snapshot with a ref/HEAD that moved during this read.
  if ((yield* resolve(input.selection.ref)) !== refOid || (yield* resolve("HEAD")) !== headOid) {
    return yield* fail(
      "The reference or HEAD changed during comparison. Refresh to read the current commits.",
    );
  }
  const revision = createHash("sha256")
    .update(
      JSON.stringify([
        "git-comparison-v1",
        repositoryPath,
        worktreePath,
        input.selection.mode,
        refOid,
        baseOid,
        headOid,
        input.ignoreWhitespace,
        patch,
      ]),
    )
    .digest("hex");
  return {
    selection: input.selection,
    source: { repositoryPath, worktreePath, refOid, headOid, baseOid, revision },
    patch,
  };
});

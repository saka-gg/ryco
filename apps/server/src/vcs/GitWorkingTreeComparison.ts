import { Effect } from "effect";
import { GitCommandError } from "@ryco/contracts";
import { NO_FSMONITOR_CONFIG_ARGS, SCRATCH_INDEX_CONFIG_ARGS } from "./GitDurableWrites.ts";
import { makeAuthorizedIndexReader } from "./GitIndexReview.ts";
import { INTERNAL_PATCH_DIFF_ARGS, type GitVcsDriverShape } from "./GitVcsDriver.ts";

const PATCH_LIMIT = 2_000_000;
/** Like the Unstaged changes review: files neither the base nor the index has. */
const UNTRACKED_LIMIT = 200;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface WorkingTreeComparisonPatch {
  readonly patch: string;
  /** HEAD, branch and index bytes, unchanged from the start to the end of the read. */
  readonly identity: string;
}

/**
 * Index entries the scratch index must carry on top of the base tree: every
 * path the real index adds (a force-added ignored file, a file committed since
 * the base) and every changed submodule pointer. Read from `diff --cached --raw -z`.
 */
export function parseIndexSeeds(
  raw: string,
): ReadonlyArray<{ readonly mode: string; readonly oid: string; readonly path: string }> {
  const fields = raw.split("\0");
  const seeds: Array<{ mode: string; oid: string; path: string }> = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [, newMode, , newOid, status] = fields[index]!.split(" ");
    const filePath = fields[index + 1]!;
    if (!newMode || !newOid || !status || filePath.length === 0 || !OBJECT_ID.test(newOid))
      continue;
    // Gitlinks are seeded even when changed, so an uninitialized submodule shows the
    // index's commit rather than the base's.
    if (status === "A" || (newMode === "160000" && (status === "M" || status === "T")))
      seeds.push({ mode: newMode, oid: newOid, path: filePath });
  }
  return seeds;
}

/**
 * The patch from `baseOid` to the working files, including staged, unstaged and
 * untracked changes. Git diffs a scratch index built from the base tree (`read-tree -m`
 * over a copy of the real index keeps its stat data), so a path the index dropped and
 * the working tree recreated reads as one modification, and force-added or newly
 * committed files appear as additions. Untracked files enter that scratch index as
 * intent-to-add entries. The user's index, HEAD and working files are never written.
 * `root` must come from `authorizeGitReadWorkspace`.
 */
export const readWorkingTreeComparisonPatch = Effect.fn("readWorkingTreeComparisonPatch")(
  function* (
    execute: GitVcsDriverShape["execute"],
    input: { readonly root: string; readonly baseOid: string; readonly ignoreWhitespace: boolean },
  ): Effect.fn.Return<WorkingTreeComparisonPatch, GitCommandError> {
    const fail = (detail: string) =>
      new GitCommandError({
        operation: "readComparison",
        command: "git comparison",
        cwd: input.root,
        detail,
      });
    const reader = yield* makeAuthorizedIndexReader(execute, input.root, "readComparison");
    const scratch =
      (env: Record<string, string>) =>
      (
        args: readonly string[],
        options: {
          stdin?: string;
          allowNonZeroExit?: boolean;
          extraEnv?: Record<string, string>;
        } = {},
      ) =>
        reader.run([...SCRATCH_INDEX_CONFIG_ARGS, ...NO_FSMONITOR_CONFIG_ARGS, ...args], {
          env: { ...env, ...options.extraEnv },
          ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
          ...(options.allowNonZeroExit ? { allowNonZeroExit: true } : {}),
        });
    // A scratch index holding the base tree plus the seeds; scoped to the caller.
    const prepare = Effect.gen(function* () {
      const env = yield* reader.copyIndex;
      const run = scratch(env);
      const seeds = parseIndexSeeds(
        (yield* run([
          "diff",
          "--cached",
          "--raw",
          "-z",
          "--no-abbrev",
          "--no-renames",
          "--no-relative",
          "--ignore-submodules=none",
          input.baseOid,
          "--",
        ])).stdout,
      );
      // Unmerged entries refuse `-m`; a plain read hashes every working file instead.
      if ((yield* run(["read-tree", "-m", input.baseOid], { allowNonZeroExit: true })).exitCode)
        yield* run(["read-tree", input.baseOid]);
      if (seeds.length > 0)
        yield* run(["update-index", "-z", "--index-info"], {
          stdin: seeds.map((seed) => `${seed.mode} ${seed.oid}\t${seed.path}\0`).join(""),
        });
      return run;
    });
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const before = JSON.stringify(yield* reader.identity());
        let run = yield* prepare;
        const untracked = (yield* run([
          "ls-files",
          "--others",
          "--exclude-standard",
          "--full-name",
          "-z",
        ])).stdout
          .split("\0")
          // A trailing slash marks an embedded repository, which has no file patch.
          .filter((name) => name.length > 0 && !name.endsWith("/"));
        if (untracked.length > UNTRACKED_LIMIT)
          return yield* fail(
            "Too many untracked files to compare. Narrow the working changes first.",
          );
        // One working-tree diff then reports them as new files, instead of one
        // `diff --no-index` process per file. Records only the empty blob.
        let intentToAdd = true;
        if (untracked.length > 0) {
          intentToAdd =
            (yield* run(
              ["add", "--intent-to-add", "--pathspec-from-file=-", "--pathspec-file-nul"],
              {
                extraEnv: { GIT_LITERAL_PATHSPECS: "1" },
                stdin: untracked.map((name) => `${name}\0`).join(""),
                allowNonZeroExit: true,
              },
            )).exitCode === 0;
          // A refused batch can still have recorded some paths: start over without them.
          if (!intentToAdd) run = yield* prepare;
        }
        const diffArgs = [
          ...INTERNAL_PATCH_DIFF_ARGS,
          "--no-renames",
          ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
        ];
        const tracked = yield* run([...diffArgs, input.baseOid, "--"]);
        if (tracked.stdoutTruncated)
          return yield* fail("The comparison exceeds the 2 MB patch limit.");
        let patch = tracked.stdout;
        // Git refused the batch (e.g. a sparse-checkout path or an unwritable
        // object store): diff each untracked file on its own instead.
        for (const name of intentToAdd ? [] : untracked) {
          const result = yield* run([...diffArgs, "--no-index", "--", "/dev/null", name], {
            allowNonZeroExit: true,
          });
          // A file that vanished meanwhile prints nothing: it is no longer a working file.
          if (result.exitCode !== 0 && result.exitCode !== 1)
            return yield* fail("An untracked file changed or could not be read. Refresh.");
          patch += result.stdout;
          if (Buffer.byteLength(patch) > PATCH_LIMIT)
            return yield* fail("The comparison exceeds the 2 MB patch limit.");
        }
        const after = JSON.stringify(yield* reader.identity());
        if (before !== after)
          return yield* fail(
            "HEAD, branch or index changed during comparison. Refresh to read them again.",
          );
        return { patch, identity: before };
      }),
    );
  },
);

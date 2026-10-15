import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Effect, Option, Schema } from "effect";
import {
  GitCommandError,
  GitApplyIndexPatchInput,
  type GitLocalChangesInput,
  type GitLocalChangesResult,
} from "@ryco/contracts";
import { authorizeGitReadWorkspace } from "./GitReadWorkspace.ts";
import type { GitVcsDriverShape } from "./GitVcsDriver.ts";

const LIMIT = 2_000_000;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const segments = (patch: string) => patch.split(/(?=^diff --git )/m).filter(Boolean);
const error = (cwd: string, detail: string) =>
  new GitCommandError({ operation: "indexReview", cwd, command: "git index review", detail });
const io = <A>(cwd: string, action: () => Promise<A>) =>
  Effect.tryPromise({
    try: action,
    catch: (cause) =>
      error(
        cwd,
        `Index operation failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
  });

function describePatch(patch: string): GitLocalChangesResult["staged"] {
  return {
    patch,
    files: segments(patch).map((segment) => {
      const header = segment.split(/^@@ /m, 1)[0] ?? "";
      const hunkCount = [...segment.matchAll(/^@@ /gm)].length;
      const fileAction =
        !/^(?:index .*160000|(?:new file mode|deleted file mode|old mode|new mode) (?:120000|160000))$/m.test(
          header,
        ) && !/^index [^\n]* (?:120000|160000)$/m.test(header);
      return {
        id: hash(segment),
        hunkCount,
        fileAction,
        // Partial creation/deletion, mode changes and binary patches require whole-file review.
        hunkAction:
          fileAction &&
          hunkCount > 0 &&
          !/^(?:new file mode|deleted file mode|old mode|new mode|rename |GIT binary patch)/m.test(
            header,
          ),
      };
    }),
  };
}

const makeReader = Effect.fn("makeIndexReviewReader")(function* (
  execute: GitVcsDriverShape["execute"],
  cwd: string,
) {
  const root = yield* authorizeGitReadWorkspace(execute, cwd, "indexReview");
  const run = (
    args: readonly string[],
    options: {
      env?: Record<string, string>;
      stdin?: string;
      allowNonZeroExit?: boolean;
    } = {},
  ) =>
    execute({
      operation: "indexReview",
      cwd: root,
      args,
      timeoutMs: 15_000,
      maxOutputBytes: LIMIT,
      ...options,
      env: { GIT_OPTIONAL_LOCKS: "0", ...options.env },
    });
  const gitPath = (name: string) =>
    run(["rev-parse", "--path-format=absolute", "--git-path", name]).pipe(
      Effect.map((result) => result.stdout.replace(/\r?\n$/, "")),
    );
  // Both paths from one process; a path containing a line break falls back to one each.
  const [indexPath, headPath] = yield* run([
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "index",
    "--git-path",
    "HEAD",
  ]).pipe(
    Effect.flatMap((result) => {
      const paths = result.stdout.replace(/\r?\n$/, "").split(/\r?\n/);
      return paths.length === 2 && paths.every((value) => path.isAbsolute(value))
        ? Effect.succeed(paths as [string, string])
        : Effect.all([gitPath("index"), gitPath("HEAD")]);
    }),
  );
  const readIndex = () =>
    io(root, async () => {
      try {
        const stat = await fs.lstat(indexPath);
        if (!stat.isFile() || stat.size > 32_000_000)
          throw new Error("Unsupported or oversized Git index.");
        return await fs.readFile(indexPath);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw cause;
      }
    });
  /**
   * The branch HEAD points at, read like Git's files backend reads it. `undefined`
   * leaves the answer to `git symbolic-ref`: a symlinked HEAD, an unparseable file,
   * or the reftable stub (`refs/heads/.invalid`) whose real HEAD lives in the table.
   */
  const readHeadFileBranch = () =>
    io(root, async (): Promise<string | null | undefined> => {
      const stat = await fs.lstat(headPath);
      if (!stat.isFile() || stat.size > 4096) return undefined;
      const text = (await fs.readFile(headPath, "utf8")).trimEnd();
      if (!text.startsWith("ref:")) return /^[0-9a-f]{40,64}$/.test(text) ? null : undefined;
      const target = text.slice(4).trim();
      return target.length > 0 && target !== "refs/heads/.invalid" && !/\s/.test(target)
        ? target
        : undefined;
    }).pipe(Effect.orElseSucceed(() => undefined));
  const readBranch = () =>
    Effect.gen(function* () {
      const fromFile = yield* readHeadFileBranch();
      if (fromFile !== undefined) return fromFile;
      const branchResult = yield* run(["symbolic-ref", "--quiet", "HEAD"], {
        allowNonZeroExit: true,
      });
      if (branchResult.exitCode !== 0 && branchResult.exitCode !== 1)
        return yield* error(root, "Cannot verify the current branch.");
      return branchResult.exitCode === 0 ? branchResult.stdout.trim() : null;
    });
  const readHead = () =>
    Effect.gen(function* () {
      const branch = yield* readBranch();
      const headResult = yield* run(["rev-parse", "--verify", "HEAD"], { allowNonZeroExit: true });
      const headOid = headResult.exitCode === 0 ? headResult.stdout.trim() : null;
      if (!headOid && !branch) return yield* error(root, "Cannot verify HEAD.");
      if (headOid && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(headOid))
        return yield* error(root, "Invalid HEAD identity.");
      return { branch, headOid };
    });
  const identity = () =>
    Effect.gen(function* () {
      const head = yield* readHead();
      const bytes = yield* readIndex();
      return { ...head, indexIdentity: bytes === null ? "missing" : hash(bytes) };
    });
  const diffArgs = [
    "diff",
    "--patch",
    "--binary",
    "--full-index",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--no-relative",
    "--unified=3",
    "--submodule=short",
  ];
  const read = () =>
    Effect.scoped(
      Effect.gen(function* () {
        const before = yield* identity();
        // Some Git diff paths refresh index stat data even with optional locks disabled.
        // Read against a disposable copy, keeping the live index byte-for-byte untouched.
        const temp = yield* Effect.acquireRelease(
          io(root, () => fs.mkdtemp(path.join(os.tmpdir(), "ryco-index-read-"))),
          (directory) =>
            io(root, () => fs.rm(directory, { recursive: true, force: true })).pipe(Effect.orDie),
        );
        const temporaryIndex = path.join(temp, "index");
        const bytes = yield* readIndex();
        const env = { GIT_INDEX_FILE: temporaryIndex };
        yield* bytes
          ? io(root, () => fs.writeFile(temporaryIndex, bytes))
          : run(["read-tree", "--empty"], { env }).pipe(Effect.asVoid);
        const readRun = (args: readonly string[], allowNonZeroExit = false) =>
          run(args, { env, allowNonZeroExit });
        if ((yield* readRun(["ls-files", "--unmerged", "-z"])).stdout)
          return yield* error(root, "Resolve merge conflicts before staging from review.");
        const stagedResult = yield* readRun([...diffArgs, "--cached", "--"]);
        if (stagedResult.stdoutTruncated)
          return yield* error(root, "Local changes exceed the 2 MB review limit.");
        const staged = stagedResult.stdout;
        const untracked = (yield* readRun([
          "ls-files",
          "--others",
          "--exclude-standard",
          "--full-name",
          "-z",
        ])).stdout
          .split("\0")
          // A trailing slash marks an embedded repository, which has no file patch.
          .filter((name) => name.length > 0 && !name.endsWith("/"));
        if (untracked.length > 200)
          return yield* error(
            root,
            "Too many untracked files for review. Narrow the working changes first.",
          );
        // Tracked changes are read before any untracked path enters the index:
        // `git add` replaces an entry that clashes file-vs-directory with the
        // path it adds (tracked `foo` now a directory holding untracked
        // `foo/bar`), which would hide that tracked deletion.
        // With untracked files present a failed read refuses the review as the
        // combined diff did, not with a raw Git error.
        const trackedResult = yield* readRun([...diffArgs, "--"], untracked.length > 0);
        if (trackedResult.exitCode !== 0)
          return yield* error(
            root,
            "An untracked file changed or could not be read. Refresh the review.",
          );
        if (trackedResult.stdoutTruncated)
          return yield* error(root, "Local changes exceed the 2 MB review limit.");
        // Mark untracked files intent-to-add in the disposable index so one
        // more working-tree diff reports them as new files, instead of one
        // `diff --no-index` process per file. Records only the empty blob.
        // Writing an index runs `post-index-change`; a read must not run hooks.
        const intentToAdd =
          untracked.length === 0
            ? true
            : (yield* run(
                [
                  "-c",
                  "core.splitIndex=false",
                  "-c",
                  "core.hooksPath=/dev/null",
                  "add",
                  "--intent-to-add",
                  "--pathspec-from-file=-",
                  "--pathspec-file-nul",
                ],
                {
                  env: { ...env, GIT_LITERAL_PATHSPECS: "1" },
                  stdin: untracked.map((name) => `${name}\0`).join(""),
                  allowNonZeroExit: true,
                },
              )).exitCode === 0;
        // Only intent-to-add entries can read as added against the index, so
        // this diff holds exactly the untracked files. A refused batch can still
        // have recorded some paths (e.g. all but those outside a sparse
        // checkout); the per-file fallback below covers every untracked file.
        const untrackedResult =
          intentToAdd && untracked.length > 0
            ? yield* readRun([...diffArgs, "--diff-filter=A", "--"], true)
            : null;
        if (untrackedResult !== null && untrackedResult.exitCode !== 0)
          return yield* error(
            root,
            "An untracked file changed or could not be read. Refresh the review.",
          );
        if (untrackedResult?.stdoutTruncated)
          return yield* error(root, "Local changes exceed the 2 MB review limit.");
        // An intent-to-add path that vanished before the diff reads as a deleted
        // empty file; refuse it like the per-file diff refuses a missing file.
        if (
          intentToAdd &&
          untracked.length > 0 &&
          (yield* io(root, () =>
            Promise.all(
              untracked.map((name) =>
                fs.lstat(path.join(root, name)).then(
                  () => false,
                  () => true,
                ),
              ),
            ),
          )).some(Boolean)
        )
          return yield* error(
            root,
            "An untracked file changed or could not be read. Refresh the review.",
          );
        let unstaged = trackedResult.stdout + (untrackedResult?.stdout ?? "");
        // Git refused the batch (e.g. a sparse-checkout path or an unwritable
        // object store): diff each untracked file on its own instead.
        for (const name of intentToAdd ? [] : untracked) {
          const result = yield* readRun([...diffArgs, "--no-index", "--", "/dev/null", name], true);
          if (result.exitCode !== 0 && result.exitCode !== 1)
            return yield* error(
              root,
              "An untracked file changed or could not be read. Refresh the review.",
            );
          unstaged += result.stdout;
          if (Buffer.byteLength(staged) + Buffer.byteLength(unstaged) > LIMIT)
            return yield* error(root, "Local changes exceed the 2 MB review limit.");
        }
        if (Buffer.byteLength(staged) + Buffer.byteLength(unstaged) > LIMIT)
          return yield* error(root, "Local changes exceed the 2 MB review limit.");
        const after = yield* identity();
        if (JSON.stringify(before) !== JSON.stringify(after))
          return yield* error(
            root,
            "HEAD, branch or index changed during review. Refresh the review.",
          );
        const revision = hash(JSON.stringify(["index-review-v1", root, before, staged, unstaged]));
        return {
          worktreePath: root,
          ...before,
          revision,
          staged: describePatch(staged),
          unstaged: describePatch(unstaged),
        };
      }),
    );
  return { root, run, gitPath, indexPath, headPath, readIndex, identity, read };
});

export const readGitLocalChanges = Effect.fn("readGitLocalChanges")(function* (
  execute: GitVcsDriverShape["execute"],
  input: GitLocalChangesInput,
) {
  return yield* (yield* makeReader(execute, input.cwd)).read();
});

/** Holds Git's own index/HEAD/ref locks. All edits happen in a disposable index;
 * only a fully checked result is published by atomic rename. Never edits working files.
 */
export const applyGitIndexPatch = Effect.fn("applyGitIndexPatch")(function* (
  execute: GitVcsDriverShape["execute"],
  input: GitApplyIndexPatchInput,
) {
  if (Option.isNone(Schema.decodeUnknownOption(GitApplyIndexPatchInput)(input)))
    return yield* error(input.cwd, "Invalid staging selection.");
  const reader = yield* makeReader(execute, input.cwd);
  const { root, run, gitPath, indexPath } = reader;
  yield* Effect.scoped(
    Effect.gen(function* () {
      // Fail immediately on contention; never remove someone else's lock.
      const lock = (target: string) =>
        Effect.acquireRelease(
          io(root, async () => {
            await fs.mkdir(path.dirname(target), { recursive: true });
            return { handle: await fs.open(`${target}.lock`, "wx", 0o600), published: false };
          }),
          (lock) =>
            io(root, async () => {
              await lock.handle.close();
              if (!lock.published) await fs.rm(`${target}.lock`, { force: true });
            }).pipe(Effect.orDie),
        );
      const indexLock = yield* lock(indexPath);
      yield* lock(reader.headPath);
      const captured = yield* reader.identity();
      if (captured.branch) yield* lock(yield* gitPath(captured.branch));
      const snapshot = yield* reader.read();
      if (snapshot.revision !== input.expectedRevision)
        return yield* error(
          root,
          "HEAD, branch, index or patch changed. Refresh before staging or unstaging.",
        );
      const section = snapshot[input.scope];
      const fileIndex = section.files.findIndex((file) => file.id === input.fileId);
      const file = section.files[fileIndex];
      if (!file?.fileAction) return yield* error(root, "This file cannot be staged from review.");
      let patch = segments(section.patch)[fileIndex]!;
      if (input.hunkIndex !== undefined) {
        if (!file.hunkAction || input.hunkIndex >= file.hunkCount)
          return yield* error(
            root,
            "This hunk cannot be staged independently. Review the whole file.",
          );
        const parts = patch.split(/(?=^@@ )/m);
        // The index line describes the whole file; let Git derive the partial result.
        patch = parts[0]!.replace(/^index .*\n/gm, "") + parts[input.hunkIndex + 1]!;
      }
      const temp = yield* Effect.acquireRelease(
        io(root, () => fs.mkdtemp(path.join(os.tmpdir(), "ryco-index-review-"))),
        (directory) =>
          io(root, () => fs.rm(directory, { recursive: true, force: true })).pipe(Effect.orDie),
      );
      const temporaryIndex = path.join(temp, "index");
      const index = yield* reader.readIndex();
      if (index) yield* io(root, () => fs.writeFile(temporaryIndex, index));
      const env = { GIT_INDEX_FILE: temporaryIndex };
      if (!index) yield* run(["read-tree", "--empty"], { env });
      yield* run(["update-index", "--no-split-index"], { env });
      yield* run(
        [
          "apply",
          "--cached",
          "--whitespace=nowarn",
          ...(input.scope === "staged" ? ["--reverse"] : []),
          "-",
        ],
        { env, stdin: patch },
      );
      // Re-read the exact review after patch preparation: agent writes are outside Git locks.
      if ((yield* reader.read()).revision !== snapshot.revision)
        return yield* error(root, "The working changes moved while staging. Refresh the review.");
      yield* io(root, async () => {
        const contents = await fs.readFile(temporaryIndex);
        await indexLock.handle.writeFile(contents);
        await indexLock.handle.sync();
        await fs.rename(`${indexPath}.lock`, indexPath);
        indexLock.published = true;
      }).pipe(Effect.uninterruptible);
    }),
  );
});

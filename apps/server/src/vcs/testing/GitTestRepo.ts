import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";

export const TEST_GIT_COMMIT_IDENTITY_CONFIG = [
  ["user.email", "test@test.com"],
  ["user.name", "Test"],
  ["commit.gpgsign", "false"],
] as const;

export const configureTestGitCommitIdentity = <E, R>(
  cwd: string,
  runGit: (cwd: string, args: ReadonlyArray<string>) => Effect.Effect<unknown, E, R>,
): Effect.Effect<void, E, R> =>
  Effect.gen(function* () {
    for (const [key, value] of TEST_GIT_COMMIT_IDENTITY_CONFIG) {
      yield* runGit(cwd, ["config", key, value]);
    }
  });

/**
 * Repository config that changes what a plain `git diff` prints, everything
 * `INTERNAL_PATCH_DIFF_ARGS` overrides: no or mnemonic prefixes, ten lines of
 * context, an external diff tool and a textconv driver that print garbage,
 * forced color, blank context lines without their leading space, cwd-relative
 * paths and submodule logs.
 */
export const HOSTILE_DIFF_CONFIG = [
  ["diff.noprefix", "true"],
  ["diff.mnemonicPrefix", "true"],
  ["diff.context", "10"],
  ["diff.external", "echo EXTERNAL-DIFF-GARBAGE"],
  ["diff.hostile.textconv", "sed s/^/TEXTCONV-GARBAGE:/"],
  ["color.ui", "always"],
  ["color.diff", "always"],
  ["diff.suppressBlankEmpty", "true"],
  ["diff.relative", "true"],
  ["diff.submodule", "log"],
] as const;

/**
 * Applies {@link HOSTILE_DIFF_CONFIG} to the repository whose main checkout is
 * `cwd`, and routes every path through its textconv driver with repository-local
 * attributes (`.git/info/attributes`), so no tracked file changes. Repository
 * config only: the user's global config is never touched.
 */
export const configureHostileDiffConfig = <E, R>(
  cwd: string,
  runGit: (cwd: string, args: ReadonlyArray<string>) => Effect.Effect<unknown, E, R>,
): Effect.Effect<void, E, R> =>
  Effect.gen(function* () {
    for (const [key, value] of HOSTILE_DIFF_CONFIG) {
      yield* runGit(cwd, ["config", key, value]);
    }
    yield* Effect.promise(async () => {
      const info = path.join(cwd, ".git", "info");
      await mkdir(info, { recursive: true });
      await writeFile(path.join(info, "attributes"), "* diff=hostile\n");
    });
  });

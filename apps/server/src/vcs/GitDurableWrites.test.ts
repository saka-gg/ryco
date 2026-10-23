import { describe, expect, it } from "vite-plus/test";

import {
  NO_USER_HOOK_ARGS,
  SCRATCH_INDEX_CONFIG_ARGS,
  WRITEOUT_ONLY_DURABLE_WRITE_ARGS,
  classifyGitExitDetail,
  durableWriteArgs,
  gitCMessagesEnv,
  gitSubcommand,
  isTransientGitExitKind,
  type GitExitFailureKind,
} from "./GitDurableWrites.ts";

/** `-c` values of a leading argument list, in order. */
const configValues = (args: ReadonlyArray<string>) =>
  args.filter((_, index) => args[index - 1] === "-c");

describe("durableWriteArgs", () => {
  it("batches flushes on macOS and Windows after a plain fsync git 2.36 keeps", () => {
    for (const platform of ["darwin", "win32"] as const) {
      expect(configValues(durableWriteArgs(platform))).toEqual([
        "core.fsync=objects,reference",
        "core.fsyncMethod=fsync",
        "core.fsyncMethod=batch",
      ]);
    }
  });

  it("flushes each file elsewhere", () => {
    for (const platform of ["linux", "freebsd"] as const) {
      expect(configValues(durableWriteArgs(platform))).toEqual([
        "core.fsync=objects,reference",
        "core.fsyncMethod=fsync",
      ]);
    }
  });

  it("keeps the components on the writeout-only fallback", () => {
    expect(configValues(WRITEOUT_ONLY_DURABLE_WRITE_ARGS)).toEqual([
      "core.fsync=objects,reference",
      "core.fsyncMethod=writeout-only",
    ]);
  });

  it("silences file and config hooks and never splits a scratch index", () => {
    expect(configValues(NO_USER_HOOK_ARGS)).toEqual([
      "core.hooksPath=/dev/null",
      "hook.post-index-change.enabled=false",
      "hook.reference-transaction.enabled=false",
    ]);
    expect(configValues(SCRATCH_INDEX_CONFIG_ARGS)).toEqual([
      "core.splitIndex=false",
      ...configValues(NO_USER_HOOK_ARGS),
    ]);
  });
});

describe("gitSubcommand", () => {
  it("skips leading -c pairs", () => {
    expect(gitSubcommand([...durableWriteArgs("darwin"), "update-ref", "refs/x", "abc"])).toBe(
      "update-ref",
    );
    expect(gitSubcommand(["add", "-A"])).toBe("add");
    expect(gitSubcommand(["-c", "a=b"])).toBeUndefined();
  });
});

describe("gitCMessagesEnv", () => {
  it("sets only the message category when LC_ALL is unset", () => {
    expect(gitCMessagesEnv({ LANG: "de_DE.UTF-8", LANGUAGE: "de" })).toEqual({
      LC_ALL: undefined,
      LC_MESSAGES: "C",
    });
  });

  it("restates LC_ALL per category so user filters keep their character set", () => {
    expect(gitCMessagesEnv({ LC_ALL: "de_DE.UTF-8", LC_CTYPE: "C" })).toEqual({
      LC_CTYPE: "de_DE.UTF-8",
      LC_COLLATE: "de_DE.UTF-8",
      LC_NUMERIC: "de_DE.UTF-8",
      LC_TIME: "de_DE.UTF-8",
      LC_MONETARY: "de_DE.UTF-8",
      LC_ALL: undefined,
      LC_MESSAGES: "C",
    });
  });
});

describe("classifyGitExitDetail", () => {
  // Real C-locale stderr, captured from git 2.56 and 2.39.
  const cases: ReadonlyArray<readonly [GitExitFailureKind, string]> = [
    [
      "lock-contention",
      "fatal: update_ref failed for ref 'refs/ryco/checkpoints/t/turn/1': cannot lock ref 'refs/ryco/checkpoints/t/turn/1': Unable to create '/r/.git/refs/ryco/checkpoints/t/turn/1.lock': File exists.\n\nAnother git process seems to be running in this repository.",
    ],
    ["lock-contention", "error: Unable to create '/r/.git/packed-refs.lock': File exists."],
    ["worktree-race", "fatal: unable to stat 'churn/f131': No such file or directory"],
    [
      "worktree-race",
      "error: open(\"a/b.txt\"): No such file or directory\nerror: unable to index file 'a/b.txt'\nfatal: adding files failed",
    ],
    [
      "worktree-race",
      "error: short read while indexing log.txt\nerror: log.txt: failed to insert into database\nerror: unable to index file 'log.txt'\nfatal: updating files failed",
    ],
    [
      "flush-unsupported",
      "fatal: fsync error on '.git/objects/ab/cdef01': Operation not supported",
    ],
    // Git names no reason: a rejected flush, or a full or failing disk.
    [
      "ref-write-failed",
      "fatal: update_ref failed for ref 'refs/ryco/x': cannot update ref 'refs/ryco/x': couldn't write '/r/.git/refs/ryco/x.lock'",
    ],
    [
      "nested-repository-without-commit",
      "error: 'pkg/inner/' does not have a commit checked out\nerror: unable to index file 'pkg/inner/'\nfatal: adding files failed",
    ],
    // A localized git (macOS falls back to the system languages without LANG)
    // never classifies, which is why captures force C messages.
    ["other", "Fehler: 'pkg/inner/' hat keinen Commit ausgecheckt"],
    ["other", "fatal: pathspec 'x' did not match any files"],
    ["other", 'error: open("x"): Permission denied'],
    ["other", ""],
  ];

  it.each(cases)("classifies %s: %s", (kind, detail) => {
    expect(classifyGitExitDetail(detail)).toBe(kind);
  });
});

describe("isTransientGitExitKind", () => {
  it("reruns only lock contention and working-tree races", () => {
    const kinds: ReadonlyArray<GitExitFailureKind> = [
      "lock-contention",
      "worktree-race",
      "flush-unsupported",
      "ref-write-failed",
      "nested-repository-without-commit",
      "other",
    ];
    expect(kinds.filter(isTransientGitExitKind)).toEqual(["lock-contention", "worktree-race"]);
  });
});

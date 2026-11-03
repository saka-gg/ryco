import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, FileSystem, Layer, Option } from "effect";
import type { ChangeRequest } from "@ryco/contracts";

import { ServerConfig } from "../config.ts";
import * as Driver from "../vcs/GitVcsDriver.ts";
import { configureTestGitCommitIdentity } from "../vcs/testing/GitTestRepo.ts";
import {
  boundWritingExamples,
  mergedChangeRequestTitles,
  parseFirstParentSubjects,
  readRecentCommitSubjects,
  readRepositoryWritingExamples,
  REPOSITORY_WRITING_EXAMPLE_MAX_CHARS,
} from "./repositoryWritingExamples.ts";

const layer = Driver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "writing-examples-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const changeRequest = (
  number: number,
  title: string,
  state: ChangeRequest["state"],
): ChangeRequest => ({
  provider: "github",
  number,
  title,
  url: `https://github.com/acme/app/pull/${number}`,
  baseRefName: "main",
  headRefName: `feature/${number}`,
  state,
  updatedAt: Option.some(DateTime.makeUnsafe("2026-10-01T00:00:00Z")),
});

/** A scratch repository with a commit per subject on `main`, oldest first. */
const makeRepo = (subjects: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const driver = yield* Driver.GitVcsDriver;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-writing-examples-" });
    const git = (args: ReadonlyArray<string>, at = cwd) =>
      driver.execute({ operation: "test", cwd: at, args });
    yield* git(["init", "-b", "main"]);
    yield* configureTestGitCommitIdentity(cwd, (_, args) => git(args));
    for (const [index, subject] of subjects.entries()) {
      yield* fs.writeFileString(`${cwd}/file-${index}.txt`, `${index}\n`);
      yield* git(["add", "."]);
      yield* git(["commit", "-m", subject]);
    }
    return { cwd, git, fs, driver };
  });

describe("repository writing example helpers", () => {
  it("drops merge records and a record cut short by the byte cap", () => {
    const stdout = [
      "aaa\u001fAdd login page",
      "bbb ccc\u001fMerge pull request #4 from acme/feature",
      "ddd\u001fFix logout redirect",
      "eee\u001fPartial subj",
    ].join("\n");
    expect(parseFirstParentSubjects(stdout)).toEqual(["Add login page", "Fix logout redirect"]);
    expect(parseFirstParentSubjects(`${stdout}\n`)).toEqual([
      "Add login page",
      "Fix logout redirect",
      "Partial subj",
    ]);
    // The root commit has no parents and still counts.
    expect(parseFirstParentSubjects("\u001fInitial commit\n")).toEqual(["Initial commit"]);
  });

  it("caps count and length without splitting a character, and cleans each example", () => {
    const long = `${"a".repeat(REPOSITORY_WRITING_EXAMPLE_MAX_CHARS - 1)}😀 tail`;
    const bounded = boundWritingExamples([
      "  Add login page  ",
      "Add login page",
      "",
      "   ",
      "Bell\u0007 and\u001b[31m escape",
      long,
      ...Array.from({ length: 20 }, (_, index) => `Subject ${index}`),
    ]);
    expect(bounded).toHaveLength(10);
    expect(bounded[0]).toBe("Add login page");
    expect(bounded[1]).toBe("Bell and [31m escape");
    expect(bounded[2]).toBe("a".repeat(REPOSITORY_WRITING_EXAMPLE_MAX_CHARS - 1));
    expect(bounded[3]).toBe("Subject 0");
  });

  it("uses merged pull request titles only, newest first, once each", () => {
    expect(
      mergedChangeRequestTitles([
        {
          complete: true,
          items: [
            changeRequest(9, "Open from a stranger", "open"),
            changeRequest(8, "Remember the reading position", "merged"),
            changeRequest(7, "Closed attempt", "closed"),
            changeRequest(6, "Hide credentials in diagnostics", "merged"),
          ],
        },
        { complete: true, items: [changeRequest(8, "Remember the reading position", "merged")] },
      ]),
    ).toEqual(["Remember the reading position", "Hide credentials in diagnostics"]);
  });
});

describe("readRecentCommitSubjects", () => {
  it.effect("reads first-parent subjects of a squash history, newest first", () =>
    Effect.gen(function* () {
      const { cwd, driver } = yield* makeRepo([
        "Initial commit",
        "Add login page",
        "Fix logout redirect",
      ]);
      expect(yield* readRecentCommitSubjects(driver, cwd)).toEqual([
        "Fix logout redirect",
        "Add login page",
        "Initial commit",
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads non-merge commits when first-parent history is mostly merges", () =>
    Effect.gen(function* () {
      const { cwd, git, fs, driver } = yield* makeRepo(["Initial commit"]);
      for (const name of ["one", "two", "three"]) {
        yield* git(["checkout", "-b", `feature/${name}`]);
        yield* fs.writeFileString(`${cwd}/${name}.txt`, `${name}\n`);
        yield* git(["add", "."]);
        yield* git(["commit", "-m", `Build feature ${name}`]);
        yield* git(["checkout", "main"]);
        yield* git(["merge", "--no-ff", "-m", `Merge branch 'feature/${name}'`, `feature/${name}`]);
      }
      const subjects = yield* readRecentCommitSubjects(driver, cwd);
      expect(subjects).toContain("Build feature three");
      expect(subjects).toContain("Build feature one");
      expect(subjects.some((subject) => subject.startsWith("Merge branch"))).toBe(false);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("gives no subjects for an empty repository", () =>
    Effect.gen(function* () {
      const { cwd, driver } = yield* makeRepo([]);
      expect(yield* readRecentCommitSubjects(driver, cwd)).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("prefers the primary remote's default branch over the checkout's own commits", () =>
    Effect.gen(function* () {
      const { cwd, git, fs, driver } = yield* makeRepo(["Initial commit", "Add login page"]);
      const remote = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-writing-remote-" });
      yield* git(["init", "--bare", "-b", "main"], remote);
      // A primary remote not named origin, and no recorded remote HEAD.
      yield* git(["remote", "add", "upstream", remote]);
      yield* git(["push", "upstream", "main"]);
      yield* git(["checkout", "-b", "feature/wip"]);
      yield* fs.writeFileString(`${cwd}/wip.txt`, "wip\n");
      yield* git(["add", "."]);
      yield* git(["commit", "-m", "wip: half done"]);
      yield* git(["branch", "-f", "main", "HEAD"]);

      const subjects = yield* readRecentCommitSubjects(driver, cwd);
      expect(subjects).toEqual(["Add login page", "Initial commit"]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads the remote's recorded HEAD first", () =>
    Effect.gen(function* () {
      const { cwd, git, fs, driver } = yield* makeRepo(["Initial commit"]);
      const remote = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-writing-remote-" });
      yield* git(["init", "--bare", "-b", "main"], remote);
      yield* git(["remote", "add", "origin", remote]);
      yield* git(["checkout", "-b", "trunk"]);
      yield* fs.writeFileString(`${cwd}/trunk.txt`, "trunk\n");
      yield* git(["add", "."]);
      yield* git(["commit", "-m", "Start the trunk"]);
      yield* git(["push", "origin", "trunk", "main"]);
      yield* git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"]);
      yield* git(["checkout", "main"]);

      expect(yield* readRecentCommitSubjects(driver, cwd)).toEqual([
        "Start the trunk",
        "Initial commit",
      ]);
    }).pipe(Effect.provide(layer)),
  );

  // The live clock: the read's own time budget has to fire.
  it.live("gives up after three seconds instead of holding the commit", () =>
    Effect.gen(function* () {
      const { cwd, driver } = yield* makeRepo(["Initial commit"]);
      const hanging: Driver.GitVcsDriverShape["execute"] = (input) =>
        input.args[0] === "log" ? Effect.never : driver.execute(input);
      const started = Date.now();
      const subjects = yield* readRecentCommitSubjects(
        { execute: hanging, resolvePrimaryRemoteName: driver.resolvePrimaryRemoteName },
        cwd,
      );
      expect(subjects).toEqual([]);
      expect(Date.now() - started).toBeLessThan(10_000);
    }).pipe(Effect.provide(layer)),
  );
});

describe("readRepositoryWritingExamples", () => {
  it.effect("bounds pull request titles and never fails on a failing commit read", () =>
    Effect.gen(function* () {
      const examples = yield* readRepositoryWritingExamples({
        readCommitSubjects: Effect.succeed(["Add login page"]),
        peekChangeRequestListings: Effect.succeed([
          {
            complete: false,
            items: Array.from({ length: 30 }, (_, index) =>
              changeRequest(100 - index, `Merged ${index}`, "merged"),
            ),
          },
        ]),
      });
      expect(examples.commitSubjects).toEqual(["Add login page"]);
      expect(examples.pullRequestTitles).toHaveLength(10);
      expect(examples.pullRequestTitles[0]).toBe("Merged 0");
    }),
  );
});

// At the repo root, not in a workspace, so that `--affected` runs every suite
// it configures (see turbo.json globalDependencies). Tested by
// scripts/vitest.pure-projects.test.ts, since a root file has no test task.

import * as fs from "node:fs";
import * as path from "node:path";

import { defaultExclude, type TestProjectInlineConfiguration } from "vite-plus/test/config";

type PureProjectOverrides = Omit<
  NonNullable<TestProjectInlineConfiguration["test"]>,
  "name" | "include" | "exclude" | "isolate"
>;

export interface TestProjectOptions {
  /** Settings only the pure project gets, such as a tighter timeout. */
  readonly pureOverrides?: PureProjectOverrides;
  /** Package-relative files for the serial "timing" project described below. */
  readonly timingTestFiles?: readonly string[];
}

/**
 * Splits a package's suite into Vitest projects that inherit its config.
 *
 * "pure" runs an explicitly audited allowlist with `isolate: false`, so each
 * worker evaluates the shared module graph once instead of once per file. Most
 * of these suites' CPU time is module import (the @ryco/contracts index alone
 * takes 1-2s to evaluate in Node). "isolated" runs every other test file with
 * Vitest's default per-file module isolation, which stays the default for new
 * tests. Vitest queues the isolated files before the pure ones, so a package's
 * longest file can be left isolated to start at once.
 *
 * "timing", when a package lists files for it, runs them isolated and one at a
 * time after both other projects have finished (`sequence.groupOrder` 1). It
 * is for files whose assertions bound wall-clock time or event-loop gaps: in a
 * package that runs files in parallel, the CPU the other files use stretches
 * exactly those measurements, so they keep the load profile of a serial run.
 * (A run with file parallelism off is serial throughout; Vitest then runs the
 * isolated files last.)
 *
 * Entries are package-relative file paths, not globs. Config load fails on a
 * missing or duplicate entry, or on a file in both lists, so a renamed or
 * deleted test cannot leave a stale list behind.
 */
export function pureAndIsolatedProjects(
  packageRoot: string,
  pureTestFiles: readonly string[],
  { pureOverrides = {}, timingTestFiles = [] }: TestProjectOptions = {},
): TestProjectInlineConfiguration[] {
  assertExplicitTestFiles(packageRoot, "Pure test allowlist", pureTestFiles);
  assertExplicitTestFiles(packageRoot, "Timing test list", timingTestFiles);
  const pure = new Set(pureTestFiles);
  for (const file of timingTestFiles) {
    if (pure.has(file)) {
      throw new Error(
        `${file} is in both the pure test allowlist and the timing test list. A file runs in one project; timing files run isolated.`,
      );
    }
  }
  const projects: TestProjectInlineConfiguration[] = [
    {
      extends: true,
      test: { ...pureOverrides, name: "pure", include: [...pureTestFiles], isolate: false },
    },
    {
      extends: true,
      test: {
        name: "isolated",
        exclude: [...defaultExclude, ...pureTestFiles, ...timingTestFiles],
      },
    },
  ];
  if (timingTestFiles.length > 0) {
    projects.push({
      extends: true,
      test: {
        name: "timing",
        include: [...timingTestFiles],
        fileParallelism: false,
        sequence: { groupOrder: 1 },
      },
    });
  }
  return projects;
}

function assertExplicitTestFiles(
  packageRoot: string,
  list: string,
  files: readonly string[],
): void {
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file)) {
      throw new Error(`${list} lists ${file} twice.`);
    }
    seen.add(file);
    if (!fs.statSync(path.join(packageRoot, file), { throwIfNoEntry: false })?.isFile()) {
      throw new Error(
        `${list} entry ${file} is not a file under ${packageRoot}. Update the list after renaming or deleting a test.`,
      );
    }
  }
}

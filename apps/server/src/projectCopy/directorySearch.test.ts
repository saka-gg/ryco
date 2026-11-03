import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { type DirectorySearchInput, readGitBranch, searchDirectories } from "./directorySearch.ts";

let scratch: string;
let home: string;

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(path.join(tmpdir(), "ryco-folder-search-")));
  home = path.join(scratch, "home");
  await mkdir(home);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** Folders (relative to home); `repo:` makes a git repository on `branch` (`main` by default). */
const tree = async (entries: ReadonlyArray<string>) => {
  for (const entry of entries) {
    const [kind, relative, branch] = entry.startsWith("repo:")
      ? ["repo", ...entry.slice(5).split("@")]
      : ["dir", entry];
    const folder = path.join(home, relative!);
    await mkdir(folder, { recursive: true });
    if (kind === "repo") {
      await mkdir(path.join(folder, ".git"));
      await writeFile(path.join(folder, ".git", "HEAD"), `ref: refs/heads/${branch ?? "main"}\n`);
    }
  }
};

const search = (input: Partial<DirectorySearchInput> & { readonly query: string }) =>
  searchDirectories({
    roots: [home],
    limit: 40,
    maxDepth: 4,
    homeDir: home,
    platform: "linux",
    ...input,
  });

const relativePaths = (outcome: Awaited<ReturnType<typeof search>>) =>
  outcome.hits.map((hit) => path.relative(home, hit.path));

describe("searchDirectories", () => {
  it("ranks name matches first and reports where each match is", async () => {
    await tree(["Code/ryco", "Code/ryco-docs", "Code/other/rycoish", "archive/r-y-c-o", "Code/x"]);
    const outcome = await search({ query: "ryco" });
    // The workspace-entry ranker: exact name, then prefixes (shorter first), then fuzzy.
    expect(relativePaths(outcome)).toEqual([
      "Code/ryco",
      "Code/other/rycoish",
      "Code/ryco-docs",
      "archive/r-y-c-o",
    ]);
    expect(outcome.hits[0]).toEqual({
      path: path.join(home, "Code", "ryco"),
      name: "ryco",
      parentPath: path.join(home, "Code"),
      depth: 2,
      isGitRepository: false,
      gitBranch: null,
      score: 0.5,
    });
    expect(outcome.truncated).toBe(false);
  });

  it("treats a repository as a leaf and reads its branch", async () => {
    await tree(["repo:Code/app@feature/x", "Code/app/packages/inner-app", "repo:Code/app-two"]);
    const outcome = await search({ query: "app" });
    expect(relativePaths(outcome)).toEqual(["Code/app", "Code/app-two"]);
    expect(outcome.hits.map((hit) => [hit.isGitRepository, hit.gitBranch])).toEqual([
      [true, "feature/x"],
      [true, "main"],
    ]);
  });

  it("ranks a repository ahead of a folder with the same score", async () => {
    await tree(["a/tool", "repo:b/tool"]);
    expect(relativePaths(await search({ query: "tool" }))).toEqual(["b/tool", "a/tool"]);
  });

  it("follows a .git file to a linked worktree's branch, and reads detached as null", async () => {
    await tree(["repo:Code/main"]);
    const gitDir = path.join(home, "Code", "main", ".git", "worktrees", "feature");
    await mkdir(gitDir, { recursive: true });
    await writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/feature\n");
    await mkdir(path.join(home, "Code", "feature"));
    await writeFile(path.join(home, "Code", "feature", ".git"), `gitdir: ${gitDir}\n`);
    expect(await readGitBranch(path.join(home, "Code", "feature"))).toBe("feature");
    await writeFile(path.join(gitDir, "HEAD"), `${"a".repeat(40)}\n`);
    expect(await readGitBranch(path.join(home, "Code", "feature"))).toBeNull();
    expect(await readGitBranch(path.join(home, "Code"))).toBeNull();
  });

  it.skipIf(process.platform === "win32")("never blocks on a FIFO planted as HEAD", async () => {
    await mkdir(path.join(home, "trap", ".git"), { recursive: true });
    execFileSync("mkfifo", [path.join(home, "trap", ".git", "HEAD")]);
    expect(await readGitBranch(path.join(home, "trap"))).toBeNull();
  });

  it("never follows symlinks, so a loop ends", async () => {
    await tree(["Code/real/goal"]);
    await symlink(home, path.join(home, "Code", "loop"));
    await symlink(path.join(home, "Code", "real"), path.join(home, "linked-goal"));
    const outcome = await search({ query: "goal", maxDepth: 6 });
    expect(relativePaths(outcome)).toEqual(["Code/real/goal"]);
    expect(outcome.truncated).toBe(false);
    // home, Code, real and goal: neither link was walked.
    expect(outcome.scannedDirectories).toBe(4);
  });

  it("skips build output, dependencies, Library and hidden folders", async () => {
    await tree([
      "Code/node_modules/match",
      "Code/dist/match",
      "Code/build/match",
      "Code/target/match",
      "Code/vendor/match",
      "Library/CloudStorage/match",
      ".config/match",
      "Code/.venv/match",
      "Code/match",
    ]);
    expect(relativePaths(await search({ query: "match" }))).toEqual(["Code/match"]);
    expect(relativePaths(await search({ query: "node_modules" }))).toEqual([]);
  });

  it("searches hidden folders when the query starts with a dot", async () => {
    await tree([".config/nvim", "config", ".cache/config"]);
    expect(relativePaths(await search({ query: ".config" }))).toEqual([".config", ".config/nvim"]);
    expect(relativePaths(await search({ query: "config" }))).toEqual(["config"]);
    expect(relativePaths(await search({ query: ".nvim" }))).toEqual([".config/nvim"]);
    expect(relativePaths(await search({ query: "nvim" }))).toEqual([]);
  });

  it("stops at the maximum depth", async () => {
    await tree(["a/b/c/d/deep"]);
    expect(relativePaths(await search({ query: "deep", maxDepth: 4 }))).toEqual([]);
    expect(relativePaths(await search({ query: "deep", maxDepth: 5 }))).toEqual(["a/b/c/d/deep"]);
  });

  it("stops at the directory budget and says so", async () => {
    await tree(Array.from({ length: 30 }, (_, index) => `many/folder-${index}/match-${index}`));
    const outcome = await search({ query: "match", maxDirectories: 10 });
    expect(outcome.truncated).toBe(true);
    expect(outcome.scannedDirectories).toBe(10);
    const complete = await search({ query: "match" });
    expect(complete.truncated).toBe(false);
    expect(complete.hits).toHaveLength(30);
    // home, many, 30 folders and the 30 matches inside them.
    expect(complete.scannedDirectories).toBe(62);
  });

  it("stops at the time budget and the per-directory entry budget", async () => {
    await tree(["a/match", "b/match", "c/match"]);
    let clock = 0;
    const timed = await search({ query: "match", timeBudgetMs: 5, now: () => (clock += 3) });
    expect(timed.truncated).toBe(true);
    const capped = await search({ query: "match", maxEntriesPerDirectory: 2 });
    expect(capped.cappedDirectories).toBeGreaterThan(0);
    expect(capped.hits.length).toBeLessThan(3);
  });

  it("does not call the whole search cut short for one huge directory", async () => {
    // One asset folder with more entries than one directory may hold; the match is elsewhere.
    await tree(["Code/ryco", ...Array.from({ length: 6 }, (_, index) => `assets/file-${index}`)]);
    const outcome = await search({ query: "ryco", maxEntriesPerDirectory: 4 });
    expect(relativePaths(outcome)).toEqual(["Code/ryco"]);
    expect(outcome).toMatchObject({ truncated: false, limitReached: false, cappedDirectories: 1 });
  });

  it("says when more folders matched than the limit", async () => {
    await tree(Array.from({ length: 5 }, (_, index) => `Code/match-${index}`));
    const over = await search({ query: "match", limit: 3 });
    expect(over.hits).toHaveLength(3);
    expect(over).toMatchObject({ truncated: false, limitReached: true, cappedDirectories: 0 });
    const exact = await search({ query: "match", limit: 5 });
    expect(exact.hits).toHaveLength(5);
    expect(exact.limitReached).toBe(false);
    // The empty query lists the roots' own folders, also up to the limit.
    const listed = await search({ query: "", roots: [path.join(home, "Code")], limit: 2 });
    expect(listed.hits).toHaveLength(2);
    expect(listed.limitReached).toBe(true);
  });

  it("ends early when aborted", async () => {
    await tree(["a/match"]);
    const controller = new AbortController();
    controller.abort();
    const outcome = await search({ query: "match", signal: controller.signal });
    expect(outcome.hits).toEqual([]);
    expect(outcome.scannedDirectories).toBe(0);
  });

  it("keeps the best matches up to the limit", async () => {
    await tree(["api", "apiary", "rapid", "a-p-i"]);
    expect(relativePaths(await search({ query: "api", limit: 2 }))).toEqual(["api", "apiary"]);
  });

  it("matches a path-like query against paths below home", async () => {
    await tree(["Code/ryco", "Other/ryco"]);
    const code = path.join(home, "Code");
    const outcome = await search({ query: "~/Code/ryco", roots: [code, home] });
    expect(relativePaths(outcome)[0]).toBe("Code/ryco");
    // Another root's folders are walked once, from that root.
    expect(outcome.scannedDirectories).toBe(5);
  });

  it("matches an absolute query below home like its ~/ form", async () => {
    await tree(["Code/ryco", "Other/ryco"]);
    const code = path.join(home, "Code");
    expect(
      relativePaths(await search({ query: path.join(home, "Code", "ryco"), roots: [code, home] })),
    ).toEqual(relativePaths(await search({ query: "~/Code/ryco", roots: [code, home] })));
    expect(
      relativePaths(
        await search({ query: path.join(home, "Code", "ryco"), roots: [code, home] }),
      )[0],
    ).toBe("Code/ryco");
    // A trailing separator asks for the folder's own folders, as `~/Code/` does.
    expect(relativePaths(await search({ query: `${code}/`, roots: [code, home] }))).toEqual(
      relativePaths(await search({ query: "~/Code/", roots: [code, home] })),
    );
    expect(relativePaths(await search({ query: `${code}/`, roots: [code, home] }))).toContain(
      "Code/ryco",
    );
    // Compared case-insensitively where the volume is.
    expect(
      relativePaths(
        await search({
          query: path.join(home, "Code", "ryco").toUpperCase(),
          roots: [code, home],
          platform: "darwin",
        }),
      )[0],
    ).toBe("Code/ryco");
    // A path outside home keeps ranking against the roots' absolute paths.
    const outside = path.join(scratch, "srv");
    await mkdir(path.join(outside, "proj"), { recursive: true });
    expect(
      (await search({ query: path.join(outside, "proj"), roots: [outside] })).hits.map(
        (hit) => hit.path,
      ),
    ).toEqual([path.join(outside, "proj")]);
  });

  it("lists a nested root's own folder under its parent root without walking it twice", async () => {
    await tree(["Code/app", "Code/app/sub"]);
    const code = path.join(home, "Code");
    const outcome = await search({ query: "code", roots: [home, code] });
    expect(relativePaths(outcome)).toEqual(["Code"]);
  });

  describe("on macOS", () => {
    it("does not open the folders a privacy prompt guards", async () => {
      await tree(["repo:Documents/match", "repo:Desktop", "Code/match"]);
      const outcome = await search({ query: "match", platform: "darwin" });
      expect(relativePaths(outcome)).toEqual(["Code/match"]);
      // Listed by name from home, but never probed, even when the query is its name.
      const desktop = await search({ query: "desktop", platform: "darwin" });
      expect(desktop.hits.map((hit) => [path.basename(hit.path), hit.isGitRepository])).toEqual([
        ["Desktop", false],
      ]);
    });

    it("opens a guarded folder that is a code root or that the query names", async () => {
      await tree(["Documents/work/match"]);
      expect(
        relativePaths(await search({ query: "~/Documents/work", platform: "darwin" })),
      ).toEqual(["Documents/work", "Documents/work/match"]);
      expect(
        relativePaths(
          await search({
            query: "match",
            platform: "darwin",
            codeRoots: [path.join(home, "Documents")],
          }),
        ),
      ).toEqual(["Documents/work/match"]);
    });
  });

  describe("with an empty query", () => {
    it("lists the roots' own folders, repositories first", async () => {
      await tree(["Code/zeta", "repo:Code/beta", "Code/alpha", "repo:Code/Gamma", "Code/.hidden"]);
      await tree(["Other/one"]);
      const outcome = await search({
        query: "  ",
        roots: [path.join(home, "Code"), path.join(home, "Other")],
      });
      expect(relativePaths(outcome)).toEqual([
        "Code/beta",
        "Code/Gamma",
        "Code/alpha",
        "Code/zeta",
        "Other/one",
      ]);
      expect(outcome.hits.map((hit) => hit.depth)).toEqual([1, 1, 1, 1, 1]);
      expect(outcome.scannedDirectories).toBe(2);
    });

    it("keeps the limit and leaves guarded folders unprobed", async () => {
      await tree(["repo:Documents", "repo:Code", "Music"]);
      const outcome = await search({ query: "", platform: "darwin", limit: 2 });
      expect(outcome.hits.map((hit) => [hit.name, hit.isGitRepository])).toEqual([
        ["Code", true],
        ["Documents", false],
      ]);
    });
  });

  it("leaves out folders whose names cannot cross the wire", async () => {
    await tree(["match ", " match", "match"]);
    expect(relativePaths(await search({ query: "match" }))).toEqual(["match"]);
  });
});

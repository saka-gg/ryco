import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Clock, Deferred, Duration, Effect, Fiber, FileSystem, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";
import { ChangeRequestTemplateListResult } from "@ryco/contracts";

import { ServerConfig } from "../config.ts";
import * as Driver from "../vcs/GitVcsDriver.ts";
import { configureTestGitCommitIdentity } from "../vcs/testing/GitTestRepo.ts";
import {
  changeRequestTemplateLayout,
  changeRequestTemplateRefCandidates,
  gitHonoursNoLazyFetch,
  makeChangeRequestTemplateReader,
  makeChangeRequestTemplates,
  parseBatchCheck,
  parseCatFileBatch,
  parseGitVersion,
  parseTreeEntries,
  selectTemplateForGeneration,
  templateBody,
  templateDisplayName,
  truncateUtf8,
  type ChangeRequestTemplateLayout,
} from "./changeRequestTemplates.ts";

const layer = Driver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "change-request-templates-" })),
  Layer.provideMerge(NodeServices.layer),
);

const SHA1 = "a".repeat(40);
const SHA256 = "b".repeat(64);
const encoder = new TextEncoder();
const DEFAULT_BODY = "## Summary\n\n## Testing\n";

/** A scratch repository on `main` whose files are committed in one commit. */
const makeRepo = (files: Record<string, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const driver = yield* Driver.GitVcsDriver;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-pr-templates-" });
    const git = (args: ReadonlyArray<string>, at = cwd) =>
      driver.execute({ operation: "test", cwd: at, args });
    yield* git(["init", "-b", "main"]);
    yield* configureTestGitCommitIdentity(cwd, (_, args) => git(args));
    const write = (files: Record<string, string>) =>
      Effect.forEach(Object.entries(files), ([path, content]) =>
        Effect.gen(function* () {
          const directory = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
          if (directory) yield* fs.makeDirectory(`${cwd}/${directory}`, { recursive: true });
          yield* fs.writeFileString(`${cwd}/${path}`, content);
        }),
      );
    const commit = (files: Record<string, string>, message = "change") =>
      Effect.gen(function* () {
        yield* write(files);
        yield* git(["add", "-A"]);
        yield* git(["commit", "--allow-empty", "-m", message]);
      });
    yield* commit({ "README.md": "# app\n", ...files }, "init");
    return { cwd, git, fs, driver, write, commit };
  });

type Repo = Effect.Success<ReturnType<typeof makeRepo>>;

/** A reader over the real driver that records every template git process. */
const makeCountingReader = (
  driver: Driver.GitVcsDriverShape,
  override?: (
    input: Driver.ExecuteGitInput,
  ) => ReturnType<Driver.GitVcsDriverShape["execute"]> | null,
) => {
  const calls: Array<{ readonly operation: string; readonly args: ReadonlyArray<string> }> = [];
  const reader = makeChangeRequestTemplateReader({
    readConfigSnapshot: driver.readConfigSnapshot,
    execute: (input) => {
      calls.push({ operation: input.operation, args: input.args });
      return override?.(input) ?? driver.execute(input);
    },
  });
  return { reader, calls };
};

const read = (
  repo: Repo,
  options: {
    readonly layout?: ChangeRequestTemplateLayout;
    readonly base?: string | null;
    readonly remote?: string | null;
    readonly cwd?: string;
  } = {},
) =>
  makeCountingReader(repo.driver).reader.read({
    cwd: options.cwd ?? repo.cwd,
    layout: options.layout ?? "github",
    refCandidates: changeRequestTemplateRefCandidates({
      baseBranch: options.base === undefined ? "main" : options.base,
      remoteName: options.remote === undefined ? "origin" : options.remote,
    }),
  });

/**
 * The test clock with timers that fire by a monotonic clock a test can move without running any
 * timer, as a blocked event loop or a sleeping machine does. A timer notices the jump on its next
 * check, every 100 ms of test time; then every deadline that passed meanwhile fires at once.
 */
const makeStallableClock = Effect.gen(function* () {
  const testClock = yield* Clock.Clock;
  let offsetNanos = 0n;
  const monotonic = () => testClock.monotonicTimeNanosUnsafe() + offsetNanos;
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => testClock.currentTimeMillisUnsafe(),
    currentTimeMillis: testClock.currentTimeMillis,
    currentTimeNanosUnsafe: () => testClock.currentTimeNanosUnsafe(),
    currentTimeNanos: testClock.currentTimeNanos,
    monotonicTimeNanosUnsafe: monotonic,
    monotonicTimeNanos: Effect.sync(monotonic),
    sleep: (duration) =>
      Effect.suspend(() => {
        const end = monotonic() + Duration.toNanosUnsafe(duration);
        const wait: Effect.Effect<void> = Effect.suspend(() =>
          monotonic() >= end
            ? Effect.void
            : testClock.sleep(Duration.millis(100)).pipe(Effect.andThen(wait)),
        );
        return wait;
      }),
  };
  return {
    /** Moves the monotonic clock without running any timer. */
    stall: (millis: number) => {
      offsetNanos += BigInt(millis) * 1_000_000n;
    },
    provide: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.provideService(effect, Clock.Clock, clock),
  };
});

/**
 * A blobless clone (`--filter=blob:none`) of a repository with a template and an unrelated
 * file, holding only the template's blob. Filters need the serving side's consent, given on
 * the command line, never in a config file.
 */
const makeBloblessClone = Effect.gen(function* () {
  const source = yield* makeRepo({
    ".github/pull_request_template.md": DEFAULT_BODY,
    "unrelated.txt": "never fetched\n",
  });
  const fs = yield* FileSystem.FileSystem;
  const parent = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-pr-templates-clone-" });
  const clone = `${parent}/clone`;
  const uploadPack = "git -c uploadpack.allowFilter=true upload-pack";
  yield* source.git(
    [
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      `--upload-pack=${uploadPack}`,
      `file://${source.cwd}`,
      clone,
    ],
    parent,
  );
  const blobId = (path: string) =>
    source.git(["rev-parse", `HEAD:${path}`]).pipe(Effect.map((result) => result.stdout.trim()));
  const templateBlob = yield* blobId(".github/pull_request_template.md");
  const unrelatedBlob = yield* blobId("unrelated.txt");
  // Fetch only the template's blob, as a checkout of that one file would.
  yield* source.git(
    [
      "-c",
      `remote.origin.uploadpack=${uploadPack}`,
      "checkout",
      "HEAD",
      "--",
      ".github/pull_request_template.md",
    ],
    clone,
  );
  const present = (objectId: string) =>
    source.driver
      .execute({
        operation: "test",
        cwd: clone,
        args: ["cat-file", "--batch-check"],
        stdin: `${objectId}\n`,
        env: { GIT_NO_LAZY_FETCH: "1" },
      })
      .pipe(Effect.map((result) => !result.stdout.includes("missing")));
  return { source, clone, present, templateBlob, unrelatedBlob };
});

describe("change request template helpers", () => {
  it("parses ls-tree records with SHA-1 and SHA-256 ids and skips malformed ones", () => {
    const output = [
      `100644 blob ${SHA1}\t.github/pull_request_template.md`,
      `040000 tree ${SHA256}\tdocs`,
      `100644 blob nothex\tbad.md`,
      `100644 blob ${SHA1} extra\tbad.md`,
      "no tab here",
      `120000 blob ${SHA1}\tlink with\ttab.md`,
      "",
    ].join("\0");
    expect(parseTreeEntries(output)).toEqual([
      { mode: "100644", type: "blob", objectId: SHA1, path: ".github/pull_request_template.md" },
      { mode: "040000", type: "tree", objectId: SHA256, path: "docs" },
      { mode: "120000", type: "blob", objectId: SHA1, path: "link with\ttab.md" },
    ]);
  });

  it("reads batch-check sizes, missing objects and unknown sizes", () => {
    const info = parseBatchCheck(
      [`${SHA1} blob 120`, `${SHA256} missing`, `${"c".repeat(40)} blob BAD`, ""].join("\n"),
    );
    expect(info.get(SHA1)).toEqual({ type: "blob", size: 120 });
    expect(info.get(SHA256)).toBe("missing");
    expect(info.get("c".repeat(40))).toEqual({ type: "blob", size: null });
  });

  it("splits cat-file --batch output, skips missing objects and stops at a cut record", () => {
    const bytes = encoder.encode(
      `${SHA1} blob 3\nabc\n${SHA256} missing\n${"c".repeat(40)} blob 2\nx\n\n${"d".repeat(40)} blob 9\nshort`,
    );
    const objects = parseCatFileBatch(bytes);
    expect([...objects.keys()]).toEqual([SHA1, "c".repeat(40)]);
    expect(new TextDecoder().decode(objects.get(SHA1))).toBe("abc");
    expect(new TextDecoder().decode(objects.get("c".repeat(40)))).toBe("x\n");
  });

  it("cuts UTF-8 before a character that would cross the byte limit", () => {
    // "é" is two bytes; a limit inside it keeps the text before it.
    expect(truncateUtf8(encoder.encode("abé"), 3)).toEqual({ text: "ab", truncated: true });
    expect(truncateUtf8(encoder.encode("ab😀"), 5)).toEqual({ text: "ab", truncated: true });
    expect(truncateUtf8(encoder.encode("abé"), 4)).toEqual({ text: "abé", truncated: false });
  });

  it("gives template bodies \\n line ends, so a text box shows them unchanged", () => {
    expect(templateBody(encoder.encode("## What\r\n\r\n## Why\r\n"))).toEqual({
      body: "## What\n\n## Why",
      truncated: false,
    });
    expect(templateBody(encoder.encode("old\rmac"))?.body).toBe("old\nmac");
    expect(templateBody(encoder.encode("\r\n\r\n"))).toBeNull();
  });

  it("names a template by its file, never empty and never with surrounding spaces", () => {
    expect(templateDisplayName(".github/PULL_REQUEST_TEMPLATE/bug.md")).toBe("bug");
    expect(templateDisplayName("PULL_REQUEST_TEMPLATE/.md")).toBe(".md");
    expect(templateDisplayName("docs/PULL_REQUEST_TEMPLATE/  release notes .txt")).toBe(
      "release notes",
    );
    expect(templateDisplayName("PULL_REQUEST_TEMPLATE/line\nbreak.md")).toBe("line break");
    expect(templateDisplayName(`PULL_REQUEST_TEMPLATE/${"x".repeat(300)}.md`)).toHaveLength(256);
  });

  it("reads Git versions and knows which honour GIT_NO_LAZY_FETCH", () => {
    expect(parseGitVersion("git version 2.44.0\n")).toEqual([2, 44]);
    expect(parseGitVersion("git version 2.39.3 (Apple Git-146)")).toEqual([2, 39]);
    expect(parseGitVersion("git version 2.45.1.windows.1")).toEqual([2, 45]);
    expect(parseGitVersion("nonsense")).toBeNull();
    expect(gitHonoursNoLazyFetch([2, 43])).toBe(false);
    expect(gitHonoursNoLazyFetch([2, 44])).toBe(true);
    expect(gitHonoursNoLazyFetch([3, 0])).toBe(true);
  });

  it("builds only fully qualified ref candidates and rejects revision syntax", () => {
    // With a base, only that branch: never HEAD, which is the checkout's own branch.
    expect(
      changeRequestTemplateRefCandidates({ baseBranch: "main", remoteName: "origin" }),
    ).toEqual(["refs/remotes/origin/main", "refs/heads/main"]);
    expect(
      changeRequestTemplateRefCandidates({ baseBranch: null, remoteName: "upstream" }),
    ).toEqual(["refs/remotes/upstream/HEAD", "HEAD"]);
    expect(changeRequestTemplateRefCandidates({ baseBranch: "", remoteName: null })).toEqual([
      "HEAD",
    ]);
    expect(changeRequestTemplateRefCandidates({ baseBranch: "main", remoteName: "." })).toEqual([
      "refs/heads/main",
    ]);
    expect(
      changeRequestTemplateRefCandidates({ baseBranch: "refs/heads/release", remoteName: null }),
    ).toEqual(["refs/heads/release"]);
    expect(
      changeRequestTemplateRefCandidates({
        baseBranch: "refs/remotes/upstream/main",
        remoteName: "origin",
      }),
    ).toEqual(["refs/remotes/upstream/main"]);
    // A full ref outside the branch namespaces is only ever a branch name, never a tag's tree.
    expect(
      changeRequestTemplateRefCandidates({ baseBranch: "refs/tags/release", remoteName: "origin" }),
    ).toEqual(["refs/remotes/origin/refs/tags/release", "refs/heads/refs/tags/release"]);
    for (const hostile of [
      ":/fix",
      "main:docs",
      "main@{1}",
      "@{-1}",
      "--output=x",
      "a..b",
      "a b",
    ]) {
      expect(
        changeRequestTemplateRefCandidates({ baseBranch: hostile, remoteName: "origin" }),
      ).toEqual([]);
    }
    expect(
      changeRequestTemplateRefCandidates({ baseBranch: "main", remoteName: "--upload-pack=x" }),
    ).toEqual(["refs/heads/main"]);
  });

  it("maps hosts to template layouts", () => {
    expect(changeRequestTemplateLayout("github")).toBe("github");
    expect(changeRequestTemplateLayout("gitlab")).toBe("gitlab");
    expect(changeRequestTemplateLayout("azure-devops")).toBeNull();
    expect(changeRequestTemplateLayout("unknown")).toBeNull();
  });
});

describe("change request template reader", () => {
  it.effect("finds the default template and uses it for generated descriptions", () =>
    Effect.gen(function* () {
      const repo = yield* makeRepo({ ".github/pull_request_template.md": DEFAULT_BODY });
      const set = yield* read(repo);
      expect(set.templates).toEqual([
        {
          path: ".github/pull_request_template.md",
          name: "Default",
          isDefault: true,
          body: "## Summary\n\n## Testing",
          truncated: false,
        },
      ]);
      expect(selectTemplateForGeneration(set, "github")?.path).toBe(
        ".github/pull_request_template.md",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("matches default file names case-insensitively, .txt included", () =>
    Effect.gen(function* () {
      const repo = yield* makeRepo({ "docs/Pull_Request_Template.TXT": "Describe it." });
      const set = yield* read(repo);
      expect(set.templates.map((template) => [template.path, template.isDefault])).toEqual([
        ["docs/Pull_Request_Template.TXT", true],
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads the base branch's tree, not the checkout's branch or working tree", () =>
    Effect.gen(function* () {
      const repo = yield* makeRepo({ ".github/pull_request_template.md": "From main." });
      yield* repo.git(["switch", "-c", "feature"]);
      yield* repo.commit({ ".github/pull_request_template.md": "From the feature branch." });
      yield* repo.commit({ "PULL_REQUEST_TEMPLATE/feature-only.md": "Feature template." });
      yield* repo.write({ "docs/pull_request_template.md": "Not committed." });
      const set = yield* read(repo, { base: "main" });
      expect(set.templates.map((template) => template.body)).toEqual(["From main."]);
      // A base that does not resolve gives none: the feature branch never stands in for it.
      expect((yield* read(repo, { base: "gone" })).templates).toEqual([]);
      expect((yield* read(repo, { base: "main:.github" })).templates).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("prefers the remote's base branch over a local branch that moved", () =>
    Effect.gen(function* () {
      const repo = yield* makeRepo({ ".github/pull_request_template.md": "Remote version." });
      const head = (yield* repo.git(["rev-parse", "HEAD"])).stdout.trim();
      yield* repo.git(["update-ref", "refs/remotes/origin/main", head]);
      yield* repo.commit({ ".github/pull_request_template.md": "Local edit." });
      const set = yield* read(repo, { base: "main", remote: "origin" });
      expect(set.templates.map((template) => template.body)).toEqual(["Remote version."]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("never resolves a base to a tag of the same name", () =>
    Effect.gen(function* () {
      const repo = yield* makeRepo({});
      yield* repo.git(["branch", "release"]);
      yield* repo.commit({ ".github/pull_request_template.md": "Tagged template." });
      yield* repo.git(["tag", "release"]);
      yield* repo.git(["switch", "release"]);
      const set = yield* read(repo, { base: "release" });
      expect(set.templates).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("skips blank defaults, and takes .github over the root over docs", () =>
    Effect.gen(function* () {
      const repo = yield* makeRepo({
        ".github/pull_request_template.md": "  \n\t\n",
        "pull_request_template.md": "Root.",
        "docs/pull_request_template.md": "Docs.",
      });
      const set = yield* read(repo);
      expect(set.templates.map((template) => [template.path, template.name])).toEqual([
        ["pull_request_template.md", "Default"],
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("lists two defaults in one location and generates with neither", () =>
    Effect.gen(function* () {
      const repo = yield* makeRepo({
        ".github/pull_request_template.md": "Markdown.",
        ".github/pull_request_template.txt": "Text.",
      });
      const set = yield* read(repo);
      expect(set.templates.map((template) => [template.name, template.isDefault])).toEqual([
        ["pull_request_template.md", true],
        ["pull_request_template.txt", true],
      ]);
      expect(selectTemplateForGeneration(set, "github")).toBeNull();
    }).pipe(Effect.provide(layer)),
  );

  it.effect("puts the default first and still lists directory templates", () =>
    Effect.gen(function* () {
      const repo = yield* makeRepo({
        ".github/PULL_REQUEST_TEMPLATE/bug.md": "Bug.",
        ".github/pull_request_template.md": "Default.",
        "docs/PULL_REQUEST_TEMPLATE/feature.txt": "Feature.",
        "docs/PULL_REQUEST_TEMPLATE/notes.json": "{}",
        "docs/PULL_REQUEST_TEMPLATE/nested/deep.md": "Too deep.",
      });
      const set = yield* read(repo);
      expect(set.templates.map((template) => [template.name, template.isDefault])).toEqual([
        ["Default", true],
        ["bug", false],
        ["feature", false],
      ]);
      expect(selectTemplateForGeneration(set, "github")?.name).toBe("Default");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("generates with a single directory template but never guesses between several", () =>
    Effect.gen(function* () {
      const one = yield* makeRepo({ "PULL_REQUEST_TEMPLATE/only.md": "Only." });
      expect(selectTemplateForGeneration(yield* read(one), "github")?.name).toBe("only");

      const two = yield* makeRepo({
        ".github/PULL_REQUEST_TEMPLATE/bug.md": "Bug.",
        ".github/PULL_REQUEST_TEMPLATE/feature.md": "Feature.",
      });
      const set = yield* read(two);
      expect(set.templates.map((template) => template.name)).toEqual(["bug", "feature"]);
      expect(selectTemplateForGeneration(set, "github")).toBeNull();
    }).pipe(Effect.provide(layer)),
  );

  it.effect("finds a template directory spelled in another case with a second listing", () =>
    Effect.gen(function* () {
      const repo = yield* makeRepo({ ".github/Pull_Request_Template/bug.md": "Bug." });
      const { reader, calls } = makeCountingReader(repo.driver);
      const set = yield* reader.read({
        cwd: repo.cwd,
        layout: "github",
        refCandidates: ["refs/heads/main"],
      });
      expect(set.templates.map((template) => template.path)).toEqual([
        ".github/Pull_Request_Template/bug.md",
      ]);
      expect(calls.map((call) => call.operation)).toContain(
        "changeRequestTemplates.listGitHubDirectories",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads at most 16 candidates, defaults first, and the list still encodes", () =>
    Effect.gen(function* () {
      const directory = Object.fromEntries(
        Array.from({ length: 17 }, (_, index) => [
          `.github/PULL_REQUEST_TEMPLATE/t${String(index).padStart(2, "0")}.md`,
          `Template ${index}.`,
        ]),
      );
      const overflow = yield* read(yield* makeRepo(directory));
      expect(overflow.overflow).toBe(true);
      expect(overflow.templates).toHaveLength(16);
      expect(overflow.templates.at(-1)?.name).toBe("t15");
      expect(selectTemplateForGeneration(overflow, "github")).toBeNull();

      const withDefaults = yield* read(
        yield* makeRepo({
          ...directory,
          ".github/pull_request_template.md": "Markdown.",
          ".github/pull_request_template.txt": "Text.",
        }),
      );
      expect(withDefaults.templates).toHaveLength(16);
      expect(withDefaults.templates.slice(0, 2).every((template) => template.isDefault)).toBe(true);
      expect(() =>
        Schema.encodeUnknownSync(ChangeRequestTemplateListResult)({
          templates: withDefaults.templates,
          generationTemplatePath: null,
        }),
      ).not.toThrow();
    }).pipe(Effect.provide(layer)),
  );

  it.effect("ignores symlinks, submodules, binary files and blank templates", () =>
    Effect.gen(function* () {
      const repo = yield* makeRepo({
        "target.md": "Linked text.",
        ".github/PULL_REQUEST_TEMPLATE/binary.md": "a\u0000b",
        ".github/PULL_REQUEST_TEMPLATE/blank.md": "\n\n",
        ".github/PULL_REQUEST_TEMPLATE/real.md": "Real.",
      });
      yield* Effect.promise(async () => {
        const { symlink } = await import("node:fs/promises");
        await symlink("../target.md", `${repo.cwd}/.github/pull_request_template.md`);
      });
      const head = (yield* repo.git(["rev-parse", "HEAD"])).stdout.trim();
      yield* repo.git([
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${head},.github/PULL_REQUEST_TEMPLATE/module.md`,
      ]);
      // Not `add -A`: the gitlink has no checkout, which would stage its removal.
      yield* repo.git(["add", ".github/pull_request_template.md"]);
      yield* repo.git(["commit", "-m", "links"]);
      const tree = (yield* repo.git(["ls-tree", "-r", "HEAD", ".github"])).stdout;
      expect(tree).toContain("120000 blob");
      expect(tree).toContain("160000 commit");
      const set = yield* read(repo);
      expect(set.templates.map((template) => template.path)).toEqual([
        ".github/PULL_REQUEST_TEMPLATE/real.md",
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("skips a file over 100,000 bytes without reading it", () =>
    Effect.gen(function* () {
      const repo = yield* makeRepo({ ".github/pull_request_template.md": "x".repeat(100_001) });
      const { reader, calls } = makeCountingReader(repo.driver);
      const set = yield* reader.read({
        cwd: repo.cwd,
        layout: "github",
        refCandidates: ["refs/heads/main"],
      });
      expect(set.templates).toEqual([]);
      expect(calls.map((call) => call.operation)).not.toContain("changeRequestTemplates.contents");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("cuts a long template at 8,000 bytes on a character boundary", () =>
    Effect.gen(function* () {
      // 7,999 ASCII bytes, then a two-byte character that would end at byte 8,001.
      const repo = yield* makeRepo({
        ".github/pull_request_template.md": `${"a".repeat(7_999)}é and more`,
      });
      const [template] = (yield* read(repo)).templates;
      expect(template?.truncated).toBe(true);
      expect(template?.body).toBe("a".repeat(7_999));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads GitLab's merge request templates with default.md as the default", () =>
    Effect.gen(function* () {
      const repo = yield* makeRepo({
        ".gitlab/merge_request_templates/Default.md": "GitLab default.",
        ".gitlab/merge_request_templates/bug.md": "GitLab bug.",
        ".gitlab/merge_request_templates/notes.txt": "Not a GitLab template.",
        ".github/pull_request_template.md": "GitHub only.",
      });
      const set = yield* read(repo, { layout: "gitlab" });
      expect(set.templates.map((template) => [template.name, template.isDefault])).toEqual([
        ["Default", true],
        ["bug", false],
      ]);
      expect(selectTemplateForGeneration(set, "gitlab")?.body).toBe("GitLab default.");
      const withoutDefault = yield* read(
        yield* makeRepo({ ".gitlab/merge_request_templates/bug.md": "Bug." }),
        { layout: "gitlab" },
      );
      expect(selectTemplateForGeneration(withoutDefault, "gitlab")).toBeNull();
    }).pipe(Effect.provide(layer)),
  );

  it.effect("answers a repeated read of the same tree with one git process", () =>
    Effect.gen(function* () {
      // Template directories in the usual spellings are listed with the roots: Git lists the
      // files of a directory a pathspec reaches into instead of the directory itself, so none
      // of these needs a second listing.
      const repo = yield* makeRepo({
        ".github/pull_request_template.md": DEFAULT_BODY,
        ".github/PULL_REQUEST_TEMPLATE/bug.md": "Bug.",
        "PULL_REQUEST_TEMPLATE/root.md": "Root.",
        "docs/pull_request_template/docs.md": "Docs.",
      });
      const { reader, calls } = makeCountingReader(repo.driver);
      const input = {
        cwd: repo.cwd,
        layout: "github" as const,
        refCandidates: changeRequestTemplateRefCandidates({
          baseBranch: "main",
          remoteName: "origin",
        }),
      };
      const cold = yield* reader.read(input);
      expect(cold.templates.map((template) => template.path)).toEqual([
        ".github/pull_request_template.md",
        ".github/PULL_REQUEST_TEMPLATE/bug.md",
        "PULL_REQUEST_TEMPLATE/root.md",
        "docs/pull_request_template/docs.md",
      ]);
      const coldCalls = calls.map((call) => call.operation);
      // A one-time Git version probe, then: resolve, list, sizes, contents.
      expect(coldCalls).toEqual([
        "changeRequestTemplates.gitVersion",
        "changeRequestTemplates.resolveTree",
        "changeRequestTemplates.listGitHub",
        "changeRequestTemplates.sizes",
        "changeRequestTemplates.contents",
      ]);
      calls.length = 0;
      const warm = yield* reader.read(input);
      expect(warm).toBe(cold);
      expect(calls.map((call) => call.operation)).toEqual(["changeRequestTemplates.resolveTree"]);
      // Every read is pinned against fetching and optional locks, and lists names only.
      expect(coldCalls).toHaveLength(5);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("never runs with lazy fetching on and never lists sizes", () =>
    Effect.gen(function* () {
      const repo = yield* makeRepo({ ".github/pull_request_template.md": DEFAULT_BODY });
      const inputs: Driver.ExecuteGitInput[] = [];
      const reader = makeChangeRequestTemplateReader({
        readConfigSnapshot: repo.driver.readConfigSnapshot,
        execute: (input) => {
          inputs.push(input);
          return repo.driver.execute(input);
        },
      });
      yield* reader.read({ cwd: repo.cwd, layout: "github", refCandidates: ["HEAD"] });
      expect(inputs.length).toBeGreaterThan(0);
      for (const input of inputs) {
        expect(input.env).toMatchObject({ GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" });
        expect(input.readOnly).toBe(true);
        expect(input.args).not.toContain("-l");
        expect(input.args).not.toContain("--long");
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads a blobless clone without fetching an unrelated missing blob", () =>
    Effect.gen(function* () {
      const { source, clone, present, templateBlob, unrelatedBlob } = yield* makeBloblessClone;
      expect(yield* present(templateBlob)).toBe(true);
      expect(yield* present(unrelatedBlob)).toBe(false);

      const set = yield* read(source, { cwd: clone, base: "main" });
      expect(set.templates.map((template) => template.body)).toEqual([DEFAULT_BODY.trim()]);
      expect(yield* present(unrelatedBlob)).toBe(false);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads nothing from a partial clone with a Git that would fetch", () =>
    Effect.gen(function* () {
      const { source, clone, present, unrelatedBlob } = yield* makeBloblessClone;
      const oldGit = (input: Driver.ExecuteGitInput) =>
        input.args[0] === "version"
          ? source.driver
              .execute({ ...input, args: ["--version"] })
              .pipe(Effect.map((result) => ({ ...result, stdout: "git version 2.39.5\n" })))
          : null;

      // Not a partial clone: an old Git reads as usual.
      const plain = makeCountingReader(source.driver, oldGit);
      const plainSet = yield* plain.reader.read({
        cwd: source.cwd,
        layout: "github",
        refCandidates: ["HEAD"],
      });
      expect(plainSet.templates).toHaveLength(1);

      // The clone's promisor remote marks it partial: nothing is read, so nothing can fetch.
      const partial = makeCountingReader(source.driver, oldGit);
      const partialSet = yield* partial.reader.read({
        cwd: clone,
        layout: "github",
        refCandidates: ["HEAD"],
      });
      expect(partialSet.templates).toEqual([]);
      expect(partial.calls.map((call) => call.operation)).toEqual([
        "changeRequestTemplates.gitVersion",
      ]);
      expect(yield* present(unrelatedBlob)).toBe(false);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("gives no templates when a read hangs past its time budget", () =>
    Effect.gen(function* () {
      const repo = yield* makeRepo({ ".github/pull_request_template.md": DEFAULT_BODY });
      const { reader } = makeCountingReader(repo.driver, (input) =>
        input.args[0] === "ls-tree" ? Effect.never : null,
      );
      const fiber = yield* reader
        .read({ cwd: repo.cwd, layout: "github", refCandidates: ["HEAD"] })
        .pipe(Effect.forkChild);
      // Let the read start (and arm its time budget) before the clock moves.
      yield* Effect.yieldNow;
      yield* TestClock.adjust("5 seconds");
      expect((yield* Fiber.join(fiber)).templates).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps a template through a server stall or machine sleep during the read", () =>
    Effect.gen(function* () {
      const repo = yield* makeRepo({ ".github/pull_request_template.md": DEFAULT_BODY });
      const clock = yield* makeStallableClock;
      const stalled = yield* Deferred.make<void>();
      const resumed = yield* Deferred.make<void>();
      // The loop is blocked for ten seconds, twice the read's budget, while git lists the tree;
      // git's answer is read only after every timer that expired meanwhile fired.
      const { reader } = makeCountingReader(repo.driver, (input) =>
        input.args[0] === "ls-tree"
          ? Effect.gen(function* () {
              clock.stall(10_000);
              yield* Deferred.succeed(stalled, undefined);
              yield* Deferred.await(resumed);
              return yield* repo.driver.execute(input);
            })
          : null,
      );
      const fiber = yield* clock
        .provide(reader.read({ cwd: repo.cwd, layout: "github", refCandidates: ["HEAD"] }))
        .pipe(Effect.forkChild);
      yield* Deferred.await(stalled);
      yield* TestClock.adjust("100 millis");
      yield* Deferred.succeed(resumed, undefined);
      expect((yield* Fiber.join(fiber)).templates.map((template) => template.body)).toEqual([
        DEFAULT_BODY.trim(),
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("gives no templates outside a repository or without a resolvable ref", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const driver = yield* Driver.GitVcsDriver;
      const empty = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-pr-templates-none-" });
      const { reader } = makeCountingReader(driver);
      expect(
        (yield* reader.read({ cwd: empty, layout: "github", refCandidates: ["HEAD"] })).templates,
      ).toEqual([]);
      const repo = yield* makeRepo({ ".github/pull_request_template.md": DEFAULT_BODY });
      expect(
        (yield* reader.read({ cwd: repo.cwd, layout: "github", refCandidates: [":/Summary"] }))
          .templates,
      ).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );
});

describe("change request templates", () => {
  it.effect("starts the dialog from the template a generated description follows", () =>
    Effect.gen(function* () {
      const repo = yield* makeRepo({
        ".gitlab/merge_request_templates/feature.md": "GitLab feature.",
        "PULL_REQUEST_TEMPLATE/only.md": "GitHub only.",
      });
      const templates = makeChangeRequestTemplates(repo.driver);
      const listed = (kind: "github" | "gitlab") =>
        templates.list({ cwd: repo.cwd, baseRefName: "main" }, Effect.succeed({ kind }));
      const followed = (kind: "github" | "gitlab") =>
        templates
          .withTemplate(Effect.succeed(undefined), {
            cwd: repo.cwd,
            host: { kind },
            baseBranch: "main",
            remoteName: "origin",
          })
          .pipe(Effect.map((policy) => policy?.changeRequestTemplate?.path ?? null));

      // GitHub follows its only template, in both places.
      const onGitHub = yield* listed("github");
      expect(onGitHub.templates.map((template) => template.path)).toEqual([
        "PULL_REQUEST_TEMPLATE/only.md",
      ]);
      expect(onGitHub.generationTemplatePath).toBe("PULL_REQUEST_TEMPLATE/only.md");
      expect(yield* followed("github")).toBe("PULL_REQUEST_TEMPLATE/only.md");

      // GitLab never applies a template other than default.md on its own, so neither does Ryco:
      // the dialog lists it without filling the description, and generation does not follow it.
      const onGitLab = yield* listed("gitlab");
      expect(onGitLab.templates.map((template) => template.path)).toEqual([
        ".gitlab/merge_request_templates/feature.md",
      ]);
      expect(onGitLab.generationTemplatePath).toBeNull();
      expect(yield* followed("gitlab")).toBeNull();
    }).pipe(Effect.provide(layer)),
  );
});

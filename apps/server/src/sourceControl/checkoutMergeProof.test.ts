import * as NodeServices from "@effect/platform-node/NodeServices";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect, Exit, Layer, Option, Scope } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { type ChangeRequest, SourceControlProviderError } from "@ryco/contracts";

import { ServerConfig } from "../config.ts";
import { GitVcsDriver, type GitVcsDriverShape } from "../vcs/GitVcsDriver.ts";
import { makeGitVcsDriverCore } from "../vcs/GitVcsDriverCore.ts";
import {
  CheckoutMergeProver,
  CheckoutMergeProverLive,
  type CheckoutMergeProverShape,
  mergeProofReads,
} from "./checkoutMergeProof.ts";
import { makeCheckoutMergeProver, pullRequestProvesMerge } from "./checkoutMergeProver.ts";
import type { SourceControlProviderShape } from "./SourceControlProvider.ts";
import {
  SourceControlProviderRegistry,
  type SourceControlProviderRegistryShape,
} from "./SourceControlProviderRegistry.ts";

const roots: string[] = [];
const scopes: Scope.Closeable[] = [];
afterEach(async () => {
  for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const HEAD = "a".repeat(40);

describe("pullRequestProvesMerge", () => {
  const merged = { state: "merged", baseRefName: "main", headSha: HEAD } as const;
  it.each([
    ["merged into the default branch at the same head", merged, true],
    ["the forge spells the head in capitals", { ...merged, headSha: HEAD.toUpperCase() }, true],
    ["merged at another head (more commits since)", { ...merged, headSha: "b".repeat(40) }, false],
    ["merged into another branch (a stacked parent)", { ...merged, baseRefName: "feature" }, false],
    ["closed without merging", { ...merged, state: "closed" }, false],
    ["still open", { ...merged, state: "open" }, false],
    ["no head commit (a lean listing row)", { state: "merged", baseRefName: "main" }, false],
    ["an abbreviated head", { ...merged, headSha: HEAD.slice(0, 12) }, false],
  ] as const)("%s", (_name, pr, expected) => {
    expect(pullRequestProvesMerge(pr, { head: HEAD, defaultBranch: "main" })).toBe(expected);
  });
});

/** A project with an `origin` remote that is never contacted: its refs are set by hand. */
function repository() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ryco-merge-proof-")));
  roots.push(root);
  const repo = path.join(root, "repo");
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  const commit = (cwd: string, message: string) => {
    git(
      cwd,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      message,
    );
    return git(cwd, "rev-parse", "HEAD");
  };
  git(root, "init", "-b", "main", repo);
  commit(repo, "base");
  git(repo, "remote", "add", "origin", "https://example.invalid/never-fetched.git");
  return { root, repo, git, commit };
}

/** The real Git driver against the fixture, and a forge registry the test controls. */
const proverFor = (
  fixture: ReturnType<typeof repository>,
  provider: Partial<SourceControlProviderShape>,
  now?: () => number,
) =>
  Effect.gen(function* () {
    // The driver's caches live as long as the test.
    const scope = Scope.makeUnsafe();
    scopes.push(scope);
    const git = yield* makeGitVcsDriverCore().pipe(Scope.provide(scope));
    const providers: Pick<SourceControlProviderRegistryShape, "resolve"> = {
      resolve: () => Effect.succeed(provider as SourceControlProviderShape),
    };
    return makeCheckoutMergeProver({ git, providers, ...(now ? { now } : {}) });
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(fixture.repo, path.join(fixture.root, "server")).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

const changeRequest = (overrides: Partial<ChangeRequest>): ChangeRequest => ({
  provider: "github",
  number: 7,
  title: "Fixture",
  url: "https://example.invalid/pull/7",
  baseRefName: "main",
  headRefName: "topic",
  state: "merged",
  updatedAt: Option.none(),
  ...overrides,
});

/** A forge that answers `getChangeRequest` and counts reads; listings must never be asked. */
const forge = (answer: () => Effect.Effect<ChangeRequest, SourceControlProviderError>) => {
  const calls = { getChangeRequest: 0, getDefaultBranch: 0 };
  const provider: Partial<SourceControlProviderShape> = {
    kind: "github",
    getChangeRequest: () =>
      Effect.suspend(() => {
        calls.getChangeRequest++;
        return answer();
      }),
    getDefaultBranch: () =>
      Effect.sync(() => {
        calls.getDefaultBranch++;
        return "main";
      }),
    listChangeRequests: () => Effect.die(new Error("The merge proof never reads listings.")),
  };
  return { calls, provider };
};

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const rateLimited = () =>
  Effect.fail(
    new SourceControlProviderError({
      provider: "github",
      operation: "getChangeRequest",
      detail: "API rate limit exceeded",
    }),
  );

describe("checkout merge prover", () => {
  it("proves a commit the remote default branch contains while local main is behind", async () => {
    const f = repository();
    f.git(f.repo, "switch", "-c", "topic");
    const head = f.commit(f.repo, "landed upstream");
    f.git(f.repo, "switch", "main");
    f.git(f.repo, "update-ref", "refs/remotes/origin/main", head);
    f.git(f.repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    const { calls, provider } = forge(() => Effect.die(new Error("no forge read expected")));
    const prover = await run(proverFor(f, provider));
    expect(
      await run(prover.prove({ projectRoot: f.repo, head, pullRequest: null, reads: null })),
    ).toEqual({ kind: "default-branch", head, ref: "origin/main" });

    f.git(f.repo, "switch", "topic");
    const local = f.commit(f.repo, "only here");
    expect(
      await run(prover.prove({ projectRoot: f.repo, head: local, pullRequest: null, reads: null })),
    ).toBeNull();
    // A listing reads the containment once for every branch.
    const listing = await run(prover.remoteDefaultBranches(f.repo));
    expect(listing).toMatchObject({ ref: "origin/main", branch: "main" });
    expect([...listing!.outside]).toEqual(["topic"]);
    expect(calls.getChangeRequest).toBe(0);
  });

  it("proves a squash-merged pull request at the same head with one forge read, then remembers it", async () => {
    const f = repository();
    f.git(f.repo, "update-ref", "refs/remotes/origin/main", f.git(f.repo, "rev-parse", "HEAD"));
    f.git(f.repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    f.git(f.repo, "switch", "-c", "topic");
    const head = f.commit(f.repo, "squash-merged work");
    const { calls, provider } = forge(() => Effect.succeed(changeRequest({ headSha: head })));
    const prover = await run(proverFor(f, provider));
    const input = {
      projectRoot: f.repo,
      head,
      pullRequest: { number: 7, state: "merged" as const },
    };
    // Listings without reads left (or none at all) only use what is known.
    expect(await run(prover.prove({ ...input, reads: null }))).toBeNull();
    expect(await run(prover.prove({ ...input, reads: mergeProofReads(0, 10_000) }))).toBeNull();
    expect(calls.getChangeRequest).toBe(0);

    const proof = { kind: "pull-request", head, number: 7, baseRefName: "main" };
    expect(await run(prover.prove({ ...input, reads: mergeProofReads(1, 10_000) }))).toEqual(proof);
    expect(await run(prover.prove({ ...input, reads: null }))).toEqual(proof);
    expect(calls.getChangeRequest).toBe(1);
    // A commit after the merge is not covered.
    const later = f.commit(f.repo, "after the merge");
    expect(
      await run(prover.prove({ ...input, head: later, reads: mergeProofReads(1, 10_000) })),
    ).toBeNull();
    expect(calls.getChangeRequest).toBe(1);
  });

  it("asks the forge only for a link the workspace already records as merged", async () => {
    const f = repository();
    const head = f.git(f.repo, "rev-parse", "HEAD");
    const { calls, provider } = forge(() => Effect.succeed(changeRequest({ headSha: head })));
    const prover = await run(proverFor(f, provider));
    for (const pullRequest of [null, { number: 7, state: "open" as const }]) {
      expect(
        await run(
          prover.prove({
            projectRoot: f.repo,
            head,
            pullRequest,
            reads: mergeProofReads(5, 10_000),
          }),
        ),
      ).toBeNull();
    }
    expect(calls.getChangeRequest).toBe(0);
  });

  it("finds no proof in a forge answer without the head commit, another base or an open state", async () => {
    const f = repository();
    f.git(f.repo, "update-ref", "refs/remotes/origin/main", f.git(f.repo, "rev-parse", "HEAD"));
    f.git(f.repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    f.git(f.repo, "switch", "-c", "topic");
    const head = f.commit(f.repo, "work");
    const answers: ChangeRequest[] = [
      // GitHub's lean listing fields carry no head commit.
      changeRequest({}),
      changeRequest({ headSha: head, baseRefName: "release" }),
      changeRequest({ headSha: head, state: "open" }),
    ];
    for (const answer of answers) {
      const { calls, provider } = forge(() => Effect.succeed(answer));
      const prover = await run(proverFor(f, provider));
      expect(
        await run(
          prover.prove({
            projectRoot: f.repo,
            head,
            pullRequest: { number: 7, state: "merged" },
            reads: mergeProofReads(1, 10_000),
          }),
        ),
      ).toBeNull();
      expect(calls.getChangeRequest).toBe(1);
    }
  });

  it("turns forge failures into no proof and asks again only after a pause", async () => {
    const f = repository();
    f.git(f.repo, "update-ref", "refs/remotes/origin/main", f.git(f.repo, "rev-parse", "HEAD"));
    f.git(f.repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    f.git(f.repo, "switch", "-c", "topic");
    const head = f.commit(f.repo, "work");
    let clock = 1_000_000;
    let fail = true;
    const { calls, provider } = forge(() =>
      fail ? rateLimited() : Effect.succeed(changeRequest({ headSha: head })),
    );
    const prover = await run(proverFor(f, provider, () => clock));
    const prove = () =>
      run(
        prover.prove({
          projectRoot: f.repo,
          head,
          pullRequest: { number: 7, state: "merged" },
          reads: { remaining: 1, deadline: clock + 10_000 },
        }),
      );
    expect(await prove()).toBeNull();
    fail = false;
    expect(await prove()).toBeNull();
    expect(calls.getChangeRequest).toBe(1);
    clock += 61_000;
    expect(await prove()).toMatchObject({ kind: "pull-request", number: 7 });
    expect(calls.getChangeRequest).toBe(2);
  });

  it("does not keep a read the caller's deadline cut short", async () => {
    const f = repository();
    f.git(f.repo, "update-ref", "refs/remotes/origin/main", f.git(f.repo, "rev-parse", "HEAD"));
    f.git(f.repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    f.git(f.repo, "switch", "-c", "topic");
    const head = f.commit(f.repo, "work");
    const { calls, provider } = forge(() =>
      Effect.sleep("200 millis").pipe(Effect.as(changeRequest({ headSha: head }))),
    );
    // A clock that stands still: the budgets below leave exactly what they say.
    const clock = 1_000_000;
    const prover = await run(proverFor(f, provider, () => clock));
    const input = {
      projectRoot: f.repo,
      head,
      pullRequest: { number: 7, state: "merged" as const },
    };
    // The last of a listing's reads, with 20 ms of its deadline left: no answer in time.
    expect(
      await run(prover.prove({ ...input, reads: { remaining: 1, deadline: clock + 20 } })),
    ).toBeNull();
    expect(calls.getChangeRequest).toBe(1);
    // A review with a read of its own asks again instead of reusing that non-answer.
    expect(
      await run(prover.prove({ ...input, reads: { remaining: 1, deadline: clock + 10_000 } })),
    ).toMatchObject({ kind: "pull-request", number: 7 });
    expect(calls.getChangeRequest).toBe(2);
  });

  it("asks the forge for the default branch when Git has no remote HEAD", async () => {
    const f = repository();
    f.git(f.repo, "switch", "-c", "topic");
    const head = f.commit(f.repo, "work");
    const { calls, provider } = forge(() => Effect.succeed(changeRequest({ headSha: head })));
    const prover = await run(proverFor(f, provider));
    const input = {
      projectRoot: f.repo,
      head,
      pullRequest: { number: 7, state: "merged" as const },
    };
    // One read covers the pull request, not the default branch too.
    expect(await run(prover.prove({ ...input, reads: mergeProofReads(1, 10_000) }))).toBeNull();
    expect(await run(prover.prove({ ...input, reads: mergeProofReads(1, 10_000) }))).toMatchObject({
      kind: "pull-request",
      baseRefName: "main",
    });
    expect(calls).toEqual({ getChangeRequest: 1, getDefaultBranch: 1 });
    expect(await run(prover.remoteDefaultBranches(f.repo))).toBeNull();
  });

  it("is provided by its layer and loads the implementation on first use", async () => {
    const f = repository();
    const head = f.git(f.repo, "rev-parse", "HEAD");
    const executed: string[][] = [];
    const git = {
      execute: (input: Parameters<GitVcsDriverShape["execute"]>[0]) =>
        Effect.sync(() => {
          executed.push([...input.args]);
          return {
            // `symbolic-ref` names origin/main; `merge-base --is-ancestor` says it contains it.
            exitCode: 0,
            stdout: input.args.includes("symbolic-ref") ? "refs/remotes/origin/main\n" : "",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          } as never;
        }),
      resolvePrimaryRemoteName: () => Effect.succeed("origin"),
    } as unknown as GitVcsDriverShape;
    const layer = CheckoutMergeProverLive.pipe(
      Layer.provide(Layer.succeed(GitVcsDriver, git)),
      Layer.provide(
        Layer.succeed(SourceControlProviderRegistry, {
          resolve: () => Effect.die(new Error("no forge read expected")),
        } as unknown as SourceControlProviderRegistryShape),
      ),
    );
    const proof = await Effect.runPromise(
      Effect.gen(function* () {
        const prover: CheckoutMergeProverShape = yield* CheckoutMergeProver;
        return yield* prover.prove({ projectRoot: f.repo, head, pullRequest: null, reads: null });
      }).pipe(Effect.provide(layer)),
    );
    expect(proof).toEqual({ kind: "default-branch", head, ref: "origin/main" });
    expect(executed.some((args) => args.includes("merge-base"))).toBe(true);
  });
});

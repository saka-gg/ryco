import * as NodeServices from "@effect/platform-node/NodeServices";
import { execFileSync } from "node:child_process";
import * as NodeOS from "node:os";
import { assert, describe, it } from "@effect/vitest";
import { parseWorktreeStatus } from "@ryco/shared/workspaceLifecycle";
import { Effect, FileSystem, Path } from "effect";

import {
  checkPortAvailabilityOnHosts,
  claimWorktreeDevHome,
  createDevRunnerEnv,
  DEV_RUNNER_ENV_ENV,
  DEV_RUNNER_ROOT_ENV,
  FETCH_BLOCKED_PORTS,
  findFirstAvailableOffset,
  planDevRun,
  planDevSeed,
  pruneDevHomes,
  resolveDevHome,
  resolveLinkedWorktree,
  resolveModePortOffsets,
  resolveOffset,
  stripInheritedDevRunnerEnv,
  worktreeDevHomeName,
} from "./dev-runner.ts";

/** Resolves to the linked worktree's root, or `undefined`. */
const resolveLinkedWorktreeRoot = (repoRoot: string) =>
  resolveLinkedWorktree(repoRoot).pipe(Effect.map((worktree) => worktree?.root));

const allPortsFree = () => Effect.succeed(true);

const dryRunInput = (mode: "dev" | "dev:server" | "dev:web" | "dev:desktop") => ({
  mode,
  rycoHome: undefined,
  noBrowser: undefined,
  autoBootstrapProjectFromCwd: undefined,
  logWebSocketEvents: undefined,
  host: undefined,
  port: undefined,
  devUrl: undefined,
  seed: undefined,
  dryRun: true,
  turboArgs: [],
});

/**
 * A checkout. `main` has a `.git` directory. `gitFile` writes that `.git` file as given. `gitDir`
 * creates that git dir (relative to a temp base) with the `commondir` file git writes for a linked
 * worktree (`../..` unless given; `null` writes none), and a `.git` file pointing at it.
 */
const makeCheckout = (
  kind:
    | "main"
    | { readonly gitFile: string }
    | {
        readonly gitDir: string;
        readonly commondir?: string | null;
        readonly lineEnding?: string;
      },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-dev-runner-checkout-" });
    const root = path.join(base, "checkout");
    yield* fs.makeDirectory(root);
    if (kind === "main") {
      yield* fs.makeDirectory(path.join(root, ".git"));
    } else if ("gitFile" in kind) {
      yield* fs.writeFileString(path.join(root, ".git"), kind.gitFile);
    } else {
      const gitDir = path.join(base, kind.gitDir);
      yield* fs.makeDirectory(gitDir, { recursive: true });
      if (kind.commondir !== null) {
        yield* fs.writeFileString(path.join(gitDir, "commondir"), kind.commondir ?? "../..\n");
      }
      yield* fs.writeFileString(
        path.join(root, ".git"),
        `gitdir: ${gitDir}${kind.lineEnding ?? "\n"}`,
      );
    }
    return { root, realRoot: yield* fs.realPath(root) };
  });

const linkedWorktree = { gitDir: "repo/.git/worktrees/feature" } as const;

/** Runs git without the person's config, so hooks, signing and templates change nothing. */
const git = (cwd: string, args: ReadonlyArray<string>) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Dev Runner Test",
      "-c",
      "user.email=dev-runner@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
        ),
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    },
  );

/**
 * A real repository at `<base>/repo` whose .gitignore does not mention any dev home (a commit cut
 * before worktree homes existed), with linked worktrees at `<base>/<name>`, and a dev homes root at
 * `<base>/dev-homes`.
 */
const makeGitRepository = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "ryco-dev-runner-git-" }),
  );
  const repo = path.join(base, "repo");
  yield* fs.makeDirectory(repo);
  git(repo, ["init", "-q"]);
  yield* fs.writeFileString(path.join(repo, ".gitignore"), "node_modules\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  const addWorktree = (name: string) =>
    Effect.gen(function* () {
      const root = path.join(base, name);
      git(repo, ["worktree", "add", "-q", "-b", name, root]);
      const worktree = yield* resolveLinkedWorktree(root);
      assert.ok(worktree !== undefined);
      return worktree;
    });
  return { base, repo, devHomesRoot: path.join(base, "dev-homes"), addWorktree };
});

it.layer(NodeServices.layer)("dev-runner", (it) => {
  describe("resolveLinkedWorktreeRoot", () => {
    it.effect("returns undefined for a main checkout and for no git at all", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const main = yield* makeCheckout("main");
        assert.equal(yield* resolveLinkedWorktreeRoot(main.root), undefined);
        const bare = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-dev-runner-nogit-" });
        assert.equal(yield* resolveLinkedWorktreeRoot(bare), undefined);
      }).pipe(Effect.scoped),
    );

    it.effect("returns the real root of a linked worktree, including a bare repo's", () =>
      Effect.gen(function* () {
        const linked = yield* makeCheckout(linkedWorktree);
        assert.equal(yield* resolveLinkedWorktreeRoot(linked.root), linked.realRoot);
        const bare = yield* makeCheckout({ gitDir: "repo.git/worktrees/feature" });
        assert.equal(yield* resolveLinkedWorktreeRoot(bare.root), bare.realRoot);
        const crlf = yield* makeCheckout({ ...linkedWorktree, lineEnding: "\r\n" });
        assert.equal(yield* resolveLinkedWorktreeRoot(crlf.root), crlf.realRoot);
        // Git >= 2.48 can write relative paths (worktree.useRelativePaths).
        const relative = yield* makeCheckout({
          gitFile: "gitdir: ../repo/.git/worktrees/feature\n",
        });
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const relativeGitDir = path.join(
          relative.root,
          "..",
          "repo",
          ".git",
          "worktrees",
          "feature",
        );
        yield* fs.makeDirectory(relativeGitDir, { recursive: true });
        yield* fs.writeFileString(path.join(relativeGitDir, "commondir"), "../..\n");
        assert.equal(yield* resolveLinkedWorktreeRoot(relative.root), relative.realRoot);
      }).pipe(Effect.scoped),
    );

    it.effect("ignores submodules and unreadable pointers", () =>
      Effect.gen(function* () {
        const submodule = yield* makeCheckout({ gitDir: "repo/.git/modules/sub", commondir: null });
        assert.equal(yield* resolveLinkedWorktreeRoot(submodule.root), undefined);
        // A submodule checked out at `worktrees/<name>`: the path looks like a worktree's, but
        // its git dir has no commondir.
        const lookalike = yield* makeCheckout({
          gitDir: "repo/.git/modules/worktrees/foo",
          commondir: null,
        });
        assert.equal(yield* resolveLinkedWorktreeRoot(lookalike.root), undefined);
        // A commondir that does not lead back to the parent of `worktrees/`.
        const elsewhere = yield* makeCheckout({ ...linkedWorktree, commondir: "../../../other\n" });
        assert.equal(yield* resolveLinkedWorktreeRoot(elsewhere.root), undefined);
        const garbage = yield* makeCheckout({ gitFile: "not a pointer\n" });
        assert.equal(yield* resolveLinkedWorktreeRoot(garbage.root), undefined);
      }).pipe(Effect.scoped),
    );
  });

  describe("resolveDevHome", () => {
    it.effect("prefers an explicit home, then the worktree's own, then the shared default", () =>
      Effect.gen(function* () {
        const devHomesRoot = "/home/.ryco/dev-homes";
        assert.deepStrictEqual(
          yield* resolveDevHome({ explicitHome: " /tmp/x ", worktreeRoot: "/wt", devHomesRoot }),
          { home: "/tmp/x", source: "explicit" },
        );
        assert.deepStrictEqual(
          yield* resolveDevHome({ explicitHome: "  ", worktreeRoot: "/wt", devHomesRoot }),
          { home: `/home/.ryco/dev-homes/${worktreeDevHomeName("/wt")}`, source: "worktree" },
        );
        assert.deepStrictEqual(
          yield* resolveDevHome({ explicitHome: undefined, worktreeRoot: undefined, devHomesRoot }),
          { home: undefined, source: "default" },
        );
      }),
    );

    it("names a worktree's home after its folder and a hash of its path", () => {
      assert.match(worktreeDevHomeName("/code/wt/feature x"), /^feature_x-[0-9a-f]{12}$/);
      assert.notEqual(worktreeDevHomeName("/a/feature"), worktreeDevHomeName("/b/feature"));
      assert.equal(worktreeDevHomeName("/a/feature"), worktreeDevHomeName("/a/feature"));
    });
  });

  describe("worktree homes", () => {
    it.effect("keep a worktree's database and secrets out of its checkout", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const repository = yield* makeGitRepository;
        const worktree = yield* repository.addWorktree("feature");
        const plan = yield* planDevRun(dryRunInput("dev:server"), {
          repoRoot: worktree.root,
          baseEnv: {},
          portOffset: undefined,
          devInstance: undefined,
          seedSource: path.join(repository.base, "missing.sqlite"),
          devHomesRoot: repository.devHomesRoot,
          checkPortAvailability: allPortsFree,
        });
        assert.equal(plan.homeSource, "worktree");
        assert.ok(path.relative(worktree.root, plan.home).startsWith(".."), plan.home);

        // What the seed and the server write there.
        yield* claimWorktreeDevHome(plan.home, worktree);
        yield* fs.makeDirectory(path.join(plan.home, "dev", "secrets"), { recursive: true });
        yield* fs.writeFileString(path.join(plan.home, "dev", "state.sqlite"), "db");
        yield* fs.writeFileString(
          path.join(plan.home, "dev", "secrets", "server-signing-key"),
          "k",
        );

        // Ryco's checkout inspection finds nothing to protect, so the checkout stays removable.
        const status = git(worktree.root, [
          "-c",
          "core.fsmonitor=false",
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
          "--ignored=matching",
        ]);
        assert.equal(status, "");
        assert.deepStrictEqual(parseWorktreeStatus(status).protectedIgnored, []);
        // And with a .gitignore that does not mention the home, nothing of it can be committed.
        assert.equal(git(worktree.root, ["add", "-A", "--dry-run"]), "");
      }).pipe(Effect.scoped),
    );

    it.effect("are removed once git has forgotten their worktree, and only then", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const repository = yield* makeGitRepository;
        const homeOf = (worktree: { readonly root: string }) =>
          path.join(repository.devHomesRoot, worktreeDevHomeName(worktree.root));
        const removed = yield* repository.addWorktree("removed");
        const deleted = yield* repository.addWorktree("deleted");
        const kept = yield* repository.addWorktree("kept");
        const current = yield* repository.addWorktree("current");
        for (const worktree of [removed, deleted, kept, current]) {
          yield* claimWorktreeDevHome(homeOf(worktree), worktree);
        }
        // A directory nobody claimed, and a claim copied under another name.
        const unclaimed = path.join(repository.devHomesRoot, "unclaimed");
        yield* fs.makeDirectory(unclaimed);
        const misnamed = path.join(repository.devHomesRoot, "misnamed");
        yield* fs.makeDirectory(misnamed);
        yield* fs.copyFile(
          path.join(homeOf(removed), "worktree.json"),
          path.join(misnamed, "worktree.json"),
        );
        // A worktree whose repository is gone as well, as on an unmounted disk.
        const unmounted = {
          root: path.join(repository.base, "elsewhere", "wt"),
          gitDir: path.join(repository.base, "elsewhere", "repo", ".git", "worktrees", "wt"),
          commonDir: path.join(repository.base, "elsewhere", "repo", ".git"),
        };
        yield* claimWorktreeDevHome(homeOf(unmounted), unmounted);

        git(repository.repo, ["worktree", "remove", removed.root]);
        // Checkouts deleted by hand, then forgotten with `git worktree prune`.
        yield* fs.remove(deleted.root, { recursive: true });
        yield* fs.remove(current.root, { recursive: true });
        git(repository.repo, ["worktree", "prune"]);
        // Deleted by hand but still registered.
        yield* fs.remove(kept.root, { recursive: true });

        assert.deepStrictEqual(
          (yield* pruneDevHomes(repository.devHomesRoot, homeOf(current))).toSorted(),
          [homeOf(deleted), homeOf(removed)].toSorted(),
        );
        for (const home of [
          homeOf(kept),
          homeOf(current),
          homeOf(unmounted),
          unclaimed,
          misnamed,
        ]) {
          assert.ok(yield* fs.exists(home), home);
        }
        assert.ok(!(yield* fs.exists(homeOf(removed))));
        // Once git forgets `kept` too, its home goes.
        git(repository.repo, ["worktree", "prune"]);
        assert.deepStrictEqual(yield* pruneDevHomes(repository.devHomesRoot, homeOf(current)), [
          homeOf(kept),
        ]);
        // No dev homes yet: nothing to do.
        assert.deepStrictEqual(
          yield* pruneDevHomes(path.join(repository.base, "no-dev-homes"), undefined),
          [],
        );
      }).pipe(Effect.scoped),
    );
  });

  describe("planDevSeed", () => {
    const base = {
      mode: "dev" as const,
      homeSource: "worktree" as const,
      seed: undefined,
      source: "/home/.ryco/dev/state.sqlite",
      sourceExists: true,
      stateDir: "/home/.ryco/dev-homes/wt-1/dev",
      targetExists: false,
    };

    it("seeds only a new worktree home of a mode that starts a server", () => {
      assert.deepStrictEqual(planDevSeed(base), {
        action: "seed",
        reason: "would seed from /home/.ryco/dev/state.sqlite",
        source: "/home/.ryco/dev/state.sqlite",
        stateDir: "/home/.ryco/dev-homes/wt-1/dev",
      });
      assert.equal(planDevSeed({ ...base, mode: "dev:desktop" }).action, "seed");
      assert.equal(planDevSeed({ ...base, seed: true }).action, "seed");
    });

    it("skips every other case", () => {
      const skips = [
        { ...base, mode: "dev:web" as const },
        { ...base, homeSource: "explicit" as const },
        { ...base, homeSource: "default" as const },
        { ...base, seed: false },
        { ...base, targetExists: true },
        { ...base, sourceExists: false },
      ];
      for (const input of skips) {
        assert.equal(planDevSeed(input).action, "skip", JSON.stringify(input));
      }
    });
  });

  describe("stripInheritedDevRunnerEnv", () => {
    it.effect("removes everything a dev server handed out, and only that", () =>
      Effect.gen(function* () {
        const serverEnv = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: { PATH: "/bin", RYCO_PORT_OFFSET: "4" },
          serverOffset: 0,
          webOffset: 0,
          rycoHome: "/home/.ryco/dev-homes/wt-1",
          noBrowser: true,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
          repoRoot: "/wt",
        });
        assert.equal(serverEnv[DEV_RUNNER_ROOT_ENV], "/wt");
        assert.ok(serverEnv[DEV_RUNNER_ENV_ENV] !== undefined);

        // An agent of that server runs `bun dev` as is: nothing of the server's survives.
        const nested = stripInheritedDevRunnerEnv(serverEnv);
        assert.deepStrictEqual(nested.kept, []);
        assert.deepStrictEqual(nested.env, { PATH: "/bin", RYCO_PORT_OFFSET: "4" });
        assert.equal(nested.inheritedHome, "/home/.ryco/dev-homes/wt-1");

        // `RYCO_HOME=/tmp/iso bun run dev` in the agent's shell keeps the typed home.
        const typed = stripInheritedDevRunnerEnv({ ...serverEnv, RYCO_HOME: "/tmp/iso" });
        assert.deepStrictEqual(typed.kept, ["RYCO_HOME"]);
        assert.equal(typed.env.RYCO_HOME, "/tmp/iso");
        assert.equal(typed.env.RYCO_PORT, undefined);
        assert.equal(typed.env[DEV_RUNNER_ROOT_ENV], undefined);
        assert.equal(typed.env[DEV_RUNNER_ENV_ENV], undefined);
        // The shared-home warning compares against the server's home, not the typed one.
        assert.equal(typed.inheritedHome, "/home/.ryco/dev-homes/wt-1");
      }),
    );

    it("removes every listed setting when the record is missing or unreadable", () => {
      const result = stripInheritedDevRunnerEnv({
        [DEV_RUNNER_ROOT_ENV]: "/other",
        RYCO_HOME: "/home/.ryco",
        RYCO_PORT: "13790",
        VITE_DEV_SERVER_URL: "http://localhost:5750",
        RYCO_PORT_OFFSET: "4",
        PATH: "/bin",
      });
      assert.deepStrictEqual(result.stripped, [
        "RYCO_HOME",
        "RYCO_PORT",
        "VITE_DEV_SERVER_URL",
        DEV_RUNNER_ROOT_ENV,
      ]);
      assert.deepStrictEqual(result.env, { RYCO_PORT_OFFSET: "4", PATH: "/bin" });
      assert.equal(result.inheritedFrom, "/other");
      assert.equal(result.inheritedHome, "/home/.ryco");

      const unreadable = stripInheritedDevRunnerEnv({
        [DEV_RUNNER_ROOT_ENV]: "/other",
        [DEV_RUNNER_ENV_ENV]: '{"RYCO_HOME": 1}',
        RYCO_HOME: "/tmp/x",
      });
      assert.deepStrictEqual(unreadable.stripped, [
        "RYCO_HOME",
        DEV_RUNNER_ROOT_ENV,
        DEV_RUNNER_ENV_ENV,
      ]);
      assert.deepStrictEqual(unreadable.kept, []);
    });

    it("also removes them when a dev server of this checkout passed them on", () => {
      const result = stripInheritedDevRunnerEnv({
        [DEV_RUNNER_ROOT_ENV]: "/repo",
        RYCO_PORT: "13790",
      });
      assert.deepStrictEqual(result.stripped, ["RYCO_PORT", DEV_RUNNER_ROOT_ENV]);
    });

    it("keeps a person's own settings", () => {
      const env = { RYCO_HOME: "/tmp/x", RYCO_PORT: "4000" };
      const result = stripInheritedDevRunnerEnv(env);
      assert.deepStrictEqual(result.stripped, []);
      assert.equal(result.env, env);
    });
  });

  describe("planDevRun", () => {
    it.effect("gives a linked worktree its own home, ports and runner marker", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const linked = yield* makeCheckout(linkedWorktree);
        const devHomesRoot = path.join(path.dirname(linked.realRoot), "dev-homes");
        const plan = yield* planDevRun(dryRunInput("dev:server"), {
          repoRoot: linked.root,
          baseEnv: {},
          portOffset: undefined,
          devInstance: undefined,
          seedSource: path.join(linked.root, "missing.sqlite"),
          devHomesRoot,
          checkPortAvailability: allPortsFree,
        });
        const expectedOffset = resolveOffset({
          portOffset: undefined,
          devInstance: undefined,
          worktreeRoot: linked.realRoot,
        }).offset;

        assert.equal(plan.homeSource, "worktree");
        const home = path.join(devHomesRoot, worktreeDevHomeName(linked.realRoot));
        assert.equal(plan.home, home);
        assert.equal(plan.env.RYCO_HOME, home);
        assert.equal(plan.env[DEV_RUNNER_ROOT_ENV], linked.root);
        assert.equal(plan.source, `worktree ${linked.realRoot}`);
        assert.ok(plan.offset >= 1);
        assert.equal(plan.offset, expectedOffset);
        assert.equal(plan.env.RYCO_PORT, String(13773 + plan.serverOffset));
        assert.deepStrictEqual(plan.seedPlan.action, "skip");
      }).pipe(Effect.scoped),
    );

    it.effect("plans a seed for a new worktree home when the source exists", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const linked = yield* makeCheckout(linkedWorktree);
        const devHomesRoot = path.join(path.dirname(linked.realRoot), "dev-homes");
        const stateDir = path.join(devHomesRoot, worktreeDevHomeName(linked.realRoot), "dev");
        const source = path.join(linked.root, "source.sqlite");
        yield* fs.writeFileString(source, "");
        const plan = yield* planDevRun(dryRunInput("dev"), {
          repoRoot: linked.root,
          baseEnv: {},
          portOffset: undefined,
          devInstance: undefined,
          seedSource: source,
          devHomesRoot,
          checkPortAvailability: allPortsFree,
        });
        assert.deepStrictEqual(plan.seedPlan, {
          action: "seed",
          reason: `would seed from ${source}`,
          source,
          stateDir,
        });

        // Once the home has a database, later starts never seed again.
        yield* fs.makeDirectory(stateDir, { recursive: true });
        yield* fs.writeFileString(path.join(stateDir, "state.sqlite-wal"), "");
        const again = yield* planDevRun(dryRunInput("dev"), {
          repoRoot: linked.root,
          baseEnv: {},
          portOffset: undefined,
          devInstance: undefined,
          seedSource: source,
          devHomesRoot,
          checkPortAvailability: allPortsFree,
        });
        assert.equal(again.seedPlan.action, "skip");
      }).pipe(Effect.scoped),
    );

    it.effect("keeps the main checkout on ~/.ryco and the default ports", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const main = yield* makeCheckout("main");
        const plan = yield* planDevRun(dryRunInput("dev"), {
          repoRoot: main.root,
          baseEnv: {},
          portOffset: undefined,
          devInstance: undefined,
          seedSource: undefined,
          checkPortAvailability: allPortsFree,
        });
        assert.equal(plan.homeSource, "default");
        assert.equal(plan.env.RYCO_HOME, path.join(NodeOS.homedir(), ".ryco"));
        assert.equal(plan.offset, 0);
        assert.equal(plan.env.RYCO_PORT, "13773");
        assert.equal(plan.env.PORT, "5733");
        assert.equal(plan.seedPlan.action, "skip");
      }).pipe(Effect.scoped),
    );

    it.effect("lets an explicit home and offset win in a linked worktree", () =>
      Effect.gen(function* () {
        const linked = yield* makeCheckout(linkedWorktree);
        const plan = yield* planDevRun(
          { ...dryRunInput("dev"), rycoHome: "/tmp/ryco-explicit" },
          {
            repoRoot: linked.root,
            baseEnv: {},
            portOffset: 12,
            devInstance: undefined,
            seedSource: undefined,
            checkPortAvailability: allPortsFree,
          },
        );
        assert.equal(plan.homeSource, "explicit");
        assert.equal(plan.env.RYCO_HOME, "/tmp/ryco-explicit");
        assert.equal(plan.offset, 12);
        assert.equal(plan.seedPlan.action, "skip");
      }).pipe(Effect.scoped),
    );
  });

  describe("resolveOffset", () => {
    it.effect("derives a stable offset from a linked worktree's path", () =>
      Effect.sync(() => {
        // Pinned so an Effect upgrade that changes Hash.string is noticed: every
        // worktree's ports (and its dev cookie origin) would move.
        assert.deepStrictEqual(
          resolveOffset({
            portOffset: undefined,
            devInstance: undefined,
            worktreeRoot: "/Users/dev/ryco-worktrees/feature-a",
          }),
          { offset: 247, source: "worktree /Users/dev/ryco-worktrees/feature-a" },
        );
        assert.equal(
          resolveOffset({ portOffset: 12, devInstance: "x", worktreeRoot: "/wt" }).offset,
          12,
        );
        assert.equal(
          resolveOffset({ portOffset: undefined, devInstance: "7", worktreeRoot: "/wt" }).source,
          "numeric RYCO_DEV_INSTANCE=7",
        );
        assert.deepStrictEqual(
          resolveOffset({ portOffset: undefined, devInstance: undefined, worktreeRoot: undefined }),
          { offset: 0, source: "default ports" },
        );
      }),
    );

    it.effect("uses explicit RYCO_PORT_OFFSET when provided", () =>
      Effect.sync(() => {
        const result = resolveOffset({
          portOffset: 12,
          devInstance: undefined,
        });
        assert.deepStrictEqual(result, {
          offset: 12,
          source: "RYCO_PORT_OFFSET=12",
        });
      }),
    );

    it.effect("hashes non-numeric instance values", () =>
      Effect.sync(() => {
        const result = resolveOffset({
          portOffset: undefined,
          devInstance: "feature-branch",
        });
        assert.ok(result.offset >= 1);
        assert.ok(result.offset <= 3000);
      }),
    );

    it.effect("throws for negative port offset", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          Effect.try({
            try: () => resolveOffset({ portOffset: -1, devInstance: undefined }),
            catch: (cause) => String(cause),
          }),
        );

        assert.ok(error.includes("Invalid RYCO_PORT_OFFSET"));
      }),
    );
  });

  describe("createDevRunnerEnv", () => {
    it.effect("defaults RYCO_HOME to ~/.ryco when not provided", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: {},
          serverOffset: 0,
          webOffset: 0,
          rycoHome: undefined,
          noBrowser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.RYCO_HOME, path.resolve(NodeOS.homedir(), ".ryco"));
      }),
    );

    it.effect("keeps Desktop Dev on the existing local backend catalog", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const env = yield* createDevRunnerEnv({
          mode: "dev:desktop",
          baseEnv: {},
          serverOffset: 0,
          webOffset: 0,
          rycoHome: undefined,
          noBrowser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.RYCO_HOME, path.resolve(NodeOS.homedir(), ".ryco"));
      }),
    );

    it.effect("supports explicit typed overrides", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const env = yield* createDevRunnerEnv({
          mode: "dev:server",
          baseEnv: {},
          serverOffset: 0,
          webOffset: 0,
          rycoHome: "/tmp/custom-ryco",
          noBrowser: true,
          autoBootstrapProjectFromCwd: false,
          logWebSocketEvents: true,
          host: "0.0.0.0",
          port: 4222,
          devUrl: new URL("http://localhost:7331"),
        });

        assert.equal(env.RYCO_HOME, path.resolve("/tmp/custom-ryco"));
        assert.equal(env.RYCO_PORT, "4222");
        assert.equal(env.VITE_HTTP_URL, "http://localhost:4222");
        assert.equal(env.VITE_WS_URL, "ws://localhost:4222");
        assert.equal(env.RYCO_NO_BROWSER, "1");
        assert.equal(env.RYCO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD, "0");
        assert.equal(env.RYCO_LOG_WS_EVENTS, "1");
        assert.equal(env.RYCO_HOST, "0.0.0.0");
        assert.equal(env.VITE_DEV_SERVER_URL, "http://localhost:7331/");
      }),
    );

    it.effect("does not force websocket logging on in dev mode when unset", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: {
            RYCO_LOG_WS_EVENTS: "keep-me-out",
          },
          serverOffset: 0,
          webOffset: 0,
          rycoHome: undefined,
          noBrowser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.RYCO_MODE, "web");
        assert.equal(env.RYCO_LOG_WS_EVENTS, undefined);
      }),
    );

    it.effect("forwards explicit websocket logging false without coercing it away", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: {
            RYCO_LOG_WS_EVENTS: "1",
          },
          serverOffset: 0,
          webOffset: 0,
          rycoHome: undefined,
          noBrowser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: false,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.RYCO_LOG_WS_EVENTS, "0");
      }),
    );

    it.effect("uses custom rycoHome when provided", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: {},
          serverOffset: 0,
          webOffset: 0,
          rycoHome: "/tmp/my-ryco",
          noBrowser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.RYCO_HOME, path.resolve("/tmp/my-ryco"));
      }),
    );

    it.effect("pins desktop dev to a stable backend port and websocket url", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const env = yield* createDevRunnerEnv({
          mode: "dev:desktop",
          baseEnv: {
            RYCO_PORT: "13773",
            RYCO_MODE: "web",
            RYCO_NO_BROWSER: "0",
            RYCO_HOST: "0.0.0.0",
            VITE_WS_URL: "ws://localhost:13773",
          },
          serverOffset: 0,
          webOffset: 0,
          rycoHome: "/tmp/my-ryco",
          noBrowser: true,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: "127.0.0.1",
          port: 4222,
          devUrl: undefined,
        });

        assert.equal(env.RYCO_HOME, path.resolve("/tmp/my-ryco"));
        assert.equal(env.PORT, "5733");
        assert.equal(env.VITE_DEV_SERVER_URL, "http://127.0.0.1:5733");
        assert.equal(env.HOST, "127.0.0.1");
        assert.equal(env.RYCO_PORT, "4222");
        assert.equal(env.VITE_HTTP_URL, "http://127.0.0.1:4222");
        assert.equal(env.RYCO_MODE, undefined);
        assert.equal(env.RYCO_NO_BROWSER, undefined);
        assert.equal(env.RYCO_HOST, undefined);
        assert.equal(env.VITE_WS_URL, "ws://127.0.0.1:4222");
      }),
    );

    it.effect("defaults dev server mode to the higher backend port range", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: {},
          serverOffset: 0,
          webOffset: 0,
          rycoHome: undefined,
          noBrowser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.RYCO_PORT, "13773");
        assert.equal(env.VITE_HTTP_URL, "http://localhost:13773");
        assert.equal(env.VITE_WS_URL, "ws://localhost:13773");
      }),
    );
  });

  describe("findFirstAvailableOffset", () => {
    it.effect("returns the starting offset when required ports are available", () =>
      Effect.gen(function* () {
        const offset = yield* findFirstAvailableOffset({
          startOffset: 0,
          requireServerPort: true,
          requireWebPort: true,
          checkPortAvailability: () => Effect.succeed(true),
        });

        assert.equal(offset, 0);
      }),
    );

    it.effect("advances until all required ports are available", () =>
      Effect.gen(function* () {
        const taken = new Set([13773, 5733, 13774, 5734]);
        const offset = yield* findFirstAvailableOffset({
          startOffset: 0,
          requireServerPort: true,
          requireWebPort: true,
          checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
        });

        assert.equal(offset, 2);
      }),
    );

    it.effect("skips web ports that browsers block", () =>
      Effect.gen(function* () {
        // 5733 + 267 = 6000 (X11), on the Fetch standard's bad-port list.
        assert.ok(FETCH_BLOCKED_PORTS.has(6000));
        const offset = yield* findFirstAvailableOffset({
          startOffset: 267,
          requireServerPort: false,
          requireWebPort: true,
          checkPortAvailability: allPortsFree,
        });
        assert.equal(offset, 268);

        // 6665-6669 are blocked in a row.
        const run = yield* findFirstAvailableOffset({
          startOffset: 6665 - 5733,
          requireServerPort: true,
          requireWebPort: true,
          checkPortAvailability: allPortsFree,
        });
        assert.equal(run, 6670 - 5733);
      }),
    );

    it.effect("allows offsets where the non-required server port exceeds max", () =>
      Effect.gen(function* () {
        const offset = yield* findFirstAvailableOffset({
          startOffset: 59_802,
          requireServerPort: false,
          requireWebPort: true,
          checkPortAvailability: () => Effect.succeed(true),
        });

        assert.equal(offset, 59_802);
      }),
    );
  });

  describe("turbo.json", () => {
    it.effect("forwards every variable the runner sets to the dev tasks", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // Turbo's strict env mode drops anything else, silently: the dev server
        // would never see it (and agents of it never see the runner marker).
        const text = yield* fs.readFileString(path.join(import.meta.dirname, "..", "turbo.json"));
        const turbo = JSON.parse(text.replace(/^\s*\/\/.*$/gm, "")) as {
          readonly globalEnv: ReadonlyArray<string>;
          readonly globalPassThroughEnv: ReadonlyArray<string>;
        };
        const forwarded = new Set([...turbo.globalEnv, ...turbo.globalPassThroughEnv]);
        for (const mode of ["dev", "dev:server", "dev:web", "dev:desktop"] as const) {
          const env = yield* createDevRunnerEnv({
            mode,
            baseEnv: {},
            serverOffset: 0,
            webOffset: 0,
            rycoHome: "/tmp/ryco-home",
            noBrowser: true,
            autoBootstrapProjectFromCwd: true,
            logWebSocketEvents: true,
            host: "127.0.0.1",
            port: 4000,
            devUrl: undefined,
            repoRoot: "/repo",
          });
          for (const key of Object.keys(env)) {
            assert.ok(
              forwarded.has(key),
              `${key} (${mode}) must be listed in turbo.json globalEnv or globalPassThroughEnv`,
            );
          }
        }
      }),
    );
  });

  describe("checkPortAvailabilityOnHosts", () => {
    it.effect("checks overlapping hosts sequentially to avoid self-interference", () =>
      Effect.gen(function* () {
        let inFlightCount = 0;
        const calls: Array<[number, string]> = [];

        const available = yield* checkPortAvailabilityOnHosts(
          13_773,
          ["127.0.0.1", "0.0.0.0", "::"],
          (port, host) =>
            Effect.promise(async () => {
              calls.push([port, host]);
              inFlightCount += 1;
              const overlapped = inFlightCount > 1;
              await Promise.resolve();
              inFlightCount -= 1;
              return !overlapped;
            }),
        );

        assert.equal(available, true);
        assert.deepStrictEqual(calls, [
          [13_773, "127.0.0.1"],
          [13_773, "0.0.0.0"],
          [13_773, "::"],
        ]);
      }),
    );
  });

  describe("resolveModePortOffsets", () => {
    it.effect("uses a shared fallback offset for dev mode", () =>
      Effect.gen(function* () {
        const taken = new Set([13773, 5733]);
        const offsets = yield* resolveModePortOffsets({
          mode: "dev",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: false,
          checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 1, webOffset: 1 });
      }),
    );

    it.effect("keeps server offset stable for dev:web and only shifts web offset", () =>
      Effect.gen(function* () {
        const taken = new Set([5733]);
        const offsets = yield* resolveModePortOffsets({
          mode: "dev:web",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: false,
          checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 0, webOffset: 1 });
      }),
    );

    it.effect("shifts only server offset for dev:server", () =>
      Effect.gen(function* () {
        const taken = new Set([13773]);
        const offsets = yield* resolveModePortOffsets({
          mode: "dev:server",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: false,
          checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 1, webOffset: 1 });
      }),
    );

    it.effect("respects explicit dev-url override for dev:web", () =>
      Effect.gen(function* () {
        const offsets = yield* resolveModePortOffsets({
          mode: "dev:web",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: true,
          checkPortAvailability: () => Effect.succeed(false),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 0, webOffset: 0 });
      }),
    );

    it.effect("respects explicit server port override for dev:server", () =>
      Effect.gen(function* () {
        const offsets = yield* resolveModePortOffsets({
          mode: "dev:server",
          startOffset: 0,
          hasExplicitServerPort: true,
          hasExplicitDevUrl: false,
          checkPortAvailability: () => Effect.succeed(false),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 0, webOffset: 0 });
      }),
    );
  });
});

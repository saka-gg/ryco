import { spawn, spawnSync } from "node:child_process";
import * as NodeFs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ProviderDriverKind, ProviderInstanceId } from "@ryco/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Layer, Option, Ref } from "effect";
import { TestClock } from "effect/testing";

import { makeProviderInstallLockLive } from "./Layers/ProviderInstallLock.ts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  makeProviderMaintenanceCapabilities,
} from "./providerMaintenance.ts";
import {
  BUSY_MARKER_REFRESH_INTERVAL,
  EXPIRED_TAKEOVER_GRACE,
  LAUNCH_WAIT,
  makeProviderInstallLock,
  nodeProviderInstallLockFiles,
  ProviderInstallLockError,
  providerInstallLockName,
  resolveProviderInstallLockDirectory,
  type ProviderInstallLockFiles,
} from "./providerInstallLock.ts";
import { ProviderInstallLock } from "./Services/ProviderInstallLock.ts";
import { ProviderRegistry } from "./Services/ProviderRegistry.ts";

const POSIX = process.platform !== "win32";

/** A temp root whose `provider-install` folder plays the host's lock folder. */
const withFolder = Effect.acquireRelease(
  Effect.promise(() => NodeFs.mkdtemp(path.join(tmpdir(), "ryco-install-lock-test-"))),
  (root) => Effect.promise(() => NodeFs.rm(root, { recursive: true, force: true })),
).pipe(
  Effect.map((root) => {
    const directory = path.join(root, "provider-install");
    return {
      root,
      directory,
      /** Two Ryco processes sharing the folder (records carry this process's pid). */
      first: makeProviderInstallLock({ directory }),
      second: makeProviderInstallLock({ directory }),
      lockWith: (files: Partial<ProviderInstallLockFiles>) =>
        makeProviderInstallLock({
          directory,
          files: { ...nodeProviderInstallLockFiles, ...files },
        }),
      record: (generation: number, key = "k") =>
        path.join(directory, `${providerInstallLockName(key)}.${generation}`),
    };
  }),
);

const fs = <A>(run: () => Promise<A>) => Effect.promise(run);
const names = (directory: string) =>
  fs(() => NodeFs.readdir(directory).then((all) => all.toSorted()));
const read = (file: string) => fs(() => NodeFs.readFile(file, "utf8"));
const writeAged = (file: string, contents: string) =>
  fs(async () => {
    await NodeFs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await NodeFs.writeFile(file, contents);
    // The test clock starts at the epoch: a record touched then is as old as the clock says.
    await NodeFs.utimes(file, 0, 0);
  });
const exitedPid = () => spawnSync(process.execPath, ["-e", ""]).pid!;
const CODEX = ProviderDriverKind.make("codex");
/** What the provider registry says about an instance whose installer takes `lockKey`. */
const installedWith = (lockKey: string) =>
  Effect.succeed(
    makeProviderMaintenanceCapabilities({
      provider: CODEX,
      packageName: "@openai/codex",
      updateExecutable: "npm",
      updateArgs: ["install", "-g", "@openai/codex@latest"],
      updateLockKey: lockKey,
    }),
  );

describe("providerInstallLock", () => {
  it.effect("holds a key against another process on the same folder, but not other keys", () =>
    Effect.gen(function* () {
      const { first, second } = yield* withFolder;
      const held = yield* first.tryRun("npm-global:/prefix", () =>
        Effect.gen(function* () {
          const sameKey = yield* second.tryRun("npm-global:/prefix", () => Effect.succeed(1));
          const otherKey = yield* second.tryRun("homebrew", () => Effect.succeed(2));
          return {
            sameKey,
            otherKey,
            anyHeld: yield* second.anyHeld,
            keyHeld: yield* second.isHeld("npm-global:/prefix"),
            otherHeld: yield* second.isHeld("homebrew"),
          };
        }),
      );
      assert.deepStrictEqual(Option.getOrThrow(held), {
        sameKey: Option.none(),
        otherKey: Option.some(2),
        anyHeld: true,
        keyHeld: true,
        otherHeld: false,
      });
      assert.isFalse(yield* second.anyHeld);
    }),
  );

  it.effect("elects exactly one of two contenders for a free lock", () =>
    Effect.gen(function* () {
      const { first, second } = yield* withFolder;
      for (let round = 0; round < 5; round += 1) {
        const runs = yield* Ref.make(0);
        // The winner holds the lock until the other contender has finished its attempt.
        const loserDone = yield* Deferred.make<void>();
        const attempt = (lock: typeof first) =>
          lock
            .tryRun("k", () =>
              Ref.update(runs, (count) => count + 1).pipe(
                Effect.andThen(Deferred.await(loserDone)),
              ),
            )
            .pipe(
              Effect.tap((result) =>
                Option.isNone(result) ? Deferred.succeed(loserDone, undefined) : Effect.void,
              ),
            );
        const results = yield* Effect.all([attempt(first), attempt(second)], {
          concurrency: "unbounded",
        });
        assert.strictEqual(results.filter(Option.isSome).length, 1);
        assert.strictEqual(yield* Ref.get(runs), 1);
      }
    }),
  );

  it.effect("reclaims a lock whose processes are gone, fresh or expired", () =>
    Effect.gen(function* () {
      const { directory, first, second, record } = yield* withFolder;
      yield* fs(async () => {
        await NodeFs.mkdir(directory, { recursive: true, mode: 0o700 });
        await NodeFs.writeFile(record(1), `${exitedPid()}\ngone-owner`);
      });
      assert.isFalse(yield* second.anyHeld);
      assert.deepStrictEqual(
        yield* first.tryRun("k", () => Effect.succeed("ran")),
        Option.some("ran"),
      );
      yield* writeAged(record(1, "old"), `${exitedPid()} ${exitedPid()}\nexpired-owner`);
      yield* TestClock.adjust(Duration.hours(2));
      assert.deepStrictEqual(yield* first.tryRun("old", () => Effect.succeed(1)), Option.some(1));
      assert.deepStrictEqual(yield* names(directory), [
        `${providerInstallLockName("k")}.2`,
        `${providerInstallLockName("old")}.2`,
      ]);
    }),
  );

  it.effect("keeps a live lock until it is an hour old, then unchanged for the grace", () =>
    Effect.gen(function* () {
      const { second, record } = yield* withFolder;
      yield* writeAged(record(1), `${process.pid}\nlive-owner`);
      yield* TestClock.adjust(Duration.minutes(59));
      assert.isTrue(yield* second.anyHeld);
      assert.deepStrictEqual(yield* second.tryRun("k", () => Effect.void), Option.none());
      // An hour old on the wall clock: from now on this process watches it stay unchanged.
      yield* TestClock.adjust(Duration.minutes(1));
      assert.isTrue(yield* second.anyHeld);
      // A launch does not wait out the grace (a wait would hang on the test clock).
      yield* second.beforeLaunch(installedWith("k"));
      yield* TestClock.adjust(Duration.subtract(EXPIRED_TAKEOVER_GRACE, Duration.seconds(1)));
      assert.deepStrictEqual(yield* second.tryRun("k", () => Effect.void), Option.none());
      yield* TestClock.adjust(Duration.seconds(1));
      assert.isFalse(yield* second.anyHeld);
      yield* second.untilIdle("k");
      assert.deepStrictEqual(yield* second.tryRun("k", () => Effect.succeed(1)), Option.some(1));
    }),
  );

  it.effect("does not take over a live owner whose host slept through the hour", () =>
    Effect.gen(function* () {
      const { second, record } = yield* withFolder;
      // The owner's installer runs; the lid closes. At wake its record is 8 hours old on the
      // wall clock, but the installer (and its 5 minute timeout) only resume now.
      yield* writeAged(record(1), `${process.pid} ${process.pid}\nasleep-owner`);
      yield* TestClock.adjust(Duration.hours(8));
      assert.deepStrictEqual(
        yield* second.tryRun("k", () => Effect.die("must not install beside it")),
        Option.none(),
      );
      yield* TestClock.adjust(Duration.minutes(4));
      assert.isTrue(yield* second.isHeld("k"));
      // The installer ends and its owner releases: the lock is free the ordinary way.
      yield* fs(() => NodeFs.writeFile(record(1), "released\nasleep-owner"));
      assert.isFalse(yield* second.isHeld("k"));
      assert.deepStrictEqual(yield* second.tryRun("k", () => Effect.succeed(1)), Option.some(1));
    }),
  );

  it.effect.each(["contents", "mtime"] as const)(
    "keeps an expired live lock whose owner resumes during the takeover (%s)",
    (change) =>
      Effect.gen(function* () {
        const { directory, lockWith, record } = yield* withFolder;
        const previous = record(1);
        const contents = `${process.pid}\npaused-owner`;
        yield* writeAged(previous, contents);
        yield* TestClock.adjust(Duration.hours(1));
        // The paused owner writes (or touches) its record right after the successor linked N+1.
        // That successor has watched the record stay unchanged for the whole grace.
        const lock = lockWith({
          link: async (existingFile, newFile) => {
            await nodeProviderInstallLockFiles.link(existingFile, newFile);
            if (change === "mtime") {
              await NodeFs.utimes(previous, 3600, 3600);
            } else {
              await NodeFs.writeFile(previous, `${process.pid}\nresumed-owner`);
              // A contents change must fence even when timestamp precision hides it.
              await NodeFs.utimes(previous, 0, 0);
            }
          },
        });
        assert.isTrue(yield* lock.anyHeld);
        yield* TestClock.adjust(EXPIRED_TAKEOVER_GRACE);
        assert.deepStrictEqual(
          yield* lock.tryRun("k", () => Effect.die("must not install")),
          Option.none(),
        );
        assert.deepStrictEqual(yield* names(directory), [path.basename(previous)]);
        assert.strictEqual(
          yield* read(previous),
          change === "mtime" ? contents : `${process.pid}\nresumed-owner`,
        );
      }),
  );

  it.effect("never runs a lower generation once a higher one exists", () =>
    Effect.gen(function* () {
      const { directory, lockWith, record } = yield* withFolder;
      yield* writeAged(record(1), "released\nprevious-owner");
      // While this contender prepared generation 2, one successor took 2 and pruned 1, and the
      // next took 3 and pruned 2: linking 2 now succeeds, but it must back off.
      const lock = lockWith({
        link: async (existingFile, newFile) => {
          if (newFile === record(2)) {
            await NodeFs.writeFile(record(3), `${process.pid}\nlatest-owner`);
            await NodeFs.rm(record(1), { force: true });
          }
          await nodeProviderInstallLockFiles.link(existingFile, newFile);
        },
      });
      assert.deepStrictEqual(
        yield* lock.tryRun("k", () => Effect.die("must not install")),
        Option.none(),
      );
      assert.deepStrictEqual(yield* names(directory), [path.basename(record(3))]);
      assert.isTrue(yield* lock.isHeld("k"));
    }),
  );

  it.effect("does not skip a resumed owner after another successor abandons its generation", () =>
    Effect.gen(function* () {
      const { directory, lockWith, record } = yield* withFolder;
      const resumed = record(1);
      const abandoned = record(2);
      yield* writeAged(resumed, `${process.pid}\nresumed-owner`);
      yield* fs(() => NodeFs.writeFile(abandoned, `${process.pid}\nabandoning-successor`));
      let snapshotted = false;
      // The abandoning successor removes its generation right after this contender's snapshot.
      const lock = lockWith({
        readdir: async (folder) => {
          const all = await nodeProviderInstallLockFiles.readdir(folder);
          if (!snapshotted) {
            snapshotted = true;
            await NodeFs.rm(abandoned);
          }
          return all;
        },
      });
      assert.deepStrictEqual(
        yield* lock.tryRun("k", () => Effect.die("must not install")),
        Option.none(),
      );
      assert.deepStrictEqual(yield* names(directory), [path.basename(resumed)]);
      assert.isTrue(yield* lock.anyHeld);
    }),
  );

  it.effect.runIf(POSIX)("never follows a record that is a link, and frees it after an hour", () =>
    Effect.gen(function* () {
      const { root, directory, first, record } = yield* withFolder;
      // Followed, the target would read as a released lock.
      const outside = path.join(root, "outside-record");
      yield* fs(async () => {
        await NodeFs.writeFile(outside, "released\nforged");
        await NodeFs.mkdir(directory, { recursive: true, mode: 0o700 });
        await NodeFs.symlink(outside, record(1));
        await NodeFs.lutimes(record(1), 0, 0);
      });
      assert.isTrue(yield* first.isHeld("k"));
      assert.deepStrictEqual(yield* first.tryRun("k", () => Effect.die("held")), Option.none());

      yield* TestClock.adjust(Duration.hours(1));
      assert.deepStrictEqual(yield* first.tryRun("k", () => Effect.succeed(1)), Option.some(1));
      // The takeover removed the link, never its target.
      assert.deepStrictEqual(yield* names(directory), [path.basename(record(2))]);
      assert.strictEqual(yield* read(outside), "released\nforged");
    }),
  );

  it.effect.runIf(POSIX)("refuses a lock folder that is a link", () =>
    Effect.gen(function* () {
      const { root, directory, first } = yield* withFolder;
      const elsewhere = path.join(root, "elsewhere");
      yield* fs(async () => {
        await NodeFs.mkdir(elsewhere, { mode: 0o700 });
        await NodeFs.symlink(elsewhere, directory);
      });
      const result = yield* first
        .tryRun("k", () => Effect.die("must not install"))
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(result));
      if (Exit.isFailure(result)) {
        const error = Cause.squash(result.cause);
        assert.instanceOf(error, ProviderInstallLockError);
        assert.include((error as ProviderInstallLockError).message, "it is a link");
      }
      assert.isTrue(Exit.isFailure(yield* first.anyHeld.pipe(Effect.exit)));
      // A turn start is not held by a folder it cannot read.
      yield* first.untilIdle("k");
      assert.deepStrictEqual(yield* names(elsewhere), []);
    }),
  );

  it.effect("frees the lock with a released marker and keeps only the highest generation", () =>
    Effect.gen(function* () {
      const { directory, first, second, record } = yield* withFolder;
      for (let generation = 1; generation <= 3; generation += 1) {
        assert.isTrue(Option.isSome(yield* first.tryRun("k", () => Effect.void)));
        assert.deepStrictEqual(yield* names(directory), [path.basename(record(generation))]);
        assert.strictEqual((yield* read(record(generation))).split("\n")[0], "released");
        assert.isFalse(yield* second.isHeld("k"));
      }
      // A record another process released by hand frees it as well.
      yield* fs(() => NodeFs.writeFile(record(3), `${process.pid}\nlive-owner`));
      assert.isTrue(yield* second.isHeld("k"));
      yield* fs(() => NodeFs.writeFile(record(3), "released\nlive-owner"));
      assert.isFalse(yield* second.isHeld("k"));
      assert.isTrue(Option.isSome(yield* second.tryRun("k", () => Effect.void)));
    }),
  );

  it.live("untilIdle completes once the holder releases", () =>
    Effect.gen(function* () {
      const { first, second } = yield* withFolder;
      const holding = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* first
        .tryRun("k", () =>
          Deferred.succeed(holding, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(holding);
      // Another key's lock is free.
      yield* second.untilIdle("other");

      const idle = yield* Ref.make(false);
      const waiter = yield* second
        .untilIdle("k")
        .pipe(Effect.andThen(Ref.set(idle, true)), Effect.forkScoped);
      yield* Effect.sleep("1200 millis");
      assert.isFalse(yield* Ref.get(idle));

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      yield* Fiber.join(waiter);
      assert.isTrue(yield* Ref.get(idle));
    }),
  );

  it.effect("keeps the lock while the recorded installer lives, then frees it", () =>
    Effect.gen(function* () {
      const { first, second, record } = yield* withFolder;
      const installer = yield* Effect.acquireRelease(
        fs(
          () =>
            new Promise<ReturnType<typeof spawn>>((resolve, reject) => {
              const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
                stdio: "ignore",
              });
              child.once("spawn", () => resolve(child));
              child.once("error", reject);
            }),
        ),
        (child) => Effect.sync(() => child.kill("SIGKILL")),
      );
      const pid = installer.pid!;
      assert.isTrue(
        Option.isSome(yield* first.tryRun("k", (recordChildPid) => recordChildPid(pid))),
      );
      // This server's run ended; only the installer still holds the lock.
      assert.strictEqual((yield* read(record(1))).split("\n")[0], String(pid));
      assert.isTrue(yield* second.isHeld("k"));

      yield* fs(
        () =>
          new Promise<void>((resolve) => {
            installer.once("exit", () => resolve());
            installer.kill("SIGKILL");
          }),
      );
      assert.isFalse(yield* second.isHeld("k"));
    }),
  );

  it.effect("does not run when writing its record fails, and leaves nothing behind", () =>
    Effect.gen(function* () {
      const { directory, lockWith } = yield* withFolder;
      const lock = lockWith({
        open: async (file, flags, mode) => {
          const handle = await nodeProviderInstallLockFiles.open(file, flags, mode);
          if (!file.endsWith(".tmp")) return handle;
          return new Proxy(handle, {
            get(target, property) {
              if (property === "writeFile") {
                return () =>
                  Promise.reject(
                    Object.assign(new Error("ENOSPC: no space left on device"), {
                      code: "ENOSPC",
                    }),
                  );
              }
              const value = Reflect.get(target, property, target) as unknown;
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        },
      });
      const result = yield* lock.tryRun("k", () => Effect.die("must not run")).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(result));
      if (Exit.isFailure(result)) {
        assert.instanceOf(Cause.squash(result.cause), ProviderInstallLockError);
      }
      assert.deepStrictEqual(yield* names(directory), []);
      assert.isFalse(yield* lock.anyHeld);
    }),
  );

  it.effect.runIf(POSIX)("keeps the folder private to this user", () =>
    Effect.gen(function* () {
      const { directory, first, record } = yield* withFolder;
      yield* fs(() => NodeFs.mkdir(directory, { mode: 0o755 }));
      yield* fs(() => NodeFs.chmod(directory, 0o755));
      assert.isTrue(Option.isSome(yield* first.tryRun("k", () => Effect.void)));
      const folderMode = (yield* fs(() => NodeFs.stat(directory))).mode & 0o777;
      const recordMode = (yield* fs(() => NodeFs.stat(record(1)))).mode & 0o777;
      assert.strictEqual(folderMode, 0o700);
      assert.strictEqual(recordMode, 0o600);
    }),
  );

  it.effect("sets aside only the lock its caller holds", () =>
    Effect.gen(function* () {
      const { first, second } = yield* withFolder;
      const seen = yield* first.tryRun("npm-global", () =>
        Effect.gen(function* () {
          const alone = yield* second.anyHeldExcept("npm-global");
          const other = yield* second.tryRun("homebrew", () => second.anyHeldExcept("npm-global"));
          return { alone, other: Option.getOrThrow(other) };
        }),
      );
      assert.deepStrictEqual(Option.getOrThrow(seen), { alone: false, other: true });
    }),
  );

  /** A lock over the folder that reports each busy marker it writes or removes. */
  const watchedBusyLock = (
    lockWith: (
      files: Partial<ProviderInstallLockFiles>,
    ) => ReturnType<typeof makeProviderInstallLock>,
  ) => {
    const events: Array<string> = [];
    let notify: () => void = () => undefined;
    const next = () => new Promise<void>((resolve) => (notify = resolve));
    const lock = lockWith({
      rename: async (from, to) => {
        await nodeProviderInstallLockFiles.rename(from, to);
        if (!to.endsWith(".busy")) return;
        events.push(`wrote ${path.basename(to)}`);
        notify();
      },
      unlink: async (file) => {
        await nodeProviderInstallLockFiles.unlink(file);
        if (!file.endsWith(".busy")) return;
        events.push(`removed ${path.basename(file)}`);
        notify();
      },
    });
    return { lock, events, next };
  };

  it.effect("publishes a busy marker other processes read, until its work ends", () =>
    Effect.gen(function* () {
      const { second, lockWith, directory } = yield* withFolder;
      const busy = `${directory}-busy`;
      const { lock: first, next } = watchedBusyLock(lockWith);
      assert.isFalse(yield* second.othersBusy);

      const written = next();
      const holding = yield* Effect.forkChild(first.holdBusy);
      yield* Effect.promise(() => written);
      const [marker] = yield* names(busy);
      assert.match(marker!, new RegExp(`^${process.pid}\\.[0-9a-f-]+\\.busy$`, "u"));
      assert.strictEqual(
        yield* read(path.join(busy, marker!)),
        `${process.pid}\n${marker!.split(".")[1]}`,
      );
      assert.isTrue(yield* second.othersBusy);
      // Its own marker never counts for itself.
      assert.isFalse(yield* first.othersBusy);
      if (POSIX) {
        assert.strictEqual((yield* fs(() => NodeFs.stat(busy))).mode & 0o777, 0o700);
        assert.strictEqual(
          (yield* fs(() => NodeFs.stat(path.join(busy, marker!)))).mode & 0o777,
          0o600,
        );
      }

      // Kept fresh while the work lasts.
      const refreshed = next();
      const inode = (yield* fs(() => NodeFs.stat(path.join(busy, marker!)))).ino;
      yield* TestClock.adjust(BUSY_MARKER_REFRESH_INTERVAL);
      yield* Effect.promise(() => refreshed);
      assert.notStrictEqual((yield* fs(() => NodeFs.stat(path.join(busy, marker!)))).ino, inode);

      yield* Fiber.interrupt(holding);
      assert.deepStrictEqual(yield* names(busy), []);
      assert.isFalse(yield* second.othersBusy);
    }),
  );

  it.effect("ignores the marker of a process that exited, and the next writer removes it", () =>
    Effect.gen(function* () {
      const { second, lockWith, directory } = yield* withFolder;
      const busy = `${directory}-busy`;
      const pid = exitedPid();
      const stale = `${pid}.gone.busy`;
      yield* fs(async () => {
        await NodeFs.mkdir(busy, { recursive: true, mode: 0o700 });
        await NodeFs.writeFile(path.join(busy, stale), `${pid}\ngone`);
      });
      assert.isFalse(yield* second.othersBusy);

      const { lock: first, events, next } = watchedBusyLock(lockWith);
      let pruned = next();
      const holding = yield* Effect.forkChild(first.holdBusy);
      // Written first, then the dead marker goes.
      while (!events.some((event) => event.startsWith("removed"))) {
        yield* Effect.promise(() => pruned);
        pruned = next();
      }
      assert.deepStrictEqual(events.at(-1), `removed ${stale}`);
      assert.notInclude(yield* names(busy), stale);
      yield* Fiber.interrupt(holding);
    }),
  );

  it("names records by the URI-encoded key, shortening only what file names cannot hold", () => {
    assert.strictEqual(
      providerInstallLockName("npm-global:/usr/local"),
      "npm-global%3A%2Fusr%2Flocal.lock",
    );
    const long = (suffix: string) => `npm-global:/${"nested/".repeat(40)}${suffix}`;
    const name = providerInstallLockName(long("a"));
    assert.isAtMost(name.length, 165);
    assert.strictEqual(name, providerInstallLockName(long("a")));
    assert.notStrictEqual(name, providerInstallLockName(long("b")));
  });
});

describe("the provider install lock folder and launches", () => {
  it("shares one cache folder per user, whatever RYCO_HOME says", () => {
    const env = { RYCO_HOME: "/elsewhere/.ryco" };
    assert.strictEqual(
      resolveProviderInstallLockDirectory({ platform: "darwin", env, homeDirectory: "/Users/me" }),
      "/Users/me/Library/Caches/ryco/provider-install",
    );
    assert.strictEqual(
      resolveProviderInstallLockDirectory({
        platform: "linux",
        env: { ...env, XDG_CACHE_HOME: "/var/cache/me" },
        homeDirectory: "/home/me",
      }),
      "/var/cache/me/ryco/provider-install",
    );
    // The XDG spec ignores a relative path.
    assert.strictEqual(
      resolveProviderInstallLockDirectory({
        platform: "linux",
        env: { XDG_CACHE_HOME: "cache" },
        homeDirectory: "/home/me",
      }),
      "/home/me/.cache/ryco/provider-install",
    );
    assert.strictEqual(
      resolveProviderInstallLockDirectory({
        platform: "win32",
        env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
        homeDirectory: "C:\\Users\\me",
      }),
      "C:\\Users\\me\\AppData\\Local\\ryco\\provider-install",
    );
    assert.strictEqual(
      resolveProviderInstallLockDirectory({
        platform: "win32",
        env: {},
        homeDirectory: "C:\\Users\\me",
      }),
      "C:\\Users\\me\\AppData\\Local\\ryco\\provider-install",
    );
  });

  it.effect("looks up a launch's installer only when the folder has entries", () =>
    Effect.gen(function* () {
      const { directory } = yield* withFolder;
      const lookups = yield* Ref.make<ReadonlyArray<ProviderInstanceId>>([]);
      // Through the boot facade, which loads the lock on first use.
      const service = yield* Effect.service(ProviderInstallLock).pipe(
        Effect.provide(
          makeProviderInstallLockLive(directory).pipe(
            Layer.provide(
              Layer.mock(ProviderRegistry)({
                getProviderMaintenanceCapabilitiesForInstance: (instanceId, provider) =>
                  Ref.update(lookups, (all) => [...all, instanceId]).pipe(
                    Effect.andThen(
                      instanceId === ProviderInstanceId.make("manual")
                        ? Effect.succeed(
                            makeManualOnlyProviderMaintenanceCapabilities({
                              provider,
                              packageName: null,
                            }),
                          )
                        : installedWith("k"),
                    ),
                  ),
              }),
            ),
          ),
        ),
      );
      const codex = ProviderInstanceId.make("codex");

      yield* service.beforeLaunch(codex, CODEX);
      assert.deepStrictEqual(yield* Ref.get(lookups), []);

      const lock = yield* service.lock;
      assert.isFalse(yield* lock.anyHeld);
      assert.isTrue(Option.isSome(yield* lock.tryRun("k", () => Effect.void)));
      yield* service.beforeLaunch(codex, CODEX);
      assert.deepStrictEqual(yield* Ref.get(lookups), [codex]);
      // A provider without an installer waits for nothing.
      yield* service.beforeLaunch(ProviderInstanceId.make("manual"), CODEX);
    }),
  );

  it.effect("holds a launch while its installer's lock is held, at most ten minutes", () =>
    Effect.gen(function* () {
      const { first, second, lockWith } = yield* withFolder;
      const holding = yield* Deferred.make<void>();
      yield* first
        .tryRun("npm-global:/prefix", () =>
          Deferred.succeed(holding, undefined).pipe(Effect.andThen(Effect.never)),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(holding);
      // Another provider's installer does not hold this launch.
      yield* second.beforeLaunch(installedWith("homebrew"));

      // The launch's second folder read is its first poll: its ten minutes run from there.
      let reads = 0;
      let polling: () => void = () => {};
      const polled = new Promise<void>((resolve) => {
        polling = resolve;
      });
      const launcher = lockWith({
        readdir: (folder) => {
          reads += 1;
          if (reads === 2) polling();
          return nodeProviderInstallLockFiles.readdir(folder);
        },
      });
      const launched = yield* Ref.make(false);
      const launch = yield* launcher
        .beforeLaunch(installedWith("npm-global:/prefix"))
        .pipe(Effect.andThen(Ref.set(launched, true)), Effect.forkScoped);
      const settle = fs(() => new Promise((resolve) => setTimeout(resolve, 50)));
      yield* fs(() => polled);
      yield* settle;
      yield* TestClock.adjust(Duration.subtract(LAUNCH_WAIT, Duration.seconds(1)));
      yield* settle;
      assert.isFalse(yield* Ref.get(launched));
      // A lock still held after ten minutes is stale or forged: the launch goes ahead.
      yield* TestClock.adjust(Duration.seconds(1));
      yield* Fiber.join(launch);
      assert.isTrue(yield* Ref.get(launched));
      assert.isTrue(yield* second.isHeld("npm-global:/prefix"));
    }),
  );
});

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Deferred, Effect, Exit, Fiber, Layer, Logger, Option } from "effect";
import { vi } from "vite-plus/test";

import { ServerConfig } from "../config.ts";
import {
  acquireDatabaseMaintenance,
  acquireDatabaseServer,
  asDatabaseOwner,
  type DatabaseOwnedError,
  DatabaseOwnerLease,
  DatabaseOwnerLeaseLive,
  DatabaseOwnerLockEnvironment,
  databaseOwnerLockPath,
  describeDatabaseOwnedFailure,
  type DatabaseOwner,
  probeDatabaseOwner,
} from "./databaseOwnerLock.ts";
import { migrationSchemaDigest, SUPPORTED_MIGRATION_ID } from "./Migrations.ts";

const fileSystem = vi.hoisted(() => ({
  /** exFAT and FAT on macOS: an empty file reports this inode until it holds data. */
  placeholderInoWhileEmpty: undefined as number | undefined,
  /** Runs before `rm` removes `path`, which waits for it. */
  beforeRm: undefined as ((path: string) => Promise<void>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const placeholder = fileSystem.placeholderInoWhileEmpty;
      if (placeholder !== undefined) {
        const stat = handle.stat.bind(handle);
        handle.stat = (async () => {
          const stats = await stat();
          if (stats.size === 0) stats.ino = placeholder;
          return stats;
        }) as typeof handle.stat;
      }
      return handle;
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      await fileSystem.beforeRm?.(String(args[0]));
      return actual.rm(...args);
    },
  };
});

const BOOT = 1_784_000_000_000;
const BOOT_ID = "0b6ff1d4-6c1f-4f5e-9d38-6a1c3e2b7f10";
const OTHER_BOOT_ID = "9a2e7c41-0d5b-4b8e-a3f6-2c7d9e1f4b52";

/** What every simulated process on this "machine" sees. */
interface World {
  readonly alive: Set<number>;
  readonly startTimes: Map<number, string>;
  bootId: string;
  bootTime?: number | undefined;
}

const makeWorld = (pids: ReadonlyArray<number>): World => ({
  alive: new Set(pids),
  startTimes: new Map(pids.map((pid) => [pid, String(5_000 + pid)])),
  bootId: BOOT_ID,
});

/** Run `effect` as process `pid` of `world`. */
const asProcess =
  (
    world: World,
    pid: number,
    isListening?: (host: string, port: number) => Promise<boolean>,
    started: { readonly platform?: NodeJS.Platform; readonly parentPid?: number } = {},
  ) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, DatabaseOwnerLockEnvironment, {
      pid,
      parentPid: started.parentPid ?? 1_000,
      now: Date.now,
      probe: {
        platform: started.platform ?? "linux",
        bootTime: () => world.bootTime ?? BOOT,
        bootId: async () => world.bootId,
        processAlive: (candidate) => world.alive.has(candidate),
        processStartTime: async (candidate) => world.startTimes.get(candidate),
      },
      isListening: async (host, port) => (isListening ? isListening(host, port) : false),
    });

const makeDbPath = () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ryco-db-owner-"));
  return NodePath.join(directory, "userdata", "state.sqlite");
};

const cleanup = (dbPath: string) =>
  Effect.sync(() => {
    const lockPath = databaseOwnerLockPath(dbPath);
    if (NodeFS.existsSync(lockPath) && NodeFS.lstatSync(lockPath).isFile()) {
      NodeFS.chmodSync(lockPath, 0o600);
    }
    NodeFS.rmSync(NodePath.dirname(NodePath.dirname(dbPath)), { recursive: true, force: true });
  });

/** Write a lock record as another process would, naming the file's own inode. */
const writeOwnerRecord = (
  dbPath: string,
  record: { readonly pid: number; readonly kind?: "server" | "maintenance" } & Record<
    string,
    unknown
  >,
) => {
  const lockPath = databaseOwnerLockPath(dbPath);
  NodeFS.mkdirSync(NodePath.dirname(lockPath), { recursive: true });
  NodeFS.writeFileSync(lockPath, "", { mode: 0o600 });
  const ino = NodeFS.lstatSync(lockPath).ino;
  NodeFS.writeFileSync(
    lockPath,
    `${JSON.stringify({
      version: 1,
      token: `token-${record.pid}`,
      kind: "server",
      purpose: "serve",
      launcher: "desktop",
      appVersion: "0.1.36",
      startedAt: new Date().toISOString(),
      bootTime: BOOT,
      bootId: BOOT_ID,
      startTime: String(5_000 + record.pid),
      ino,
      schemaSupported: SUPPORTED_MIGRATION_ID,
      schemaDigest: migrationSchemaDigest,
      ...record,
    })}\n`,
  );
  return lockPath;
};

const ownedFailure = <A>(exit: Exit.Exit<A, DatabaseOwnedError>): DatabaseOwnedError => {
  if (Exit.isSuccess(exit)) throw new Error("expected the acquisition to fail");
  const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail");
  if (failure === undefined || failure._tag !== "Fail") throw new Error("expected a typed failure");
  return failure.error;
};

describe("database owner lock", () => {
  it.effect("shows a server's ownership to other processes until it is released", () => {
    const dbPath = makeDbPath();
    const world = makeWorld([100, 200]);
    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const lease = yield* acquireDatabaseServer(dbPath, {
            launcher: "desktop",
            appVersion: "0.1.36",
          }).pipe(asProcess(world, 100));
          assert.equal(lease.owner.self, true);

          const probed = yield* probeDatabaseOwner(dbPath).pipe(asProcess(world, 200));
          assert.equal(probed.state, "owned");
          if (probed.state === "owned") {
            assert.include(probed.owner, {
              pid: 100,
              kind: "server",
              launcher: "desktop",
              appVersion: "0.1.36",
              schemaDigest: migrationSchemaDigest,
              legacy: false,
              self: false,
            });
            assert.isString(probed.owner.startedAt);
          }

          const second = yield* acquireDatabaseServer(
            dbPath,
            { launcher: "serve" },
            { waitMs: 0 },
          ).pipe(asProcess(world, 200), Effect.scoped, Effect.exit);
          const error = ownedFailure(second);
          assert.equal(error.reason, "held");
          assert.equal(error.owner?.pid, 100);
          assert.include(error.message, "Another Ryco server is using this data directory");
          assert.include(error.message, "the Ryco desktop app (pid 100, version 0.1.36");
        }),
      );
      assert.deepEqual(yield* probeDatabaseOwner(dbPath).pipe(asProcess(world, 200)), {
        state: "free",
      });
      assert.isFalse(NodeFS.existsSync(databaseOwnerLockPath(dbPath)));
    }).pipe(Effect.ensuring(cleanup(dbPath)));
  });

  it.effect("reclaims the lock of a crashed, rebooted-away or replaced owner", () => {
    const dbPath = makeDbPath();
    const world = makeWorld([100, 200]);
    const acquireAs200 = acquireDatabaseServer(dbPath, { launcher: "serve" }, { waitMs: 0 }).pipe(
      asProcess(world, 200),
      Effect.scoped,
      Effect.exit,
    );
    return Effect.gen(function* () {
      // Crash: the pid is gone.
      writeOwnerRecord(dbPath, { pid: 300 });
      assert.isTrue(Exit.isSuccess(yield* acquireAs200));
      // Reboot: written in another boot.
      writeOwnerRecord(dbPath, { pid: 100, bootId: OTHER_BOOT_ID });
      assert.isTrue(Exit.isSuccess(yield* acquireAs200));
      // Pid reuse: pid 100 is alive but started at another time.
      writeOwnerRecord(dbPath, { pid: 100, startTime: "999999" });
      assert.isTrue(Exit.isSuccess(yield* acquireAs200));
      // The same process: held.
      writeOwnerRecord(dbPath, { pid: 100 });
      assert.equal(ownedFailure(yield* acquireAs200).reason, "held");
      // This pid, but not this process's lease (a container restarted as pid 1 again).
      writeOwnerRecord(dbPath, { pid: 200 });
      assert.isTrue(Exit.isSuccess(yield* acquireAs200));
    }).pipe(Effect.ensuring(cleanup(dbPath)));
  });

  it.effect("ignores a lock copied along with its data directory", () => {
    const dbPath = makeDbPath();
    const copyPath = makeDbPath();
    const world = makeWorld([100, 200]);
    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* acquireDatabaseServer(dbPath, { launcher: "serve" }).pipe(asProcess(world, 100));
          NodeFS.mkdirSync(NodePath.dirname(copyPath), { recursive: true });
          NodeFS.copyFileSync(databaseOwnerLockPath(dbPath), databaseOwnerLockPath(copyPath));
          // The original is still owned...
          assert.equal(
            (yield* probeDatabaseOwner(dbPath).pipe(asProcess(world, 200))).state,
            "owned",
          );
          // ...the copy names another file.
          assert.equal(
            (yield* probeDatabaseOwner(copyPath).pipe(asProcess(world, 200))).state,
            "free",
          );
          const exit = yield* acquireDatabaseServer(
            copyPath,
            { launcher: "serve" },
            { waitMs: 0 },
          ).pipe(asProcess(world, 200), Effect.scoped, Effect.exit);
          assert.isTrue(Exit.isSuccess(exit));
        }),
      );
    }).pipe(Effect.ensuring(cleanup(dbPath)), Effect.ensuring(cleanup(copyPath)));
  });

  it.effect("reads a record naming a file id above 2^53 (Windows)", () => {
    const dbPath = makeDbPath();
    const world = makeWorld([100, 200]);
    return Effect.gen(function* () {
      // Read as a record, not as a half-written file: it names another file
      // than this one, so it is judged a copy instead of making everyone wait.
      writeOwnerRecord(dbPath, { pid: 100, ino: 2 ** 60 + 4_096 });
      assert.deepEqual(yield* probeDatabaseOwner(dbPath).pipe(asProcess(world, 200)), {
        state: "free",
      });
    }).pipe(Effect.ensuring(cleanup(dbPath)));
  });

  it.live("waits a bounded time for another server to release the database", () => {
    const dbPath = makeDbPath();
    const world = makeWorld([100, 200]);
    return Effect.gen(function* () {
      const holder = yield* Effect.forkChild(
        Effect.scoped(
          acquireDatabaseServer(dbPath, { launcher: "serve" }).pipe(
            asProcess(world, 100),
            Effect.andThen(Effect.sleep(300)),
          ),
        ),
      );
      yield* Effect.sleep(50);
      const startedAt = Date.now();
      const exit = yield* acquireDatabaseServer(
        dbPath,
        { launcher: "serve" },
        { waitMs: 2_000 },
      ).pipe(asProcess(world, 200), Effect.scoped, Effect.exit);
      assert.isTrue(Exit.isSuccess(exit));
      assert.isAbove(Date.now() - startedAt, 150);
      yield* Fiber.join(holder);

      // A holder that never releases: refused once the wait is over.
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* acquireDatabaseServer(dbPath, { launcher: "serve" }).pipe(asProcess(world, 100));
          const refusedAt = Date.now();
          const refused = yield* acquireDatabaseServer(
            dbPath,
            { launcher: "serve" },
            { waitMs: 300 },
          ).pipe(asProcess(world, 200), Effect.scoped, Effect.exit);
          assert.equal(ownedFailure(refused).reason, "held");
          const waitedMs = Date.now() - refusedAt;
          assert.isAtLeast(waitedMs, 280);
          assert.isBelow(waitedMs, 5_000);
        }),
      );
    }).pipe(Effect.ensuring(cleanup(dbPath)));
  });

  it.live("runs an operation as the database's owner, under its lease or maintenance", () => {
    const dbPath = makeDbPath();
    const world = makeWorld([100, 200]);
    const ownerKind = probeDatabaseOwner(dbPath).pipe(
      asProcess(world, 200),
      Effect.map((probed) => (probed.state === "owned" ? probed.owner.kind : null)),
    );
    return Effect.gen(function* () {
      // Nobody owns the database: maintenance ownership for the operation, released after it.
      assert.equal(
        yield* asDatabaseOwner(dbPath, "restore", ownerKind).pipe(asProcess(world, 100)),
        "maintenance",
      );
      assert.isNull(yield* ownerKind);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const lease = yield* acquireDatabaseServer(dbPath, { launcher: "serve" }).pipe(
            asProcess(world, 100),
          );
          // Another process is refused at once, and the operation never runs.
          let ran = false;
          const refused = yield* asDatabaseOwner(
            dbPath,
            "restore",
            Effect.sync(() => {
              ran = true;
            }),
          ).pipe(asProcess(world, 200), Effect.exit);
          assert.equal(ownedFailure(refused).owner?.kind, "server");
          assert.isFalse(ran);
          // The server itself runs it under its lease (its startup finishing a restore).
          assert.equal(
            yield* asDatabaseOwner(dbPath, "restore", ownerKind).pipe(
              Effect.provideService(DatabaseOwnerLease, lease),
              asProcess(world, 100),
            ),
            "server",
          );
        }),
      );
    }).pipe(Effect.ensuring(cleanup(dbPath)));
  });

  it.live(
    "refuses maintenance under a server at once, and makes a server wait for maintenance",
    () => {
      const dbPath = makeDbPath();
      const world = makeWorld([100, 200]);
      return Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* acquireDatabaseServer(dbPath, {
              launcher: "service",
              serviceLabel: "com.ryco.node",
            }).pipe(asProcess(world, 100));
            const startedAt = Date.now();
            const refused = yield* acquireDatabaseMaintenance(dbPath, "doctor", {
              waitMs: 5_000,
            }).pipe(asProcess(world, 200), Effect.scoped, Effect.exit);
            const error = ownedFailure(refused);
            assert.equal(error.owner?.kind, "server");
            assert.isBelow(Date.now() - startedAt, 2_500);
            assert.include(error.message, "the background service com.ryco.node (pid 100");
            assert.include(error.message, "ryco service stop");
          }),
        );

        // A CLI migration holds the database; a server started meanwhile waits for
        // it even with no wait of its own for other servers.
        const migration = yield* Effect.forkChild(
          Effect.scoped(
            acquireDatabaseMaintenance(dbPath, "cli-migration").pipe(
              asProcess(world, 100),
              Effect.andThen(Effect.sleep(300)),
            ),
          ),
        );
        yield* Effect.sleep(50);
        const probed = yield* probeDatabaseOwner(dbPath).pipe(asProcess(world, 200));
        assert.equal(probed.state === "owned" ? probed.owner.kind : null, "maintenance");
        const exit = yield* acquireDatabaseServer(
          dbPath,
          { launcher: "desktop" },
          { waitMs: 0 },
        ).pipe(asProcess(world, 200), Effect.scoped, Effect.exit);
        assert.isTrue(Exit.isSuccess(exit));
        yield* Fiber.join(migration);
      }).pipe(Effect.ensuring(cleanup(dbPath)));
    },
  );

  it.live("keeps a service waiting while another server runs, then takes over", () => {
    const dbPath = makeDbPath();
    const world = makeWorld([100, 200]);
    return Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      const desktop = yield* Effect.forkChild(
        Effect.scoped(
          acquireDatabaseServer(dbPath, { launcher: "desktop" }).pipe(
            asProcess(world, 100),
            Effect.andThen(Deferred.await(release)),
          ),
        ),
      );
      yield* Effect.sleep(50);
      const service = yield* Effect.forkChild(
        Effect.scoped(
          acquireDatabaseServer(dbPath, {
            launcher: "service",
            serviceLabel: "com.ryco.node",
          }).pipe(
            asProcess(world, 200),
            Effect.map((lease) => lease.owner.pid),
          ),
        ),
      );
      // Well past any wait a desktop or `ryco serve` would allow (here 0 s by default config).
      yield* Effect.sleep(700);
      assert.isUndefined(service.pollUnsafe());
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(desktop);
      assert.equal(yield* Fiber.join(service), 200);
    }).pipe(Effect.ensuring(cleanup(dbPath)));
  });

  it.live("fails closed on a lock it cannot judge, and leaves it alone", () => {
    const dbPath = makeDbPath();
    const world = makeWorld([200]);
    const lockPath = databaseOwnerLockPath(dbPath);
    const attempt = acquireDatabaseServer(dbPath, { launcher: "serve" }, { waitMs: 0 }).pipe(
      asProcess(world, 200),
      Effect.scoped,
      Effect.exit,
    );
    return Effect.gen(function* () {
      NodeFS.mkdirSync(lockPath, { recursive: true });
      assert.equal(ownedFailure(yield* attempt).reason, "foreign-file");
      assert.isTrue(NodeFS.lstatSync(lockPath).isDirectory());
      const probed = yield* probeDatabaseOwner(dbPath).pipe(asProcess(world, 200), Effect.flip);
      assert.equal(probed.reason, "foreign-file");
      NodeFS.rmSync(lockPath, { recursive: true });

      // Half-written moments ago: someone is taking it right now.
      NodeFS.writeFileSync(lockPath, "");
      const beingWritten = ownedFailure(yield* attempt);
      assert.equal(beingWritten.reason, "being-written");
      assert.equal(NodeFS.readFileSync(lockPath, "utf8"), "");
      // Left half-written by a crash: reclaimed.
      const old = new Date(Date.now() - 5 * 60_000);
      NodeFS.utimesSync(lockPath, old, old);
      assert.isTrue(Exit.isSuccess(yield* attempt));
      // Torn by a power loss moments before this boot (the record is not synced):
      // reclaimed at once, although younger than the grace period.
      NodeFS.writeFileSync(lockPath, '{"version":1,"tok');
      const beforeBoot = new Date(Date.now() - 20_000);
      NodeFS.utimesSync(lockPath, beforeBoot, beforeBoot);
      world.bootTime = Date.now() - 5_000;
      assert.isTrue(Exit.isSuccess(yield* attempt));
      world.bootTime = undefined;

      if (process.platform !== "win32" && process.getuid?.() !== 0) {
        writeOwnerRecord(dbPath, { pid: 100 });
        NodeFS.chmodSync(lockPath, 0o000);
        const unreadable = ownedFailure(yield* attempt);
        assert.equal(unreadable.reason, "unreadable");
        assert.include(unreadable.message, "cannot read");
        NodeFS.chmodSync(lockPath, 0o600);
        assert.include(NodeFS.readFileSync(lockPath, "utf8"), '"pid":100');
      }
    }).pipe(Effect.ensuring(cleanup(dbPath)));
  });

  it.effect("keeps a live owner visible where an empty file reports a placeholder inode", () => {
    const dbPath = makeDbPath();
    const world = makeWorld([100, 200]);
    return Effect.gen(function* () {
      // exFAT and FAT on macOS: 2^64 - 1 until the file holds data, its real inode after.
      fileSystem.placeholderInoWhileEmpty = 2 ** 64 - 1;
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* acquireDatabaseServer(dbPath, { launcher: "serve" }).pipe(asProcess(world, 100));
          const probed = yield* probeDatabaseOwner(dbPath).pipe(asProcess(world, 200));
          assert.equal(probed.state === "owned" ? probed.owner.pid : null, 100);
          const second = yield* acquireDatabaseServer(
            dbPath,
            { launcher: "serve" },
            { waitMs: 0 },
          ).pipe(asProcess(world, 200), Effect.scoped, Effect.exit);
          assert.equal(ownedFailure(second).reason, "held");
        }),
      );
    }).pipe(
      Effect.ensuring(Effect.sync(() => (fileSystem.placeholderInoWhileEmpty = undefined))),
      Effect.ensuring(cleanup(dbPath)),
    );
  });

  it.live("lets only one of two processes reclaiming the same stale lock take it", () => {
    const dbPath = makeDbPath();
    const world = makeWorld([100, 200]);
    const lockPath = databaseOwnerLockPath(dbPath);
    const acquireAs = (pid: number) =>
      acquireDatabaseServer(dbPath, { launcher: "serve" }, { waitMs: 0 }).pipe(
        asProcess(world, pid),
        Effect.map((lease) => lease.owner.pid),
        Effect.exit,
      );
    return Effect.gen(function* () {
      writeOwnerRecord(dbPath, { pid: 300 });
      const stale = NodeFS.lstatSync(lockPath);
      // The first process to remove the stale lock is held between its check and its removal
      // until the lock was created again, or for 300 ms.
      let held = false;
      fileSystem.beforeRm = async (path) => {
        if (path !== lockPath || held) return;
        held = true;
        const deadline = Date.now() + 300;
        while (Date.now() < deadline) {
          const current = NodeFS.lstatSync(lockPath, { throwIfNoEntry: false });
          if (current !== undefined && current.mtimeMs !== stale.mtimeMs) return;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      };
      yield* Effect.scoped(
        Effect.gen(function* () {
          const exits = yield* Effect.all([acquireAs(100), acquireAs(200)], { concurrency: 2 });
          const owners = exits.filter(Exit.isSuccess).map((exit) => exit.value);
          assert.equal(owners.length, 1);
          assert.include(NodeFS.readFileSync(lockPath, "utf8"), `"pid":${owners[0]}`);
        }),
      );
    }).pipe(
      Effect.ensuring(Effect.sync(() => (fileSystem.beforeRm = undefined))),
      Effect.ensuring(cleanup(dbPath)),
    );
  });

  it.live("fails closed on a stale lock it cannot remove instead of retrying forever", () => {
    const dbPath = makeDbPath();
    const world = makeWorld([100, 200]);
    const directory = NodePath.dirname(dbPath);
    return Effect.gen(function* () {
      if (process.platform === "win32" || process.getuid?.() === 0) return;
      // A crashed owner's lock, and one copied along with its data directory, in a directory
      // this process may read but not write (a read-only copy or mount).
      for (const record of [{ pid: 300 }, { pid: 100, ino: 1 }]) {
        const lockPath = writeOwnerRecord(dbPath, record);
        NodeFS.chmodSync(directory, 0o555);
        for (const acquisition of [
          acquireDatabaseServer(dbPath, { launcher: "serve" }, { waitMs: 0 }),
          acquireDatabaseMaintenance(dbPath, "cli-migration", { waitMs: 0 }),
        ]) {
          const outcome = yield* acquisition.pipe(
            asProcess(world, 200),
            Effect.scoped,
            Effect.exit,
            Effect.timeoutOption("4 seconds"),
          );
          assert.isTrue(Option.isSome(outcome), "still trying after 4 s");
          if (Option.isSome(outcome)) assert.equal(ownedFailure(outcome.value).reason, "io-error");
        }
        NodeFS.chmodSync(directory, 0o755);
        assert.include(NodeFS.readFileSync(lockPath, "utf8"), `"pid":${record.pid}`);
      }
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => NodeFS.existsSync(directory) && NodeFS.chmodSync(directory, 0o755)),
      ),
      Effect.ensuring(cleanup(dbPath)),
    );
  });

  it.live("gives up on a stale lock that another process is still reclaiming", () => {
    const dbPath = makeDbPath();
    const world = makeWorld([200]);
    const attempt = acquireDatabaseServer(dbPath, { launcher: "serve" }, { waitMs: 0 }).pipe(
      asProcess(world, 200),
      Effect.scoped,
      Effect.exit,
    );
    return Effect.gen(function* () {
      const lockPath = writeOwnerRecord(dbPath, { pid: 300 });
      // Left by a reclaimer that died between checking the lock and removing it.
      const guardPath = `${lockPath}.reclaim`;
      NodeFS.writeFileSync(guardPath, "");
      const startedAt = Date.now();
      assert.equal(ownedFailure(yield* attempt).reason, "being-written");
      const waitedMs = Date.now() - startedAt;
      assert.isAtLeast(waitedMs, 900);
      assert.isBelow(waitedMs, 5_000);
      // Once the guard is as old as a half-written lock that counts as stale, it goes.
      const old = new Date(Date.now() - 5 * 60_000);
      NodeFS.utimesSync(guardPath, old, old);
      assert.isTrue(Exit.isSuccess(yield* attempt));
      assert.isFalse(NodeFS.existsSync(guardPath));
    }).pipe(Effect.ensuring(cleanup(dbPath)));
  });

  it.effect(
    "names a server the background service only when its service manager started it",
    () => {
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ryco-db-owner-service-"));
      const world = makeWorld([200]);
      // Everything a `ryco service` starts inherits its label, and a provider session's agent
      // may well run `ryco serve`.
      const ownerStarted = (
        started: { readonly platform: NodeJS.Platform; readonly parentPid: number },
        systemdExecPid?: string,
      ) =>
        Effect.scoped(
          Effect.gen(function* () {
            const { owner } = yield* DatabaseOwnerLease;
            return { launcher: owner.launcher, serviceLabel: owner.serviceLabel };
          }).pipe(
            Effect.provide(
              DatabaseOwnerLeaseLive.pipe(
                Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
                Layer.provide(NodeServices.layer),
                Layer.provide(
                  ConfigProvider.layer(
                    ConfigProvider.fromUnknown({
                      RYCO_SERVICE_LABEL: "space.ryco.node",
                      ...(systemdExecPid !== undefined ? { SYSTEMD_EXEC_PID: systemdExecPid } : {}),
                    }),
                  ),
                ),
              ),
            ),
            asProcess(world, 200, undefined, started),
          ),
        );
      const service = { launcher: "service", serviceLabel: "space.ryco.node" } as const;
      const serve = { launcher: "serve", serviceLabel: undefined } as const;
      return Effect.gen(function* () {
        // launchd starts its jobs itself.
        assert.deepEqual(yield* ownerStarted({ platform: "darwin", parentPid: 1 }), service);
        assert.deepEqual(yield* ownerStarted({ platform: "darwin", parentPid: 150 }), serve);
        // systemd names the process it started.
        assert.deepEqual(
          yield* ownerStarted({ platform: "linux", parentPid: 150 }, "200"),
          service,
        );
        assert.deepEqual(yield* ownerStarted({ platform: "linux", parentPid: 150 }, "150"), serve);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true })),
        ),
      );
    },
  );

  it.effect("releases only its own lock", () => {
    const dbPath = makeDbPath();
    const world = makeWorld([100, 200]);
    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* acquireDatabaseServer(dbPath, { launcher: "serve" }).pipe(asProcess(world, 100));
          // Replaced meanwhile (an operator removed it and another server took over).
          NodeFS.rmSync(databaseOwnerLockPath(dbPath));
          writeOwnerRecord(dbPath, { pid: 200, token: "someone-else" });
        }),
      );
      assert.include(NodeFS.readFileSync(databaseOwnerLockPath(dbPath), "utf8"), "someone-else");
    }).pipe(Effect.ensuring(cleanup(dbPath)));
  });

  it.live("recognizes a server from before the lock by its runtime file and listening port", () => {
    const dbPath = makeDbPath();
    const world = makeWorld([200, 4242]);
    return Effect.gen(function* () {
      const server = yield* Effect.promise(
        () =>
          new Promise<NodeNet.Server>((resolve) => {
            const listening = NodeNet.createServer();
            listening.listen(0, "127.0.0.1", () => resolve(listening));
          }),
      );
      const port = (server.address() as NodeNet.AddressInfo).port;
      NodeFS.mkdirSync(NodePath.dirname(dbPath), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(NodePath.dirname(dbPath), "server-runtime.json"),
        JSON.stringify({
          version: 1,
          pid: 4242,
          host: "127.0.0.1",
          port,
          origin: `http://127.0.0.1:${port}`,
          startedAt: new Date().toISOString(),
        }),
      );
      const realListening = (host: string, candidatePort: number) =>
        new Promise<boolean>((resolve) => {
          const socket = NodeNet.connect({ host, port: candidatePort });
          socket.once("connect", () => {
            socket.destroy();
            resolve(true);
          });
          socket.once("error", () => resolve(false));
        });

      const probed = yield* probeDatabaseOwner(dbPath).pipe(asProcess(world, 200, realListening));
      assert.equal(probed.state, "owned");
      if (probed.state === "owned") {
        assert.include(probed.owner, { pid: 4242, legacy: true, kind: "server" });
      }
      const refused = yield* acquireDatabaseServer(
        dbPath,
        { launcher: "serve" },
        { waitMs: 0 },
      ).pipe(asProcess(world, 200, realListening), Effect.scoped, Effect.exit);
      const error = ownedFailure(refused);
      assert.equal(error.owner?.legacy, true);
      assert.include(
        error.message,
        `An older Ryco server (pid 4242, listening on 127.0.0.1:${port}`,
      );
      // It removed the lock it created before it found the older server.
      assert.isFalse(NodeFS.existsSync(databaseOwnerLockPath(dbPath)));

      // The port closed: a pid that is alive but serves nothing is not a Ryco server.
      yield* Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve())));
      const acquired = yield* acquireDatabaseServer(
        dbPath,
        { launcher: "serve" },
        { waitMs: 0 },
      ).pipe(asProcess(world, 200, realListening), Effect.scoped, Effect.exit);
      assert.isTrue(Exit.isSuccess(acquired));
    }).pipe(Effect.ensuring(cleanup(dbPath)));
  });

  it.effect("skips the lock, loudly, when RYCO_DB_OWNER_LOCK=off", () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ryco-db-owner-off-"));
    const messages: Array<string> = [];
    const logger = Logger.make(({ message }) => {
      messages.push(String(Array.isArray(message) ? message[0] : message));
    });
    return Effect.gen(function* () {
      const lease = yield* DatabaseOwnerLease;
      assert.isFalse(lease.enforced);
      assert.isFalse(NodeFS.existsSync(databaseOwnerLockPath(lease.dbPath)));
      assert.isTrue(messages.some((message) => message.includes("RYCO_DB_OWNER_LOCK=off")));
    }).pipe(
      Effect.provide(
        DatabaseOwnerLeaseLive.pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
          Layer.provide(NodeServices.layer),
          Layer.provide(
            ConfigProvider.layer(ConfigProvider.fromUnknown({ RYCO_DB_OWNER_LOCK: "off" })),
          ),
          Layer.provide(Logger.layer([logger], { mergeWithExisting: false })),
        ),
      ),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true }))),
    );
  });

  it.effect("holds the server's database for the layer's lifetime", () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ryco-db-owner-layer-"));
    return Effect.gen(function* () {
      const lockPath = yield* Effect.scoped(
        Effect.gen(function* () {
          const lease = yield* DatabaseOwnerLease;
          assert.isTrue(lease.enforced);
          assert.equal(lease.owner.launcher, "serve");
          assert.isTrue(NodeFS.existsSync(lease.lockPath));
          return lease.lockPath;
        }).pipe(
          Effect.provide(
            DatabaseOwnerLeaseLive.pipe(
              Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
              Layer.provide(NodeServices.layer),
              Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
            ),
          ),
        ),
      );
      assert.isFalse(NodeFS.existsSync(lockPath));
    }).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true }))),
    );
  });
});

describe("database owner messages", () => {
  const owner = (overrides: Partial<DatabaseOwner>): DatabaseOwner => ({
    pid: 4242,
    kind: "server",
    startedAt: new Date(2026, 9, 23, 15, 1).toISOString(),
    purpose: "serve",
    launcher: "desktop",
    appVersion: "0.1.36",
    schemaSupported: 93,
    schemaDigest: "x",
    legacy: false,
    self: false,
    ...overrides,
  });
  const message = (value: DatabaseOwner | null, reason: DatabaseOwnedError["reason"] = "held") =>
    describeDatabaseOwnedFailure({
      dbPath: "/data/userdata/state.sqlite",
      lockPath: "/data/userdata/state.sqlite.owner",
      owner: value,
      reason,
      nowMs: new Date(2026, 9, 23, 16, 0).getTime(),
    });

  it("names the owner and what to do about it", () => {
    assert.equal(
      message(owner({})),
      "Another Ryco server is using this data directory: the Ryco desktop app (pid 4242, version 0.1.36, running since 15:01). Only one Ryco server can use /data/userdata at a time. Quit the other one, or start this one with a different --base-dir.",
    );
    assert.include(
      message(owner({ launcher: "service", serviceLabel: "com.ryco.node", pid: 777 })),
      "the background service com.ryco.node (pid 777, version 0.1.36, running since 15:01)",
    );
    assert.equal(
      message(owner({ kind: "maintenance", launcher: "cli", purpose: "cli-migration", pid: 888 })),
      "Ryco is upgrading or repairing this database in another process (`ryco` (pid 888, version 0.1.36, started 15:01)). Wait for it to finish, then retry.",
    );
    assert.equal(
      message(
        owner({
          legacy: true,
          launcher: "unknown",
          appVersion: "unknown",
          endpoint: "127.0.0.1:3773",
        }),
      ),
      "An older Ryco server (pid 4242, listening on 127.0.0.1:3773, started 15:01) is using /data/userdata. Quit it first.",
    );
    assert.include(
      message(null, "unreadable"),
      "cannot read /data/userdata/state.sqlite.owner (permission denied)",
    );
    assert.include(
      message(owner({ startedAt: new Date(2026, 9, 21, 9, 5).toISOString() })),
      "running since 2026-10-21 09:05",
    );
  });
});

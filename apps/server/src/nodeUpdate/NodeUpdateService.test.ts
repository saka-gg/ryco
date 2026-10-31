import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { NodeUpdateError, type NodeUpdateState } from "@ryco/contracts";
import type {
  DesktopAppUpdateRequestFrame,
  DesktopAppUpdateSnapshot,
} from "@ryco/shared/desktopResourceTelemetry";
import { Deferred, Duration, Effect, Fiber, FileSystem, Option, Path, Stream } from "effect";

import type { DesktopAppUpdateBridge } from "../desktopAppUpdateBridge.ts";
import { npmGlobalInstallLockKey } from "../provider/installLockKeys.ts";
import type { ProviderInstallLockRuntime } from "../provider/providerInstallLock.ts";
import { NODE_UPDATE_INSTALL_LOCK_HELD_MESSAGE } from "./cliUpdate.ts";
import type { DetectedNodeInstallation } from "./installation.ts";
import { type NodeUpdateMarker, readNodeUpdateMarker, writeNodeUpdateMarker } from "./marker.ts";
import {
  confirmNodeUpdateAfterServe,
  makeNodeUpdateService,
  NodeUpdateService,
  type NodeUpdateRuntime,
  type NodeUpdateServiceShape,
  type UnattendedNodeUpdate,
} from "./NodeUpdateService.ts";
import {
  armNodeBootWatchdog,
  disarmNodeBootWatchdog,
  isNodeBootWatchdogArmed,
  NODE_UPDATE_AUTO_SKIP_FILE_NAME,
  NODE_UPDATE_MAX_BOOT_ATTEMPTS,
  NODE_UPDATE_ROLLBACK_TRIES,
  NODE_UPDATE_PREFLIGHT_ARG,
  NODE_UPDATE_PREFLIGHT_PASSED,
  NODE_UPDATE_PREFLIGHT_STARTED,
} from "./updateProtocol.ts";
import type {
  NodeServiceRestartTarget,
  NodeUpdateCommand,
  NodeUpdateCommandResult,
} from "./processes.ts";

const serviceNpm: DetectedNodeInstallation = {
  kind: "npm-global",
  service: "launchd",
  serviceLabel: "space.ryco.node",
  npmPrefix: "/opt/homebrew",
  entryScript: "/opt/homebrew/lib/node_modules/ryco-cli/dist/bin.mjs",
  pinnedRelease: false,
};
const desktopApp: DetectedNodeInstallation = {
  kind: "desktop-app",
  service: null,
  serviceLabel: null,
  npmPrefix: null,
  entryScript: null,
  pinnedRelease: false,
};

const ok = (stdout = ""): NodeUpdateCommandResult => ({
  exitCode: 0,
  timedOut: false,
  spawnError: null,
  stdout,
  stderr: "",
});
const exited = (exitCode: number, stderr: string, stdout = ""): NodeUpdateCommandResult => ({
  exitCode,
  timedOut: false,
  spawnError: null,
  stdout,
  stderr,
});
const passedPreflight = (version: string) =>
  ok(`${NODE_UPDATE_PREFLIGHT_STARTED}\n${NODE_UPDATE_PREFLIGHT_PASSED} ${version}\n`);
const isPreflight = (command: NodeUpdateCommand) => command.args[1] === NODE_UPDATE_PREFLIGHT_ARG;

/** A healthy machine: every install works and the installed CLI passes its preflight. */
const healthy =
  (installedVersion: { value: string }) =>
  (command: NodeUpdateCommand): Effect.Effect<NodeUpdateCommandResult> =>
    Effect.sync(() => {
      const spec = command.args.at(-1) ?? "";
      if (spec.startsWith("ryco-cli@")) {
        installedVersion.value = spec.slice("ryco-cli@".length);
        return ok("added 1 package");
      }
      if (isPreflight(command)) return passedPreflight(installedVersion.value);
      return ok(`ryco v${installedVersion.value}`);
    });

/** The pid every fake installer reports once it runs. */
const INSTALLER_PID = 4242;

/**
 * The host-wide install lock as a person's update meets it: each key a run takes, the pids it
 * records, and how many runs hold it now. With `heldUntil`, another Ryco holds it until then.
 */
const makeFakeInstallLock = (heldUntil?: Deferred.Deferred<void>) => {
  const takes: Array<string> = [];
  const pids: Array<number> = [];
  let holding = 0;
  const runWhenFree: ProviderInstallLockRuntime["runWhenFree"] = (lockKey, onHeld, run) =>
    Effect.gen(function* () {
      takes.push(lockKey);
      if (heldUntil !== undefined) {
        yield* onHeld;
        yield* Deferred.await(heldUntil);
      }
      holding += 1;
      return yield* run((pid) => Effect.sync(() => void pids.push(pid))).pipe(
        Effect.ensuring(Effect.sync(() => void (holding -= 1))),
      );
    });
  return { takes, pids, holding: () => holding, lock: Effect.succeed({ runWhenFree }) };
};

const makeFakeDesktop = () => {
  let current: DesktopAppUpdateSnapshot | null = null;
  let attached = true;
  const listeners = new Set<(snapshot: DesktopAppUpdateSnapshot) => void>();
  const requests: Array<DesktopAppUpdateRequestFrame> = [];
  const bridge: DesktopAppUpdateBridge = {
    current: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    request: (frame) => {
      requests.push(frame);
      return attached;
    },
  };
  return {
    bridge,
    requests,
    report: (snapshot: DesktopAppUpdateSnapshot) => {
      current = snapshot;
      for (const listener of listeners) listener(snapshot);
    },
    detach: () => {
      attached = false;
    },
  };
};

const desktopSnapshot = (
  overrides: Partial<DesktopAppUpdateSnapshot> = {},
): DesktopAppUpdateSnapshot => ({
  enabled: true,
  status: "available",
  channel: "latest",
  currentVersion: "0.1.35",
  availableVersion: "0.1.36",
  downloadedVersion: null,
  downloadPercent: null,
  checkedAt: "2026-10-21T10:00:00.000Z",
  message: null,
  remoteInstall: null,
  ...overrides,
});

interface HarnessOptions {
  readonly installation?: DetectedNodeInstallation;
  readonly packageVersion?: string;
  readonly registry?: string | null;
  /** The `nightly` dist-tag; the default answers `registry` for every channel. */
  readonly nightlyRegistry?: string | null;
  readonly checksEnabled?: boolean;
  readonly runCommand?: NodeUpdateRuntime["runCommand"];
  readonly restartGrace?: Duration.Input;
  readonly marker?: NodeUpdateMarker;
  readonly dir?: string;
  /** Replaces the database copy; the default writes `copy of <database>`. */
  readonly copyDatabase?: NodeUpdateRuntime["copyDatabase"];
  readonly installLock?: ReturnType<typeof makeFakeInstallLock>;
}

const makeHarness = (options: HarnessOptions = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = options.dir ?? (yield* fs.makeTempDirectoryScoped({ prefix: "node-update-" }));
    const markerPath = path.join(dir, "node-update.json");
    const databasePath = path.join(dir, "state.sqlite");
    const updateDirectory = path.join(dir, "node-update");
    if (options.marker) yield* writeNodeUpdateMarker(markerPath, options.marker);
    const copies: Array<string> = [];
    const commands: Array<NodeUpdateCommand> = [];
    const restarts: Array<NodeServiceRestartTarget> = [];
    const restarted = yield* Deferred.make<void>();
    const registry = { value: options.registry === undefined ? "0.1.36" : options.registry };
    const fetches = { count: 0 };
    const installedVersion = { value: options.packageVersion ?? "0.1.35" };
    const runCommand = options.runCommand ?? healthy(installedVersion);
    const desktop = makeFakeDesktop();
    const installLock = options.installLock ?? makeFakeInstallLock();
    // Per command: whether it ran as an installer (its pid recorded with the install lock).
    const recordsPid: Array<boolean> = [];
    const runtime: NodeUpdateRuntime = {
      packageVersion: options.packageVersion ?? "0.1.35",
      platform: "darwin",
      execPath: "/opt/homebrew/bin/node",
      detectInstallation: Effect.succeed(options.installation ?? serviceNpm),
      markerPath,
      databasePath,
      updateDirectory,
      copyDatabase: (destination) =>
        Effect.suspend(() => {
          copies.push(destination);
          return options.copyDatabase
            ? options.copyDatabase(destination)
            : fs.makeDirectory(path.dirname(destination), { recursive: true }).pipe(
                Effect.andThen(fs.writeFileString(destination, `copy of ${databasePath}`)),
                Effect.mapError((error) => new NodeUpdateError({ reason: error.message })),
              );
        }),
      latestCachePath: path.join(dir, "caches", "_node-latest-release.json"),
      fetchLatestVersion: (channel) =>
        Effect.sync(() => {
          fetches.count += 1;
          return channel === "nightly" && options.nightlyRegistry !== undefined
            ? options.nightlyRegistry
            : registry.value;
        }),
      automaticChecksEnabled: Effect.succeed(options.checksEnabled ?? true),
      runCommand: (command, onSpawned) =>
        Effect.suspend(() => {
          commands.push(command);
          recordsPid.push(onSpawned !== undefined);
          return (onSpawned === undefined ? Effect.void : onSpawned(INSTALLER_PID)).pipe(
            Effect.orDie,
            Effect.andThen(runCommand(command)),
          );
        }),
      installLock: installLock.lock,
      restart: (target) =>
        Effect.sync(() => {
          restarts.push(target);
        }).pipe(Effect.andThen(Deferred.succeed(restarted, undefined))),
      desktop: desktop.bridge,
      restartDelay: 0,
      restartGrace: options.restartGrace ?? Duration.infinity,
      restartRecheck: 0,
    };
    const service = yield* makeNodeUpdateService(runtime);
    const waitFor = (predicate: (state: NodeUpdateState) => boolean) =>
      service.changes.pipe(
        Stream.filter(predicate),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
        Effect.timeout("5 seconds"),
      );
    return {
      service,
      commands,
      recordsPid,
      installLock,
      restarts,
      restarted,
      registry,
      fetches,
      desktop,
      dir,
      markerPath,
      databasePath,
      updateDirectory,
      copies,
      waitFor,
    };
  });

const update = { targetVersion: "0.1.36", requestId: "update-1" };

describe("node self-update (CLI service)", () => {
  it.live("installs the release into the same prefix, checks it, and restarts the service", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const accepted = yield* harness.service.update(update);
      expect(accepted.run).toMatchObject({
        status: "preparing",
        requestId: "update-1",
        fromVersion: "0.1.35",
        targetVersion: "0.1.36",
      });
      yield* Deferred.await(harness.restarted).pipe(Effect.timeout("5 seconds"));

      const preflightCopy = `${harness.updateDirectory}/preflight.sqlite`;
      const snapshot = `${harness.updateDirectory}/pre-0.1.35.sqlite`;
      expect(harness.commands.map((command) => [command.command, ...command.args])).toEqual([
        ["npm", "install", "-g", "--prefix", "/opt/homebrew", "ryco-cli@0.1.36"],
        [
          "/opt/homebrew/bin/node",
          "/opt/homebrew/lib/node_modules/ryco-cli/dist/bin.mjs",
          "node-update-preflight",
          "--database",
          preflightCopy,
        ],
      ]);
      // The preflight's copy, then the snapshot right before the restart.
      expect(harness.copies).toEqual([preflightCopy, snapshot]);
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.exists(preflightCopy)).toBe(false);
      expect(yield* fs.readFileString(snapshot)).toBe(`copy of ${harness.databasePath}`);
      expect(harness.restarts).toEqual([{ manager: "launchd", label: "space.ryco.node" }]);
      expect((yield* harness.service.current).run.status).toBe("restarting");
      const marker = yield* readNodeUpdateMarker(harness.markerPath);
      expect(Option.getOrThrow(marker)).toEqual({
        requestId: "update-1",
        fromVersion: "0.1.35",
        targetVersion: "0.1.36",
        startedAt: accepted.run.startedAt,
        rollback: {
          install: {
            command: "npm",
            args: ["install", "-g", "--prefix", "/opt/homebrew", "ryco-cli@0.1.35"],
            timeoutMs: 600_000,
          },
          databasePath: harness.databasePath,
          snapshotPath: snapshot,
        },
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("moves a CLI node to the nightly channel when asked, through the same install", () =>
    Effect.gen(function* () {
      const nightly = "0.1.37-nightly.20261101.4";
      const harness = yield* makeHarness({
        packageVersion: "0.1.36",
        registry: "0.1.36",
        nightlyRegistry: nightly,
        runCommand: healthy({ value: nightly }),
      });
      // Without the channel, the node's own channel has nothing newer.
      const sameChannel = yield* Effect.flip(
        harness.service.update({ targetVersion: nightly, requestId: "update-n" }),
      );
      expect(sameChannel.reason).toContain("The newest release is 0.1.36 now");
      const accepted = yield* harness.service.update({
        targetVersion: nightly,
        requestId: "update-n",
        channel: "nightly",
      });
      expect(accepted.run).toMatchObject({ status: "preparing", targetVersion: nightly });
      yield* Deferred.await(harness.restarted).pipe(Effect.timeout("5 seconds"));
      expect(harness.commands[0]?.args.at(-1)).toBe(`ryco-cli@${nightly}`);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("never moves a nightly node back to an older stable release", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        packageVersion: "0.1.37-nightly.20261101.4",
        registry: "0.1.36",
        nightlyRegistry: "0.1.37-nightly.20261101.4",
      });
      const refused = yield* Effect.flip(
        harness.service.update({ targetVersion: "0.1.36", requestId: "back", channel: "latest" }),
      );
      expect(refused.reason).toContain("A channel switch never downgrades");
      expect(harness.commands).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("keeps only the newest snapshot in the update directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "node-update-" });
      yield* fs.makeDirectory(`${dir}/node-update`, { recursive: true });
      yield* fs.writeFileString(`${dir}/node-update/pre-0.1.34.sqlite`, "older snapshot");
      yield* fs.writeFileString(`${dir}/node-update/failed-0.1.35.sqlite`, "rolled back");
      const harness = yield* makeHarness({ dir });
      yield* harness.service.update(update);
      yield* Deferred.await(harness.restarted).pipe(Effect.timeout("5 seconds"));
      expect(yield* fs.readDirectory(harness.updateDirectory)).toEqual(["pre-0.1.35.sqlite"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("checks a release that predates the preflight with --version", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        runCommand: (command) =>
          Effect.succeed(
            isPreflight(command)
              ? exited(1, "ERROR\n  Unrecognized flag: --database in command ryco", "USAGE ...")
              : command.args.at(-1) === "--version"
                ? ok("ryco v0.1.36")
                : ok("added 1 package"),
          ),
      });
      yield* harness.service.update(update);
      yield* Deferred.await(harness.restarted).pipe(Effect.timeout("5 seconds"));
      expect(harness.commands.map((command) => command.args.at(-1))).toEqual([
        "ryco-cli@0.1.36",
        `${harness.updateDirectory}/preflight.sqlite`,
        "--version",
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reinstalls the previous release when the preflight fails", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        runCommand: (command) =>
          Effect.succeed(
            isPreflight(command)
              ? exited(
                  1,
                  "Ryco 0.1.36 could not migrate the database copy: SqliteError: no such column",
                  `${NODE_UPDATE_PREFLIGHT_STARTED}\n`,
                )
              : ok("added 1 package"),
          ),
      });
      yield* harness.service.update(update);
      const failed = yield* harness.waitFor((state) => state.run.status === "failed");

      expect(failed.run.message).toBe(
        "node exited with code 1 while checking 0.1.36. Reinstalled 0.1.35.",
      );
      expect(failed.run.output).toContain("no such column");
      // No --version fallback: this release knows the preflight, and it failed.
      expect(harness.commands.map((command) => command.args.at(-1))).toEqual([
        "ryco-cli@0.1.36",
        `${harness.updateDirectory}/preflight.sqlite`,
        "ryco-cli@0.1.35",
      ]);
      expect(harness.restarts).toEqual([]);
      expect(Option.isNone(yield* readNodeUpdateMarker(harness.markerPath))).toBe(true);
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.exists(`${harness.updateDirectory}/preflight.sqlite`)).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("fails a preflight that times out instead of falling back to --version", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        runCommand: (command) =>
          Effect.succeed(
            isPreflight(command)
              ? { exitCode: null, timedOut: true, spawnError: null, stdout: "", stderr: "" }
              : ok("added 1 package"),
          ),
      });
      yield* harness.service.update(update);
      const failed = yield* harness.waitFor((state) => state.run.status === "failed");
      expect(failed.run.message).toBe("node timed out while checking 0.1.36. Reinstalled 0.1.35.");
      expect(harness.commands.some((command) => command.args.at(-1) === "--version")).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reinstalls the previous release when the database cannot be copied", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        copyDatabase: (destination) =>
          destination.endsWith("pre-0.1.35.sqlite")
            ? Effect.fail(new NodeUpdateError({ reason: "Not enough free space." }))
            : Effect.void,
      });
      yield* harness.service.update(update);
      const failed = yield* harness.waitFor((state) => state.run.status === "failed");
      expect(failed.run.message).toBe(
        "Could not save the database before restarting: Not enough free space. Reinstalled 0.1.35.",
      );
      expect(harness.restarts).toEqual([]);
      expect(Option.isNone(yield* readNodeUpdateMarker(harness.markerPath))).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reinstalls the previous release when the install fails", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        runCommand: (command) =>
          Effect.succeed(
            command.args.at(-1) === "ryco-cli@0.1.36"
              ? exited(1, "npm ERR! code EACCES")
              : ok("added 1 package"),
          ),
      });
      yield* harness.service.update(update);
      const failed = yield* harness.waitFor((state) => state.run.status === "failed");

      expect(failed.run.message).toBe(
        "npm exited with code 1 while installing 0.1.36. Reinstalled 0.1.35.",
      );
      expect(failed.run.output).toContain("EACCES");
      expect(failed.run.finishedAt).not.toBeNull();
      expect(harness.commands.map((command) => command.args.at(-1))).toEqual([
        "ryco-cli@0.1.36",
        "ryco-cli@0.1.35",
      ]);
      expect(harness.restarts).toEqual([]);
      expect(Option.isNone(yield* readNodeUpdateMarker(harness.markerPath))).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("fails and rolls back when the installed release reports another version", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        runCommand: (command) =>
          Effect.succeed(isPreflight(command) ? passedPreflight("0.1.35") : ok()),
      });
      yield* harness.service.update(update);
      const failed = yield* harness.waitFor((state) => state.run.status === "failed");

      expect(failed.run.message).toBe(
        "The installed release is 0.1.35, not 0.1.36. Reinstalled 0.1.35.",
      );
      expect(failed.run.output).toContain(`${NODE_UPDATE_PREFLIGHT_PASSED} 0.1.35`);
      expect(harness.commands.at(-1)?.args.at(-1)).toBe("ryco-cli@0.1.35");
      expect(harness.restarts).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("refuses a target that is not the registry's newest release", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registry: "0.1.37" });
      const error = yield* Effect.flip(harness.service.update(update));
      expect(error.reason).toBe(
        "The newest release is 0.1.37 now, not 0.1.36. Review it and try again.",
      );
      expect(harness.fetches.count).toBe(1);
      expect(harness.commands).toEqual([]);
      expect((yield* harness.service.current).run.status).toBe("idle");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("refuses a release that is not newer, and an unreachable registry", () =>
    Effect.gen(function* () {
      const current = yield* makeHarness({ registry: "0.1.35" });
      expect(
        (yield* Effect.flip(current.service.update({ ...update, targetVersion: "0.1.35" }))).reason,
      ).toBe("This node already runs 0.1.35.");
      const offline = yield* makeHarness({ registry: null });
      expect((yield* Effect.flip(offline.service.update(update))).reason).toContain("npm registry");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("refuses a second update while one is running", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        runCommand: (command) =>
          command.args.at(-1) === "ryco-cli@0.1.36"
            ? Deferred.await(release).pipe(Effect.as(ok()))
            : Effect.succeed(passedPreflight("0.1.36")),
      });
      yield* harness.service.update(update);
      const error = yield* Effect.flip(
        harness.service.update({ ...update, requestId: "update-2" }),
      );
      expect(error.reason).toBe("An update is already running on this node.");
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(harness.restarted).pipe(Effect.timeout("5 seconds"));
      expect(harness.restarts).toHaveLength(1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("refuses a foreground node with its manual reason", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        installation: { ...serviceNpm, service: null, serviceLabel: null },
      });
      const state = yield* harness.service.current;
      expect(state).toMatchObject({
        canUpdate: false,
        manualCommand: "npm install -g ryco-cli@latest",
        installation: { kind: "npm-global", service: null },
      });
      expect((yield* Effect.flip(harness.service.update(update))).reason).toBe(state.manualReason);
      expect(harness.fetches.count).toBe(0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  const unattended = (
    beforeRestart: Effect.Effect<boolean>,
    extra: Partial<UnattendedNodeUpdate> = {},
  ): { readonly unattended: UnattendedNodeUpdate } => ({
    unattended: {
      beforeRestart,
      restartWindow: Effect.succeed(true),
      recordInstallerPid: () => Effect.void,
      minimumReleaseAge: Duration.hours(48),
      ...extra,
    },
  });
  /** Answers each call with the next of `values`, then with the last one. */
  const answers = (...values: ReadonlyArray<boolean>) => {
    let calls = 0;
    return {
      effect: Effect.sync(() => values[Math.min(calls++, values.length - 1)]!),
      calls: () => calls,
    };
  };
  const preflightCopyOf = (harness: { readonly updateDirectory: string }) =>
    `${harness.updateDirectory}/preflight.sqlite`;
  /** The installed spec, or the preflight's database copy, of each command. */
  const commandTargets = (harness: { readonly commands: ReadonlyArray<NodeUpdateCommand> }) =>
    harness.commands.map((command) => command.args.at(-1));

  it.live("records an update the node runs on its own in the marker", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const asked: Array<number> = [];
      const accepted = yield* harness.service.update(
        { ...update, requestId: "auto-1" },
        unattended(Effect.sync(() => asked.push(harness.copies.length)).pipe(Effect.as(true))),
      );
      yield* Deferred.await(harness.restarted).pipe(Effect.timeout("5 seconds"));
      // Asked after the preflight's copy, and again once the snapshot was taken.
      expect(asked).toEqual([1, 2]);
      const marker = Option.getOrThrow(yield* readNodeUpdateMarker(harness.markerPath));
      expect(marker).toMatchObject({
        requestId: "auto-1",
        targetVersion: "0.1.36",
        startedAt: accepted.run.startedAt,
        unattended: true,
      });
      expect(marker.rollback).toBeDefined();
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("puts the previous release back when the node got busy before the restart", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.service.update(update, unattended(Effect.succeed(false)));
      const state = yield* harness.waitFor((value) => value.run.status === "postponed");
      expect(state.run.message).toBe(
        "Someone started using this node before it could restart into 0.1.36. Reinstalled 0.1.35. It updates once the node is quiet again.",
      );
      // The previous release is checked like the target was.
      expect(commandTargets(harness)).toEqual([
        "ryco-cli@0.1.36",
        preflightCopyOf(harness),
        "ryco-cli@0.1.35",
        preflightCopyOf(harness),
      ]);
      expect(harness.restarts).toEqual([]);
      expect(Option.isNone(yield* readNodeUpdateMarker(harness.markerPath))).toBe(true);
      // Postponed is settled: a person can update now.
      expect(state.canUpdate).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("keeps the releases unattended updates skip through the snapshot cleanup", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "node-update-" });
      yield* fs.makeDirectory(`${dir}/node-update`, { recursive: true });
      const skipFile = `${dir}/node-update/${NODE_UPDATE_AUTO_SKIP_FILE_NAME}`;
      yield* fs.writeFileString(skipFile, '{"versions":["0.1.34"]}\n');
      yield* fs.writeFileString(`${dir}/node-update/pre-0.1.34.sqlite`, "older snapshot");
      const harness = yield* makeHarness({ dir });
      yield* harness.service.update(update);
      yield* Deferred.await(harness.restarted).pipe(Effect.timeout("5 seconds"));
      expect((yield* fs.readDirectory(harness.updateDirectory)).toSorted()).toEqual([
        NODE_UPDATE_AUTO_SKIP_FILE_NAME,
        "pre-0.1.35.sqlite",
      ]);
      expect(yield* fs.readFileString(skipFile)).toBe('{"versions":["0.1.34"]}\n');
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("asks again once the restart is recorded, and takes the record back when busy", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const fs = yield* FileSystem.FileSystem;
      const window = answers(true, false);
      let markerWhenAsked: boolean | null = null;
      yield* harness.service.update(
        update,
        unattended(
          Effect.gen(function* () {
            if (window.calls() === 1) {
              markerWhenAsked = Option.isSome(yield* readNodeUpdateMarker(harness.markerPath));
            }
            return yield* window.effect;
          }).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
        ),
      );
      const state = yield* harness.waitFor((value) => value.run.status === "postponed");
      expect(window.calls()).toBe(2);
      // The second answer came once the snapshot and the marker were written.
      expect(markerWhenAsked).toBe(true);
      expect(Option.isNone(yield* readNodeUpdateMarker(harness.markerPath))).toBe(true);
      expect(yield* fs.exists(`${harness.updateDirectory}/pre-0.1.35.sqlite`)).toBe(false);
      expect(commandTargets(harness).slice(-2)).toEqual([
        "ryco-cli@0.1.35",
        preflightCopyOf(harness),
      ]);
      expect(state.run.message).toContain("Reinstalled 0.1.35.");
      expect(harness.restarts).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "restarts into the release at the next quiet moment when the previous one cannot go back",
    () =>
      Effect.gen(function* () {
        const installedVersion = { value: "0.1.35" };
        const base = healthy(installedVersion);
        const harness = yield* makeHarness({
          runCommand: (command) =>
            command.args.at(-1) === "ryco-cli@0.1.35"
              ? Effect.succeed(exited(1, "ETARGET"))
              : base(command),
        });
        const window = answers(false, false, true);
        const accepted = yield* harness.service.update(
          update,
          unattended(Effect.succeed(false), { restartWindow: window.effect }),
        );
        yield* Deferred.await(harness.restarted).pipe(Effect.timeout("5 seconds"));
        // It waited for the window, and did not end failed with a release on disk it never ran.
        expect(window.calls()).toBe(3);
        expect(harness.restarts).toEqual([{ manager: "launchd", label: "space.ryco.node" }]);
        // The target was checked again before it became what runs next.
        expect(commandTargets(harness)).toEqual([
          "ryco-cli@0.1.36",
          preflightCopyOf(harness),
          "ryco-cli@0.1.35",
          preflightCopyOf(harness),
        ]);
        const marker = Option.getOrThrow(yield* readNodeUpdateMarker(harness.markerPath));
        expect(marker).toMatchObject({ requestId: "update-1", unattended: true });
        expect(marker.rollback?.snapshotPath).toBe(`${harness.updateDirectory}/pre-0.1.35.sqlite`);
        // A fresh snapshot right before the restart, and a marker as young as the restart.
        expect(harness.copies.filter((copy) => copy.endsWith("pre-0.1.35.sqlite"))).toHaveLength(2);
        expect(Date.parse(marker.startedAt)).toBeGreaterThanOrEqual(
          Date.parse(accepted.run.startedAt!),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("guards the next start as soon as it knows the previous release cannot go back", () =>
    Effect.gen(function* () {
      const installedVersion = { value: "0.1.35" };
      const base = healthy(installedVersion);
      const harness = yield* makeHarness({
        runCommand: (command) =>
          command.args.at(-1) === "ryco-cli@0.1.35"
            ? Effect.succeed(exited(1, "ETARGET"))
            : base(command),
      });
      yield* harness.service.update(
        update,
        unattended(Effect.succeed(false), { restartWindow: Effect.succeed(false) }),
      );
      const waiting = yield* harness.waitFor((value) => value.run.status === "waiting");
      expect(waiting.run.message).toBe(
        "Someone started using this node before it could restart into 0.1.36. npm exited with code 1 while reinstalling 0.1.35. Ryco 0.1.36 is installed and checked, so the node restarts into it once nobody is using it.",
      );
      // A crash or reboot meanwhile starts the target under the boot guard and the watchdog.
      const marker = Option.getOrThrow(yield* readNodeUpdateMarker(harness.markerPath));
      expect(marker).toMatchObject({ unattended: true, targetVersion: "0.1.36" });
      expect(marker.rollback).toBeDefined();
      expect(harness.restarts).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "goes forward to the release when the previous one fails its check after the reinstall",
    () =>
      Effect.gen(function* () {
        const installedVersion = { value: "0.1.35" };
        const base = healthy(installedVersion);
        const harness = yield* makeHarness({
          runCommand: (command) =>
            isPreflight(command) && installedVersion.value === "0.1.35"
              ? Effect.succeed(exited(1, "native module missing", NODE_UPDATE_PREFLIGHT_STARTED))
              : base(command),
        });
        yield* harness.service.update(update, unattended(Effect.succeed(false)));
        yield* Deferred.await(harness.restarted).pipe(Effect.timeout("5 seconds"));
        expect(commandTargets(harness)).toEqual([
          "ryco-cli@0.1.36",
          preflightCopyOf(harness),
          "ryco-cli@0.1.35",
          preflightCopyOf(harness),
          "ryco-cli@0.1.36",
          preflightCopyOf(harness),
        ]);
        expect(Option.getOrThrow(yield* readNodeUpdateMarker(harness.markerPath))).toMatchObject({
          unattended: true,
        });
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("takes this installation's install lock, waiting while another Ryco holds it", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      const installLock = makeFakeInstallLock(release);
      const harness = yield* makeHarness({ installLock });
      yield* harness.service.update(update);
      const waiting = yield* harness.waitFor(
        (value) => value.run.message === NODE_UPDATE_INSTALL_LOCK_HELD_MESSAGE,
      );
      expect(waiting.run.status).toBe("preparing");
      expect(harness.commands).toEqual([]);
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(harness.restarted).pipe(Effect.timeout("5 seconds"));
      // The key a provider CLI update into the same npm prefix takes.
      expect(installLock.takes).toEqual([npmGlobalInstallLockKey("/opt/homebrew")]);
      // The installer's pid is recorded with the lock; the preflight is no installer.
      expect(harness.recordsPid).toEqual([true, false]);
      expect(installLock.pids).toEqual([INSTALLER_PID]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("holds the lock for the reinstall of a failed update too", () =>
    Effect.gen(function* () {
      const installLock = makeFakeInstallLock();
      const held: Array<number> = [];
      const harness = yield* makeHarness({
        installLock,
        runCommand: (command) =>
          Effect.sync(() => {
            held.push(installLock.holding());
            return command.args.at(-1) === "ryco-cli@0.1.36" ? exited(1, "EACCES") : ok();
          }),
      });
      yield* harness.service.update(update);
      const failed = yield* harness.waitFor((value) => value.run.status === "failed");
      expect(failed.run.message).toBe(
        "npm exited with code 1 while installing 0.1.36. Reinstalled 0.1.35.",
      );
      expect(commandTargets(harness)).toEqual(["ryco-cli@0.1.36", "ryco-cli@0.1.35"]);
      expect(held).toEqual([1, 1]);
      expect(installLock.pids).toEqual([INSTALLER_PID, INSTALLER_PID]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("records the installer with the lock an unattended caller holds, without taking it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const recorded: Array<number> = [];
      yield* harness.service.update(
        update,
        unattended(Effect.succeed(true), {
          recordInstallerPid: (pid) => Effect.sync(() => void recorded.push(pid)),
        }),
      );
      yield* Deferred.await(harness.restarted).pipe(Effect.timeout("5 seconds"));
      expect(harness.installLock.takes).toEqual([]);
      expect(recorded).toEqual([INSTALLER_PID]);
      expect(yield* harness.service.installLockKey).toBe(npmGlobalInstallLockKey("/opt/homebrew"));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("holds back brand-new dependency releases in an update nobody asked for", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const before = Date.now();
      yield* harness.service.update(update, unattended(Effect.succeed(true)));
      yield* Deferred.await(harness.restarted).pipe(Effect.timeout("5 seconds"));
      const args = harness.commands[0]!.args;
      expect(args.slice(0, 4)).toEqual(["install", "-g", "--prefix", "/opt/homebrew"]);
      expect(args.at(-1)).toBe("ryco-cli@0.1.36");
      expect(args[4]).toMatch(/^--before=/u);
      const age = before - Date.parse(args[4]!.replace(/^--before=/u, ""));
      expect(age).toBeGreaterThanOrEqual(Duration.toMillis(Duration.hours(48)) - 60_000);
      expect(age).toBeLessThanOrEqual(Duration.toMillis(Duration.hours(48)));
      // The rollback the boot guard runs holds them back as well.
      const marker = Option.getOrThrow(yield* readNodeUpdateMarker(harness.markerPath));
      expect(marker.rollback?.install.args).toContain(args[4]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("updates a pnpm install unattended only with a pnpm that holds back new releases", () =>
    Effect.gen(function* () {
      const servicePnpm: DetectedNodeInstallation = {
        ...serviceNpm,
        kind: "pnpm-global",
        npmPrefix: null,
        entryScript: "/Users/me/Library/pnpm/global/5/node_modules/ryco-cli/dist/bin.mjs",
      };
      const withPnpm = (pnpmVersion: string) => {
        const installedVersion = { value: "0.1.35" };
        const base = healthy(installedVersion);
        return makeHarness({
          installation: servicePnpm,
          runCommand: (command) =>
            command.command === "pnpm" && command.args[0] === "--version"
              ? Effect.succeed(ok(`${pnpmVersion}\n`))
              : base(command),
        });
      };
      const old = yield* withPnpm("10.15.1");
      const refused = yield* Effect.flip(
        old.service.update(update, unattended(Effect.succeed(true))),
      );
      expect(refused.reason).toBe(
        "pnpm 10.15.1 cannot hold back brand-new dependency releases, so this node does not update itself. pnpm 10.16 or later can.",
      );
      expect(commandTargets(old)).toEqual(["--version"]);

      const current = yield* withPnpm("10.16.0");
      yield* current.service.update(update, unattended(Effect.succeed(true)));
      yield* Deferred.await(current.restarted).pipe(Effect.timeout("5 seconds"));
      expect(current.commands[1]).toMatchObject({
        command: "pnpm",
        args: ["add", "-g", "--config.minimumReleaseAge=2880", "ryco-cli@0.1.36"],
      });
      // A person's update keeps today's command.
      const manual = yield* withPnpm("10.15.1");
      yield* manual.service.update(update);
      yield* Deferred.await(manual.restarted).pipe(Effect.timeout("5 seconds"));
      expect(manual.commands[0]).toMatchObject({ args: ["add", "-g", "ryco-cli@0.1.36"] });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("never updates a bun install unattended", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        installation: { ...serviceNpm, kind: "bun-global", npmPrefix: null },
      });
      const refused = yield* Effect.flip(
        harness.service.update(update, unattended(Effect.succeed(true))),
      );
      expect(refused.reason).toBe(
        "Only an npm or pnpm install can hold back brand-new dependency releases, so this node does not update itself.",
      );
      expect(harness.commands).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("shows its owner why automatic updates leave a release alone", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      expect((yield* harness.service.current).automaticUpdateNote).toBeUndefined();
      yield* harness.service.setAutomaticUpdateNote("Automatic update: Ryco 0.1.36 is left alone.");
      expect((yield* harness.service.current).automaticUpdateNote).toBe(
        "Automatic update: Ryco 0.1.36 is left alone.",
      );
      yield* harness.service.setAutomaticUpdateNote(null);
      expect("automaticUpdateNote" in (yield* harness.service.current)).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reports a restart that never came", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ restartGrace: Duration.millis(20) });
      yield* harness.service.update(update);
      const failed = yield* harness.waitFor((state) => state.run.status === "failed");
      expect(failed.run.message).toBe(
        "Ryco 0.1.36 is installed, but the node did not restart. Restart it to finish.",
      );
      // The marker stays, so the next start reports the release it comes back on.
      expect(Option.isSome(yield* readNodeUpdateMarker(harness.markerPath))).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("node update after a restart", () => {
  const marker: NodeUpdateMarker = {
    requestId: "update-1",
    fromVersion: "0.1.35",
    targetVersion: "0.1.36",
    startedAt: new Date(Date.now() - 60_000).toISOString(),
  };

  it.live("reports success when the node came back on the target, then forgets it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ packageVersion: "0.1.36", marker });
      const state = yield* harness.waitFor((value) => value.run.status !== "idle");
      expect(state.run).toMatchObject({
        status: "succeeded",
        requestId: "update-1",
        fromVersion: "0.1.35",
        targetVersion: "0.1.36",
      });
      expect(state.currentVersion).toBe("0.1.36");
      expect(Option.isNone(yield* readNodeUpdateMarker(harness.markerPath))).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reports a failure when it came back on another release", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ packageVersion: "0.1.35", marker });
      const state = yield* harness.waitFor((value) => value.run.status !== "idle");
      expect(state.run).toMatchObject({
        status: "failed",
        message: "Restarted on 0.1.35 instead of 0.1.36.",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  const rollback: NonNullable<NodeUpdateMarker["rollback"]> = {
    install: {
      command: "npm",
      args: ["install", "-g", "--prefix", "/opt/homebrew", "ryco-cli@0.1.35"],
      timeoutMs: 600_000,
    },
    databasePath: "/Users/me/.ryco/userdata/state.sqlite",
    snapshotPath: "/Users/me/.ryco/userdata/node-update/pre-0.1.35.sqlite",
  };

  it.live("reports an update it can roll back once the server says the node is ready", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        packageVersion: "0.1.36",
        marker: { ...marker, rollback, bootAttempts: 1 },
      });
      expect(yield* harness.service.awaitsBootReady).toBe(true);
      const pending = yield* harness.service.current;
      expect(pending.run).toMatchObject({ status: "restarting", requestId: "update-1" });
      // Until then the marker stays, so the boot guard keeps counting starts.
      expect(Option.isSome(yield* readNodeUpdateMarker(harness.markerPath))).toBe(true);
      expect((yield* Effect.flip(harness.service.update(update))).reason).toBe(
        "An update is already running on this node.",
      );

      yield* harness.service.confirmBootReady;
      const state = yield* harness.waitFor((value) => value.run.status === "succeeded");
      expect(state.run).toMatchObject({ requestId: "update-1", message: null });
      expect(Option.isNone(yield* readNodeUpdateMarker(harness.markerPath))).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("needs no confirmation without a marker, or for one without a rollback plan", () =>
    Effect.gen(function* () {
      expect(yield* (yield* makeHarness()).service.awaitsBootReady).toBe(false);
      const old = yield* makeHarness({ packageVersion: "0.1.36", marker });
      expect(yield* old.service.awaitsBootReady).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reports a rollback from the previous release", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        packageVersion: "0.1.35",
        marker: {
          ...marker,
          rollback,
          bootAttempts: 3,
          rolledBack: {
            at: new Date().toISOString(),
            failedBoots: 2,
            databaseRestored: true,
            output: "added 1 package",
          },
        },
      });
      expect(yield* harness.service.awaitsBootReady).toBe(false);
      const state = yield* harness.waitFor((value) => value.run.status !== "idle");
      expect(state.run).toMatchObject({
        status: "failed",
        fromVersion: "0.1.35",
        targetVersion: "0.1.36",
        message:
          "Ryco 0.1.36 did not finish starting (2 attempts), so the node rolled back to 0.1.35 and restored the database from before the update.",
        output: "added 1 package",
      });
      expect(Option.isNone(yield* readNodeUpdateMarker(harness.markerPath))).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("exits a release that does not get ready only after an update nobody asked for", () =>
    Effect.gen(function* () {
      const restartedInto = (extra: Partial<NodeUpdateMarker>) =>
        makeHarness({
          packageVersion: "0.1.36",
          marker: { ...marker, rollback, bootAttempts: 1, ...extra },
        });
      // Its startup failed: it will not get ready.
      const readiness = {
        commandReady: Effect.die(new Error("migration failed")),
        hubConnector: null,
      };
      const confirm = (service: NodeUpdateServiceShape) =>
        Effect.gen(function* () {
          const exited = yield* Deferred.make<number>();
          const fiber = yield* confirmNodeUpdateAfterServe(readiness, (code) =>
            Deferred.succeed(exited, code),
          ).pipe(Effect.provideService(NodeUpdateService, service), Effect.forkScoped);
          return { exited, fiber };
        });

      const automatic = yield* restartedInto({ unattended: true });
      expect(yield* automatic.service.awaitsUnattendedBootReady).toBe(true);
      const watched = yield* confirm(automatic.service);
      expect(yield* Deferred.await(watched.exited).pipe(Effect.timeout("5 seconds"))).toBe(1);
      // Never confirmed: the boot guard keeps counting.
      expect((yield* automatic.service.current).run.status).toBe("restarting");
      expect(Option.isSome(yield* readNodeUpdateMarker(automatic.markerPath))).toBe(true);

      const manual = yield* restartedInto({});
      expect(yield* manual.service.awaitsBootReady).toBe(true);
      expect(yield* manual.service.awaitsUnattendedBootReady).toBe(false);
      const left = yield* confirm(manual.service);
      yield* Fiber.join(left.fiber).pipe(Effect.timeout("5 seconds"));
      expect(yield* Deferred.isDone(left.exited)).toBe(false);

      // Once the boot guard gave up rolling back, an exit would only restart it again and again.
      const gaveUp = yield* restartedInto({
        unattended: true,
        bootAttempts: NODE_UPDATE_MAX_BOOT_ATTEMPTS + NODE_UPDATE_ROLLBACK_TRIES + 1,
      });
      expect(yield* gaveUp.service.awaitsBootReady).toBe(true);
      expect(yield* gaveUp.service.awaitsUnattendedBootReady).toBe(false);
      const startedAnyway = yield* confirm(gaveUp.service);
      yield* Fiber.join(startedAnyway.fiber).pipe(Effect.timeout("5 seconds"));
      expect(yield* Deferred.isDone(startedAnyway.exited)).toBe(false);
      // The last start the next one still rolls back after.
      const lastChance = yield* restartedInto({
        unattended: true,
        bootAttempts: NODE_UPDATE_MAX_BOOT_ATTEMPTS,
      });
      expect(yield* lastChance.service.awaitsUnattendedBootReady).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "disarms the boot guard's watchdog once ready, or at once for a start it need not watch",
    () =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.sync(disarmNodeBootWatchdog));
        const ready = { commandReady: Effect.void, hubConnector: null };
        const confirmWith = (service: NodeUpdateServiceShape) =>
          Effect.gen(function* () {
            armNodeBootWatchdog(() => {});
            expect(isNodeBootWatchdogArmed()).toBe(true);
            yield* confirmNodeUpdateAfterServe(ready, () => Effect.void).pipe(
              Effect.provideService(NodeUpdateService, service),
            );
            return isNodeBootWatchdogArmed();
          });
        const restartedInto = (extra: Partial<NodeUpdateMarker>) =>
          makeHarness({
            packageVersion: "0.1.36",
            marker: { ...marker, rollback, bootAttempts: 1, ...extra },
          });

        const automatic = yield* restartedInto({ unattended: true });
        expect(yield* confirmWith(automatic.service)).toBe(false);
        expect(
          (yield* automatic.waitFor((value) => value.run.status === "succeeded")).run.requestId,
        ).toBe("update-1");
        // A person's update, a start past the rollback tries, an ordinary start: nothing to end.
        expect(yield* confirmWith((yield* restartedInto({})).service)).toBe(false);
        expect(
          yield* confirmWith(
            (yield* restartedInto({
              unattended: true,
              bootAttempts: NODE_UPDATE_MAX_BOOT_ATTEMPTS + NODE_UPDATE_ROLLBACK_TRIES + 1,
            })).service,
          ),
        ).toBe(false);
        expect(yield* confirmWith((yield* makeHarness()).service)).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("ignores and deletes a marker older than a day", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        packageVersion: "0.1.36",
        marker: { ...marker, startedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() },
      });
      // An update waits for the boot report, so it is settled once update has answered.
      yield* Effect.flip(harness.service.update({ ...update, targetVersion: "0.1.37" }));
      expect((yield* harness.service.current).run.status).toBe("idle");
      expect(Option.isNone(yield* readNodeUpdateMarker(harness.markerPath))).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("newest release checks", () => {
  it.live("checks once when someone subscribes, then answers from the cache", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const first = yield* harness.waitFor((state) => state.latestVersion !== null);
      expect(first).toMatchObject({
        latestVersion: "0.1.36",
        availability: "behind_latest",
        channel: "latest",
        canUpdate: true,
      });
      expect(first.checkedAt).not.toBeNull();
      yield* harness.waitFor((state) => state.latestVersion !== null);
      expect(harness.fetches.count).toBe(1);

      // An explicit check always asks the registry again.
      harness.registry.value = "0.1.37";
      expect((yield* harness.service.check).latestVersion).toBe("0.1.37");
      expect(harness.fetches.count).toBe(2);

      // A restarted process starts from the persisted answer.
      const restarted = yield* makeHarness({ dir: harness.dir });
      expect(
        (yield* restarted.waitFor((state) => state.latestVersion !== null)).latestVersion,
      ).toBe("0.1.37");
      expect(restarted.fetches.count).toBe(0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("makes no automatic check when update checks are off", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ checksEnabled: false });
      const state = yield* harness.waitFor(() => true);
      expect(state).toMatchObject({ latestVersion: null, availability: "unknown" });
      yield* Effect.sleep("20 millis");
      expect(harness.fetches.count).toBe(0);
      expect((yield* harness.service.check).latestVersion).toBe("0.1.36");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("fails an explicit check the registry does not answer", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registry: null });
      expect((yield* Effect.flip(harness.service.check)).reason).toContain("npm registry");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("does not ask an unreachable registry again on every subscription", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registry: null });
      yield* harness.waitFor(() => true);
      yield* Effect.sleep("20 millis");
      yield* harness.waitFor(() => true);
      yield* Effect.sleep("20 millis");
      expect(harness.fetches.count).toBe(1);
      yield* Effect.flip(harness.service.check);
      expect(harness.fetches.count).toBe(2);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("node self-update (desktop app)", () => {
  it.live("follows the app's updater and relays an install request", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ installation: desktopApp });
      expect((yield* harness.service.current).canUpdate).toBe(false);
      harness.desktop.report(desktopSnapshot());
      const ready = yield* harness.waitFor((state) => state.canUpdate);
      expect(ready).toMatchObject({
        currentVersion: "0.1.35",
        latestVersion: "0.1.36",
        availability: "behind_latest",
        checkedAt: "2026-10-21T10:00:00.000Z",
        installation: { kind: "desktop-app", service: null },
      });

      yield* harness.service.check;
      expect(harness.desktop.requests).toEqual([{ type: "app-update-check" }]);
      expect(harness.fetches.count).toBe(0);

      expect((yield* harness.service.update(update)).run.status).toBe("preparing");
      expect(harness.desktop.requests.at(-1)).toEqual({
        type: "app-update-install",
        requestId: "update-1",
        targetVersion: "0.1.36",
      });
      expect(Option.isSome(yield* readNodeUpdateMarker(harness.markerPath))).toBe(true);

      const remoteInstall = (
        phase: "downloading" | "countdown" | "postponed",
        restartAt: string | null = null,
      ) => ({ requestId: "update-1", targetVersion: "0.1.36", phase, restartAt, message: null });
      harness.desktop.report(
        desktopSnapshot({
          status: "downloading",
          downloadPercent: 40,
          remoteInstall: remoteInstall("downloading"),
        }),
      );
      expect((yield* harness.waitFor((state) => state.run.progressPercent === 40)).run.status).toBe(
        "preparing",
      );
      harness.desktop.report(
        desktopSnapshot({
          status: "downloaded",
          downloadedVersion: "0.1.36",
          remoteInstall: remoteInstall("countdown", "2026-10-21T10:01:00.000Z"),
        }),
      );
      expect(
        (yield* harness.waitFor((state) => state.run.status === "waiting")).run.restartAt,
      ).toBe("2026-10-21T10:01:00.000Z");
      expect(
        (yield* Effect.flip(harness.service.update({ ...update, requestId: "update-2" }))).reason,
      ).toBe("An update is already running on this node.");

      harness.desktop.report(
        desktopSnapshot({ status: "downloaded", remoteInstall: remoteInstall("postponed") }),
      );
      yield* harness.waitFor((state) => state.run.status === "postponed");
      yield* Effect.sleep("20 millis");
      expect(Option.isNone(yield* readNodeUpdateMarker(harness.markerPath))).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("fails an install request the app cannot hear", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ installation: desktopApp });
      harness.desktop.report(desktopSnapshot());
      yield* harness.waitFor((state) => state.canUpdate);
      harness.desktop.detach();
      expect((yield* Effect.flip(harness.service.update(update))).reason).toBe(
        "The desktop app is not connected to this node.",
      );
      expect((yield* harness.service.current).run.status).toBe("failed");
      expect(Option.isNone(yield* readNodeUpdateMarker(harness.markerPath))).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("refuses to update the desktop app unattended", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ installation: desktopApp });
      harness.desktop.report(desktopSnapshot());
      yield* harness.waitFor((state) => state.canUpdate);
      const refused = yield* Effect.flip(
        harness.service.update(update, {
          unattended: {
            beforeRestart: Effect.succeed(true),
            restartWindow: Effect.succeed(true),
            recordInstallerPid: () => Effect.void,
            minimumReleaseAge: Duration.hours(48),
          },
        }),
      );
      expect(refused.reason).toBe("The desktop app does not update itself unattended.");
      expect(harness.desktop.requests).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("refuses a target the app does not offer", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ installation: desktopApp });
      harness.desktop.report(desktopSnapshot({ availableVersion: "0.1.37" }));
      yield* harness.waitFor((state) => state.canUpdate);
      expect((yield* Effect.flip(harness.service.update(update))).reason).toContain("0.1.37");
      expect(harness.desktop.requests).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

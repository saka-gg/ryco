import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { NodeUpdateState } from "@ryco/contracts";
import type {
  DesktopAppUpdateRequestFrame,
  DesktopAppUpdateSnapshot,
} from "@ryco/shared/desktopResourceTelemetry";
import { Deferred, Duration, Effect, FileSystem, Option, Path, Stream } from "effect";

import type { DesktopAppUpdateBridge } from "../desktopAppUpdateBridge.ts";
import type { DetectedNodeInstallation, NodeUpdateCommand } from "./installation.ts";
import { type NodeUpdateMarker, readNodeUpdateMarker, writeNodeUpdateMarker } from "./marker.ts";
import { makeNodeUpdateService, type NodeUpdateRuntime } from "./NodeUpdateService.ts";
import type { NodeServiceRestartTarget, NodeUpdateCommandResult } from "./processes.ts";

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
const exited = (exitCode: number, stderr: string): NodeUpdateCommandResult => ({
  exitCode,
  timedOut: false,
  spawnError: null,
  stdout: "",
  stderr,
});

/** A healthy machine: every install works and the installed CLI reports its release. */
const healthy =
  (installedVersion: { value: string }) =>
  (command: NodeUpdateCommand): Effect.Effect<NodeUpdateCommandResult> =>
    Effect.sync(() => {
      const spec = command.args.at(-1) ?? "";
      if (spec.startsWith("ryco-cli@")) {
        installedVersion.value = spec.slice("ryco-cli@".length);
        return ok("added 1 package");
      }
      return ok(`ryco v${installedVersion.value}`);
    });

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
  readonly checksEnabled?: boolean;
  readonly runCommand?: NodeUpdateRuntime["runCommand"];
  readonly restartGrace?: Duration.Input;
  readonly marker?: NodeUpdateMarker;
  readonly dir?: string;
}

const makeHarness = (options: HarnessOptions = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = options.dir ?? (yield* fs.makeTempDirectoryScoped({ prefix: "node-update-" }));
    const markerPath = path.join(dir, "node-update.json");
    if (options.marker) yield* writeNodeUpdateMarker(markerPath, options.marker);
    const commands: Array<NodeUpdateCommand> = [];
    const restarts: Array<NodeServiceRestartTarget> = [];
    const restarted = yield* Deferred.make<void>();
    const registry = { value: options.registry === undefined ? "0.1.36" : options.registry };
    const fetches = { count: 0 };
    const installedVersion = { value: options.packageVersion ?? "0.1.35" };
    const runCommand = options.runCommand ?? healthy(installedVersion);
    const desktop = makeFakeDesktop();
    const runtime: NodeUpdateRuntime = {
      packageVersion: options.packageVersion ?? "0.1.35",
      platform: "darwin",
      execPath: "/opt/homebrew/bin/node",
      detectInstallation: Effect.succeed(options.installation ?? serviceNpm),
      markerPath,
      latestCachePath: path.join(dir, "caches", "_node-latest-release.json"),
      fetchLatestVersion: () =>
        Effect.sync(() => {
          fetches.count += 1;
          return registry.value;
        }),
      automaticChecksEnabled: Effect.succeed(options.checksEnabled ?? true),
      runCommand: (command) =>
        Effect.suspend(() => {
          commands.push(command);
          return runCommand(command);
        }),
      restart: (target) =>
        Effect.sync(() => {
          restarts.push(target);
        }).pipe(Effect.andThen(Deferred.succeed(restarted, undefined))),
      desktop: desktop.bridge,
      restartDelay: 0,
      restartGrace: options.restartGrace ?? Duration.infinity,
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
      restarts,
      restarted,
      registry,
      fetches,
      desktop,
      dir,
      markerPath,
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

      expect(harness.commands.map((command) => [command.command, ...command.args])).toEqual([
        ["npm", "install", "-g", "--prefix", "/opt/homebrew", "ryco-cli@0.1.36"],
        [
          "/opt/homebrew/bin/node",
          "/opt/homebrew/lib/node_modules/ryco-cli/dist/bin.mjs",
          "--version",
        ],
      ]);
      expect(harness.restarts).toEqual([{ manager: "launchd", label: "space.ryco.node" }]);
      expect((yield* harness.service.current).run.status).toBe("restarting");
      const marker = yield* readNodeUpdateMarker(harness.markerPath);
      expect(Option.getOrThrow(marker)).toMatchObject({
        requestId: "update-1",
        fromVersion: "0.1.35",
        targetVersion: "0.1.36",
      });
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
          Effect.succeed(command.args.at(-1) === "--version" ? ok("ryco v0.1.35") : ok()),
      });
      yield* harness.service.update(update);
      const failed = yield* harness.waitFor((state) => state.run.status === "failed");

      expect(failed.run.message).toBe(
        "The installed release did not report 0.1.36. Reinstalled 0.1.35.",
      );
      expect(failed.run.output).toBe("ryco v0.1.35");
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
            : Effect.succeed(ok("ryco v0.1.36")),
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

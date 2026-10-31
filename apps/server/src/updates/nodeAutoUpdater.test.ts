import { assert, describe, it } from "@effect/vitest";
import {
  NodeUpdateError,
  type NodeUpdateInput,
  type NodeUpdateRun,
  type NodeUpdateState,
} from "@ryco/contracts";
import { Duration, Effect, Stream, SubscriptionRef } from "effect";
import { TestClock } from "effect/testing";

import type { DetectedNodeInstallation } from "../nodeUpdate/installation.ts";
import { nodeInstallLockKey, nodeReleaseChannel } from "../nodeUpdate/installation.ts";
import {
  deriveNodeUpdateState,
  IDLE_NODE_UPDATE_RUN,
  isActiveNodeUpdateRun,
  type NodeUpdateOptions,
} from "../nodeUpdate/NodeUpdateService.ts";
import {
  npmGlobalInstallLockKey,
  PNPM_GLOBAL_INSTALL_LOCK_KEY,
} from "../provider/installLockKeys.ts";
import type { ProviderInstallLockRuntime } from "../provider/providerInstallLock.ts";
import { MINIMUM_RELEASE_AGE } from "../provider/providerReleaseAge.ts";
import { makeClientInteraction } from "./ClientInteraction.ts";
import type { NodeAutoSkipList } from "./nodeAutoSkip.ts";
import {
  FIRST_PASS_DELAY,
  makeNodeAutoUpdater,
  MAX_POSTPONEMENTS,
  POSTPONED_RETRY_AFTER,
  POSTPONED_RETRY_MAX,
  postponedRetryAfter,
  REFUSED_RETRY_AFTER,
  skippedReleaseNote,
  UNREADABLE_SKIP_LIST_NOTE,
} from "./nodeAutoUpdater.ts";
import { makeRestartSensitiveWork } from "./restartSensitiveWork.ts";
import { makeUpdateWindow } from "./updateWindow.ts";

const installation = (
  kind: DetectedNodeInstallation["kind"],
  service: DetectedNodeInstallation["service"] = "launchd",
): DetectedNodeInstallation => ({
  kind,
  service,
  serviceLabel: service === null ? null : "space.ryco.node",
  npmPrefix: kind === "npm-global" ? "/opt/homebrew" : null,
  entryScript:
    kind === "desktop-app" ? null : "/opt/homebrew/lib/node_modules/ryco-cli/dist/bin.mjs",
  pinnedRelease: false,
});
const serviceNpm = installation("npm-global");
const NPM_LOCK_KEY = npmGlobalInstallLockKey("/opt/homebrew");

/** Published three days before the test clock's start: old enough. */
const OLD_RELEASE = -Duration.toMillis(Duration.hours(72));

type UpdateScenario = (
  input: NodeUpdateInput,
  options: NodeUpdateOptions | undefined,
) => Effect.Effect<NodeUpdateRun["status"], NodeUpdateError>;

/**
 * The updater over a fake node (its state derived as `NodeUpdateService` derives it), the real
 * update window with real client reports, an in-memory skip list and an install lock that is
 * always free. `update` records each call and settles the run as `scenario` says; the default
 * asks `beforeRestart` and then restarts (the run stays `restarting`, as when the process ends).
 */
const setup = (
  options: {
    readonly detected?: DetectedNodeInstallation;
    readonly packageVersion?: string;
    readonly latest?: string | null;
    readonly enabled?: boolean;
    readonly skipped?: ReadonlyArray<string>;
    readonly publishedAt?: Readonly<Record<string, number | null>>;
    readonly scenario?: UpdateScenario;
    readonly run?: NodeUpdateRun;
    /** The skip list's file cannot be read. */
    readonly unreadable?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const packageVersion = options.packageVersion ?? "0.1.35";
    const latest = options.latest === undefined ? "0.1.36" : options.latest;
    const runRef = yield* SubscriptionRef.make<NodeUpdateRun>(options.run ?? IDLE_NODE_UPDATE_RUN);
    const toState = (run: NodeUpdateRun): NodeUpdateState =>
      deriveNodeUpdateState({
        packageVersion,
        platform: "darwin",
        installation: options.detected ?? serviceNpm,
        latest:
          latest === null
            ? null
            : {
                channel: nodeReleaseChannel(packageVersion),
                version: latest,
                checkedAt: "2026-10-31T00:00:00.000Z",
              },
        desktop: null,
        run,
      });
    const calls = {
      checks: 0,
      updates: [] as Array<{ input: NodeUpdateInput; options: NodeUpdateOptions | undefined }>,
      lockKeys: [] as Array<string>,
    };
    const skipped = new Set(options.skipped ?? []);
    const skipList: NodeAutoSkipList = {
      status: (version) =>
        Effect.sync(() =>
          options.unreadable ? "unreadable" : skipped.has(version) ? "skipped" : "allowed",
        ),
      add: (version) =>
        Effect.sync(() => {
          skipped.add(version);
        }),
      remove: (version) =>
        Effect.sync(() => {
          skipped.delete(version);
        }),
    };
    const defaultScenario: UpdateScenario = (_input, updateOptions) =>
      Effect.map(updateOptions?.unattended?.beforeRestart ?? Effect.succeed(true), (open) =>
        open ? "restarting" : "postponed",
      );
    const scenario = options.scenario ?? defaultScenario;
    const clientInteraction = yield* makeClientInteraction;
    // How many passes hold the install lock now, and the installer pids recorded with it.
    const lockState = { held: 0, pids: [] as Array<number> };
    const notes: Array<string | null> = [];
    const lock = {
      tryRun: (
        lockKey: string,
        run: (record: (pid: number) => Effect.Effect<void>) => Effect.Effect<unknown>,
      ) =>
        Effect.sync(() => {
          calls.lockKeys.push(lockKey);
          lockState.held += 1;
        }).pipe(
          Effect.andThen(
            Effect.asSome(run((pid) => Effect.sync(() => void lockState.pids.push(pid)))),
          ),
          Effect.ensuring(Effect.sync(() => void (lockState.held -= 1))),
        ),
      anyHeld: Effect.succeed(false),
      anyHeldExcept: () => Effect.succeed(false),
      othersBusy: Effect.succeed(false),
    } as unknown as ProviderInstallLockRuntime;
    const window = makeUpdateWindow({
      agentWork: {
        interruptible: Effect.succeed(false),
        restartInterruptible: Effect.succeed(false),
      },
      clientInteraction,
      installLock: { lock: Effect.succeed(lock) },
      busyTerminals: Effect.succeed(false),
      restartSensitiveWork: makeRestartSensitiveWork(),
    });
    const updater = makeNodeAutoUpdater({
      enabled: Effect.succeed(options.enabled ?? true),
      window,
      nodeUpdate: {
        current: Effect.map(SubscriptionRef.get(runRef), toState),
        changes: SubscriptionRef.changes(runRef).pipe(Stream.map(toState)),
        check: Effect.sync(() => {
          calls.checks += 1;
        }).pipe(Effect.andThen(Effect.map(SubscriptionRef.get(runRef), toState))),
        update: (input, updateOptions) =>
          Effect.gen(function* () {
            calls.updates.push({ input, options: updateOptions });
            const preparing: NodeUpdateRun = {
              ...IDLE_NODE_UPDATE_RUN,
              status: "preparing",
              requestId: input.requestId,
              fromVersion: packageVersion,
              targetVersion: input.targetVersion,
            };
            const status = yield* scenario(input, updateOptions);
            yield* SubscriptionRef.set(runRef, { ...preparing, status });
            return toState(yield* SubscriptionRef.get(runRef));
          }),
        installLockKey: Effect.succeed(nodeInstallLockKey(options.detected ?? serviceNpm)),
        setAutomaticUpdateNote: (note) => Effect.sync(() => void notes.push(note)),
      },
      installLock: { lock: Effect.succeed(lock) },
      skipped: skipList,
      publishedAt: (version) =>
        Effect.succeed(
          options.publishedAt?.[version] === undefined ? OLD_RELEASE : options.publishedAt[version],
        ),
      releaseChannelOf: nodeReleaseChannel,
      isActiveRun: isActiveNodeUpdateRun,
    });
    const fiber = yield* updater.run.pipe(Effect.forkChild({ startImmediately: true }));
    return {
      calls,
      skipped,
      fiber,
      lockState,
      /** The note the owner sees now. */
      ownerNote: () => notes.at(-1) ?? null,
      note: clientInteraction.note("session"),
      resetRun: SubscriptionRef.set(runRef, IDLE_NODE_UPDATE_RUN),
      /** Ends the current run with `status`, as the service would. */
      settleRun: (status: NodeUpdateRun["status"]) =>
        SubscriptionRef.update(runRef, (run) => ({ ...run, status })),
    };
  });

describe("nodeAutoUpdater", () => {
  it.effect("leaves the desktop app, npx, source checkouts and foreground nodes alone", () =>
    Effect.gen(function* () {
      for (const detected of [
        installation("desktop-app", null),
        installation("ephemeral"),
        installation("source-checkout"),
        installation("unknown"),
        installation("npm-global", null),
        // bun cannot hold back brand-new dependency releases while it installs.
        installation("bun-global"),
      ]) {
        const { calls, fiber } = yield* setup({ detected });
        yield* TestClock.adjust("3 hours");
        assert.deepStrictEqual(calls, { checks: 0, updates: [], lockKeys: [] }, detected.kind);
        // It stops at once rather than waking every minute.
        assert.isDefined(fiber.pollUnsafe());
      }
    }),
  );

  it.effect("updates through NodeUpdateService once nobody used a client for 5 minutes", () =>
    Effect.gen(function* () {
      const { calls, note } = yield* setup({ detected: installation("pnpm-global", "systemd") });
      yield* note;
      yield* TestClock.adjust(FIRST_PASS_DELAY);
      // Asked the registry, but 2 quiet minutes are not enough for a restart.
      assert.strictEqual(calls.checks, 1);
      assert.deepStrictEqual(calls.updates, []);
      yield* TestClock.adjust("179 seconds");
      assert.deepStrictEqual(calls.updates, []);
      yield* TestClock.adjust("1 minute");
      assert.strictEqual(calls.updates.length, 1);
      const [call] = calls.updates;
      assert.strictEqual(call!.input.targetVersion, "0.1.36");
      assert.match(call!.input.requestId, /^auto-[0-9a-f-]{36}$/u);
      assert.isUndefined(call!.input.channel);
      // Dependencies published in the last 48 hours stay out of the install too.
      assert.strictEqual(call!.options?.unattended?.minimumReleaseAge, MINIMUM_RELEASE_AGE);
      // The installation's own key, the one a provider CLI update with pnpm takes.
      assert.deepStrictEqual(calls.lockKeys, [PNPM_GLOBAL_INSTALL_LOCK_KEY]);
    }),
  );

  it.effect("puts the release back once someone uses the node before the restart", () =>
    Effect.gen(function* () {
      const scenarioCalls: Array<string> = [];
      let interact: Effect.Effect<void> = Effect.void;
      const { calls, skipped, note, resetRun } = yield* setup({
        scenario: (_input, updateOptions) =>
          // Someone comes back while the release installs: the restart check closes.
          interact.pipe(
            Effect.andThen(updateOptions!.unattended!.beforeRestart),
            Effect.map((open) => {
              scenarioCalls.push(open ? "restart" : "postpone");
              return open ? ("restarting" as const) : ("postponed" as const);
            }),
          ),
      });
      interact = note;
      yield* TestClock.adjust("5 minutes");
      assert.deepStrictEqual(scenarioCalls, ["postpone"]);
      // Postponed is not failed: the release is tried again, after an hour.
      assert.isFalse(skipped.has("0.1.36"));
      yield* resetRun;
      interact = Effect.void;
      yield* TestClock.adjust(Duration.subtract(POSTPONED_RETRY_AFTER, Duration.minutes(1)));
      assert.strictEqual(calls.updates.length, 1);
      yield* TestClock.adjust("1 minute");
      assert.deepStrictEqual(scenarioCalls, ["postpone", "restart"]);
      assert.isTrue(skipped.has("0.1.36"));
    }),
  );

  it.effect("never tries a release again whose unattended update failed or was skipped", () =>
    Effect.gen(function* () {
      const failed = yield* setup({ scenario: () => Effect.succeed("failed") });
      yield* TestClock.adjust("5 minutes");
      assert.strictEqual(failed.calls.updates.length, 1);
      assert.isTrue(failed.skipped.has("0.1.36"));
      assert.strictEqual(failed.ownerNote(), skippedReleaseNote("0.1.36"));
      yield* failed.resetRun;
      yield* TestClock.adjust("3 days");
      assert.strictEqual(failed.calls.updates.length, 1);

      // Recorded before: a rollback after a restart, or a crash during the update. The owner
      // sees why the node leaves it alone.
      const skipped = yield* setup({ skipped: ["0.1.36"] });
      yield* TestClock.adjust("3 days");
      assert.deepStrictEqual(skipped.calls.updates, []);
      assert.strictEqual(skipped.ownerNote(), skippedReleaseNote("0.1.36"));
      assert.match(skipped.ownerNote()!, /^Automatic update: /u);
    }),
  );

  it.effect("tries again an hour after an update that was refused before it started", () =>
    Effect.gen(function* () {
      let refusals = 1;
      const reason =
        "pnpm 10.15.1 cannot hold back brand-new dependency releases, so this node does not update itself. pnpm 10.16 or later can.";
      const { calls, skipped, ownerNote } = yield* setup({
        scenario: () =>
          refusals-- > 0
            ? Effect.fail(new NodeUpdateError({ reason }))
            : Effect.succeed("restarting"),
      });
      yield* TestClock.adjust("5 minutes");
      assert.strictEqual(calls.updates.length, 1);
      assert.isFalse(skipped.has("0.1.36"));
      assert.strictEqual(ownerNote(), `Automatic update: Ryco 0.1.36 did not install: ${reason}`);
      yield* TestClock.adjust(Duration.subtract(REFUSED_RETRY_AFTER, Duration.minutes(1)));
      assert.strictEqual(calls.updates.length, 1);
      yield* TestClock.adjust("1 minute");
      assert.strictEqual(calls.updates.length, 2);
      assert.isTrue(skipped.has("0.1.36"));
      assert.isNull(ownerNote());
    }),
  );

  it.effect("backs off each postponement of a release, and leaves it alone after five", () =>
    Effect.gen(function* () {
      const { calls, skipped, resetRun, ownerNote } = yield* setup({
        scenario: () => Effect.succeed("postponed"),
      });
      yield* TestClock.adjust("5 minutes");
      assert.strictEqual(calls.updates.length, 1);
      // 1, 2, 4, 8 hours between the tries, and never more than a day.
      for (let postponements = 1; postponements < MAX_POSTPONEMENTS; postponements += 1) {
        assert.isFalse(skipped.has("0.1.36"), `after ${postponements}`);
        yield* resetRun;
        const wait = postponedRetryAfter(postponements);
        assert.deepStrictEqual(
          wait,
          Duration.times(POSTPONED_RETRY_AFTER, 2 ** (postponements - 1)),
        );
        yield* TestClock.adjust(Duration.subtract(wait, Duration.minutes(1)));
        assert.strictEqual(calls.updates.length, postponements, `waits ${postponements}`);
        yield* TestClock.adjust("1 minute");
        assert.strictEqual(calls.updates.length, postponements + 1, `tries ${postponements}`);
      }
      // The fifth postponement: skipped like a failed update, and the owner sees why.
      assert.isTrue(skipped.has("0.1.36"));
      assert.strictEqual(ownerNote(), skippedReleaseNote("0.1.36"));
      yield* resetRun;
      yield* TestClock.adjust("3 days");
      assert.strictEqual(calls.updates.length, MAX_POSTPONEMENTS);
      assert.deepStrictEqual(postponedRetryAfter(9), POSTPONED_RETRY_MAX);
    }),
  );

  it.effect("keeps the install lock until the run is over, however long it takes", () =>
    Effect.gen(function* () {
      const { calls, skipped, lockState, settleRun } = yield* setup({
        // Installed, being checked: the run is still under way.
        scenario: () => Effect.succeed("verifying"),
      });
      yield* TestClock.adjust("5 minutes");
      assert.strictEqual(calls.updates.length, 1);
      yield* TestClock.adjust("3 hours");
      // Not counted as failed, and the lock not let go of in the middle of the run.
      assert.strictEqual(lockState.held, 1);
      assert.strictEqual(calls.updates.length, 1);
      // The run records its installers with the lock this pass holds.
      yield* calls.updates[0]!.options!.unattended!.recordInstallerPid(4242);
      assert.deepStrictEqual(lockState.pids, [4242]);
      yield* settleRun("postponed");
      yield* TestClock.adjust("1 minute");
      assert.strictEqual(lockState.held, 0);
      assert.isFalse(skipped.has("0.1.36"));
      assert.deepStrictEqual(calls.lockKeys, [NPM_LOCK_KEY]);
    }),
  );

  it.effect("tells the owner when it cannot read its list of releases to leave alone", () =>
    Effect.gen(function* () {
      const { calls, ownerNote } = yield* setup({ unreadable: true });
      yield* TestClock.adjust("3 hours");
      assert.deepStrictEqual(calls.updates, []);
      assert.strictEqual(ownerNote(), UNREADABLE_SKIP_LIST_NOTE);
    }),
  );

  it.effect("waits until the release is 48 hours old by the registry's publish time", () =>
    Effect.gen(function* () {
      // Published as the test starts; the first pass runs 2 minutes later.
      const young = yield* setup({ publishedAt: { "0.1.36": 0 } });
      yield* TestClock.adjust("2879 minutes");
      assert.deepStrictEqual(young.calls.updates, []);
      yield* TestClock.adjust("1 minute");
      assert.strictEqual(young.calls.updates.length, 1);

      // A release the registry does not date is never installed unattended.
      const undated = yield* setup({ publishedAt: { "0.1.36": null } });
      yield* TestClock.adjust("3 days");
      assert.deepStrictEqual(undated.calls.updates, []);
    }),
  );

  it.effect("installs only a newer release of the node's own channel", () =>
    Effect.gen(function* () {
      for (const [packageVersion, latest] of [
        // Current already.
        ["0.1.36", "0.1.36"],
        // Never a downgrade.
        ["0.1.37", "0.1.36"],
        // The stable dist-tag pointing at a nightly build.
        ["0.1.35", "0.1.36-nightly.20261101.4"],
        // Not known.
        ["0.1.35", null],
      ] as const) {
        const { calls } = yield* setup({ packageVersion, latest });
        yield* TestClock.adjust("3 hours");
        assert.deepStrictEqual(calls.updates, [], `${packageVersion} -> ${latest}`);
      }
      // A nightly node follows the nightly channel.
      const nightly = yield* setup({
        packageVersion: "0.1.36-nightly.20261031.2",
        latest: "0.1.36-nightly.20261101.4",
      });
      yield* TestClock.adjust("5 minutes");
      assert.strictEqual(
        nightly.calls.updates[0]?.input.targetVersion,
        "0.1.36-nightly.20261101.4",
      );
    }),
  );

  it.effect("asks the registry at most hourly, and nothing while the setting is off", () =>
    Effect.gen(function* () {
      const { calls } = yield* setup({ skipped: ["0.1.36"] });
      yield* TestClock.adjust("3 hours");
      // At 2 minutes, then 1, 2 hours later.
      assert.strictEqual(calls.checks, 3);

      const off = yield* setup({ enabled: false });
      yield* TestClock.adjust("3 hours");
      assert.deepStrictEqual(off.calls, { checks: 0, updates: [], lockKeys: [] });
    }),
  );

  it.effect("waits while another update runs", () =>
    Effect.gen(function* () {
      const { calls, resetRun } = yield* setup({
        run: { ...IDLE_NODE_UPDATE_RUN, status: "verifying", requestId: "update-1" },
      });
      yield* TestClock.adjust("3 hours");
      assert.deepStrictEqual(calls.updates, []);
      yield* resetRun;
      yield* TestClock.adjust("1 minute");
      assert.strictEqual(calls.updates.length, 1);
    }),
  );
});

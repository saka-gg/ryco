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
import { nodeReleaseChannel } from "../nodeUpdate/installation.ts";
import {
  deriveNodeUpdateState,
  IDLE_NODE_UPDATE_RUN,
  isActiveNodeUpdateRun,
  type NodeUpdateOptions,
} from "../nodeUpdate/NodeUpdateService.ts";
import type { ProviderInstallLockRuntime } from "../provider/providerInstallLock.ts";
import { makeClientInteraction } from "./ClientInteraction.ts";
import type { NodeAutoSkipList } from "./nodeAutoSkip.ts";
import {
  FIRST_PASS_DELAY,
  makeNodeAutoUpdater,
  NODE_SELF_UPDATE_LOCK_KEY,
  POSTPONED_RETRY_AFTER,
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
      has: (version) => Effect.sync(() => skipped.has(version)),
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
    const lock = {
      tryRun: (
        lockKey: string,
        run: (record: () => Effect.Effect<void>) => Effect.Effect<unknown>,
      ) =>
        Effect.sync(() => calls.lockKeys.push(lockKey)).pipe(
          Effect.andThen(Effect.asSome(run(() => Effect.void))),
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
      note: clientInteraction.note("session"),
      resetRun: SubscriptionRef.set(runRef, IDLE_NODE_UPDATE_RUN),
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
      const { calls, note } = yield* setup({ detected: installation("bun-global", "systemd") });
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
      assert.isDefined(call!.options?.unattended);
      assert.deepStrictEqual(calls.lockKeys, [NODE_SELF_UPDATE_LOCK_KEY]);
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
      yield* failed.resetRun;
      yield* TestClock.adjust("3 days");
      assert.strictEqual(failed.calls.updates.length, 1);

      // Recorded before: a rollback after a restart, or a crash during the update.
      const skipped = yield* setup({ skipped: ["0.1.36"] });
      yield* TestClock.adjust("3 days");
      assert.deepStrictEqual(skipped.calls.updates, []);
    }),
  );

  it.effect("tries again after an update that was refused before it started", () =>
    Effect.gen(function* () {
      let refusals = 1;
      const { calls, skipped } = yield* setup({
        scenario: () =>
          refusals-- > 0
            ? Effect.fail(new NodeUpdateError({ reason: "An update is already running." }))
            : Effect.succeed("restarting"),
      });
      yield* TestClock.adjust("5 minutes");
      assert.strictEqual(calls.updates.length, 1);
      assert.isFalse(skipped.has("0.1.36"));
      yield* TestClock.adjust("1 minute");
      assert.strictEqual(calls.updates.length, 2);
      assert.isTrue(skipped.has("0.1.36"));
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

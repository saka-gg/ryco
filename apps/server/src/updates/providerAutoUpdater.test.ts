import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUpdateState,
} from "@ryco/contracts";
import { Effect, Fiber, Ref } from "effect";
import { TestClock } from "effect/testing";

import { makeProviderMaintenanceCapabilities } from "../provider/providerMaintenance.ts";
import type {
  UnattendedProviderUpdateInput,
  UnattendedProviderUpdateOutcome,
} from "../provider/providerMaintenanceRunner.ts";
import { makeProviderAutoUpdater } from "./providerAutoUpdater.ts";
import type { UpdateWindow } from "./updateWindow.ts";

const CODEX = ProviderDriverKind.make("codex");
const CLAUDE = ProviderDriverKind.make("claudeAgent");

const provider = (
  instanceId: string,
  driver: ProviderDriverKind,
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-31T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

const npmCapabilities = (driver: ProviderDriverKind) =>
  makeProviderMaintenanceCapabilities({
    provider: driver,
    packageName: `@example/${driver}`,
    updateExecutable: "npm",
    updateArgs: ["install", "-g", `@example/${driver}@latest`],
    updateLockKey: "npm-global",
  });

/**
 * An updater over in-memory sources. The window is a switch; the latest release is "1.1.0"
 * unless `latest` changes it; the runner records what it was asked and answers `outcome`, after
 * asking `beforeInstall` (a closed window postpones, as the real runner does).
 */
const setup = (
  options: {
    readonly providers?: ReadonlyArray<ServerProvider>;
    readonly enabled?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const enabled = yield* Ref.make(options.enabled ?? true);
    const open = yield* Ref.make(true);
    const latest = yield* Ref.make("1.1.0");
    const outcome = yield* Ref.make<UnattendedProviderUpdateOutcome>({
      kind: "installed",
      version: "1.1.0",
    });
    const providers = options.providers ?? [provider("codex", CODEX)];
    const requests: Array<string> = [];
    const installs: Array<string> = [];
    const lookups: Array<string> = [];
    // Runs between the pick and the runner's check under the lock.
    let beforeRunner: Effect.Effect<void> = Effect.void;
    const window: UpdateWindow = {
      isOpen: () => Ref.get(open),
      runIfOpen: (effect) =>
        Effect.flatMap(Ref.get(open), (isOpen) =>
          isOpen ? Effect.asSome(effect) : Effect.succeedNone,
        ),
    };
    const updater = makeProviderAutoUpdater({
      enabled: Ref.get(enabled),
      window,
      providers: {
        getProviders: Effect.succeed(providers),
        getProviderMaintenanceCapabilitiesForInstance: (_instanceId, driver) =>
          Effect.succeed(npmCapabilities(driver)),
      },
      withVersionAdvisory: (snapshot) =>
        Effect.map(Ref.get(latest), (latestVersion) => {
          lookups.push(snapshot.instanceId);
          return {
            ...snapshot,
            versionAdvisory: {
              status: latestVersion === snapshot.version ? "current" : "behind_latest",
              currentVersion: snapshot.version,
              latestVersion,
              updateCommand: null,
              canUpdate: true,
              checkedAt: null,
              message: null,
            },
          } satisfies ServerProvider;
        }),
      runner: {
        updateProviderUnattended: (input: UnattendedProviderUpdateInput) =>
          Effect.gen(function* () {
            yield* beforeRunner;
            requests.push(`${input.instanceId}@${input.targetVersion}`);
            if (!(yield* input.beforeInstall)) {
              return { kind: "postponed", reason: "The update window closed." } as const;
            }
            installs.push(`${input.instanceId}@${input.targetVersion}`);
            return yield* Ref.get(outcome);
          }),
      },
    });
    return {
      updater,
      requests,
      installs,
      lookups,
      setEnabled: (value: boolean) => Ref.set(enabled, value),
      setOpen: (value: boolean) => Ref.set(open, value),
      setLatest: (value: string) => Ref.set(latest, value),
      setOutcome: (value: UnattendedProviderUpdateOutcome) => Ref.set(outcome, value),
      /** Runs after the pick, before the runner's last check under the lock. */
      betweenPickAndInstall: (effect: Effect.Effect<void>) => {
        beforeRunner = effect;
      },
    };
  });

describe("providerAutoUpdater", () => {
  it.effect("does nothing while automatic updates are off", () =>
    Effect.gen(function* () {
      const test = yield* setup({ enabled: false });
      yield* test.updater.pass;
      assert.deepStrictEqual(test.requests, []);
      // Not even a release lookup.
      assert.deepStrictEqual(test.lookups, []);
    }),
  );

  it.effect("runs its first pass after 2 minutes, then one every 10 minutes", () =>
    Effect.gen(function* () {
      const test = yield* setup();
      // Every pick is skipped from now on, so each pass shows up as a lookup.
      yield* test.setOutcome({ kind: "skipped", reason: "rated unknown" });
      const fiber = yield* Effect.forkChild(test.updater.run);
      yield* TestClock.adjust("119 seconds");
      assert.deepStrictEqual(test.lookups, []);
      yield* TestClock.adjust("1 second");
      assert.deepStrictEqual(test.lookups, ["codex"]);
      yield* TestClock.adjust("9 minutes");
      assert.deepStrictEqual(test.lookups, ["codex"]);
      yield* TestClock.adjust("1 minute");
      assert.deepStrictEqual(test.lookups, ["codex", "codex"]);
      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("tries an instance at one release once per 6 hours", () =>
    Effect.gen(function* () {
      const test = yield* setup();
      // An `unknown` rating (or a failed install) keeps the try spent.
      yield* test.setOutcome({ kind: "skipped", reason: "This Ryco release rates 1.1.0 unknown." });
      yield* test.updater.pass;
      yield* TestClock.adjust("5 hours");
      yield* test.updater.pass;
      assert.deepStrictEqual(test.requests, ["codex@1.1.0"]);
      // A newer release is a new try at once.
      yield* test.setLatest("1.2.0");
      yield* test.updater.pass;
      assert.deepStrictEqual(test.requests, ["codex@1.1.0", "codex@1.2.0"]);
      yield* test.setLatest("1.1.0");
      yield* TestClock.adjust("1 hour");
      yield* test.updater.pass;
      assert.deepStrictEqual(test.requests, ["codex@1.1.0", "codex@1.2.0", "codex@1.1.0"]);
    }),
  );

  it.effect("postpones and frees the try when the window closes between pick and install", () =>
    Effect.gen(function* () {
      const test = yield* setup();
      test.betweenPickAndInstall(test.setOpen(false));
      yield* test.updater.pass;
      assert.deepStrictEqual(test.requests, ["codex@1.1.0"]);
      assert.deepStrictEqual(test.installs, []);
      // The next open window tries the same release again; no 6 hour wait.
      test.betweenPickAndInstall(Effect.void);
      yield* test.setOpen(true);
      yield* test.updater.pass;
      assert.deepStrictEqual(test.requests, ["codex@1.1.0", "codex@1.1.0"]);
      assert.deepStrictEqual(test.installs, ["codex@1.1.0"]);
    }),
  );

  it.effect("updates one instance at a time and stops once the window closes", () =>
    Effect.gen(function* () {
      const test = yield* setup({
        providers: [provider("codex", CODEX), provider("claude", CLAUDE)],
      });
      test.betweenPickAndInstall(test.setOpen(false));
      yield* test.updater.pass;
      // The first install found the window closed; the second instance was never picked.
      assert.deepStrictEqual(test.requests, ["codex@1.1.0"]);
      assert.deepStrictEqual(test.lookups, ["codex"]);
    }),
  );

  it.effect("re-checks the setting right before installing", () =>
    Effect.gen(function* () {
      const test = yield* setup();
      // The owner turns automatic updates off after the pick.
      test.betweenPickAndInstall(test.setEnabled(false));
      yield* test.updater.pass;
      assert.deepStrictEqual(test.requests, ["codex@1.1.0"]);
      assert.deepStrictEqual(test.installs, []);
    }),
  );

  it.effect("leaves instances alone that are off, missing, already updating or current", () =>
    Effect.gen(function* () {
      const queued: ServerProviderUpdateState = {
        status: "queued",
        startedAt: null,
        finishedAt: null,
        message: null,
        output: null,
      };
      const test = yield* setup({
        providers: [
          provider("off", CODEX, { enabled: false }),
          provider("missing", CODEX, { installed: false }),
          provider("queued", CODEX, { updateState: queued }),
          provider("running", CODEX, { updateState: { ...queued, status: "running" } }),
          provider("current", CODEX, { version: "1.1.0" }),
        ],
      });
      yield* test.updater.pass;
      assert.deepStrictEqual(test.requests, []);
    }),
  );
});

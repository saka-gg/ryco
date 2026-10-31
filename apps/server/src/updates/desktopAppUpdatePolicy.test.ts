import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@ryco/contracts";
import type { DesktopAppUpdateRequestFrame } from "@ryco/shared/desktopResourceTelemetry";
import { Effect, Layer, PubSub, Stream } from "effect";

import { ServerConfig, type ServerConfigShape } from "../config.ts";
import { ServerSettingsService, type ServerSettingsShape } from "../serverSettings.ts";
import {
  desktopAppUpdatesAutomatic,
  makeDesktopAppUpdatePolicyLayer,
} from "./desktopAppUpdatePolicy.ts";

const settle = Effect.gen(function* () {
  for (let index = 0; index < 25; index += 1) yield* Effect.yieldNow;
});

const settings = (
  automaticUpdates: boolean,
  enableProviderUpdateChecks = true,
): ServerSettings => ({ ...DEFAULT_SERVER_SETTINGS, automaticUpdates, enableProviderUpdateChecks });

/** The reporter over a settings service whose first read answers `firstRead` (after `duringRead`). */
const report = (options: {
  readonly firstRead: ServerSettings | "fails";
  readonly duringRead?: (changes: PubSub.PubSub<ServerSettings>) => Effect.Effect<unknown>;
  readonly devUrl?: URL;
}) =>
  Effect.gen(function* () {
    const changes = yield* PubSub.unbounded<ServerSettings>();
    const serverSettings = {
      getSettings: Effect.suspend(() =>
        (options.duringRead?.(changes) ?? Effect.void).pipe(
          Effect.andThen(
            options.firstRead === "fails"
              ? Effect.fail(new Error("settings.json unreadable"))
              : Effect.succeed(options.firstRead),
          ),
        ),
      ),
      streamChanges: Stream.fromPubSub(changes),
    } as unknown as ServerSettingsShape;
    const frames: Array<DesktopAppUpdateRequestFrame> = [];
    yield* Layer.build(
      makeDesktopAppUpdatePolicyLayer((frame) => {
        frames.push(frame);
        return true;
      }).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ServerConfig, { devUrl: options.devUrl } as unknown as ServerConfigShape),
            Layer.succeed(ServerSettingsService, serverSettings),
          ),
        ),
      ),
    );
    yield* settle;
    return { frames, changes };
  });

const policy = (automatic: boolean) => ({ type: "app-update-policy", automatic }) as const;

describe("desktopAppUpdatePolicy", () => {
  it("is on only with automatic updates and update checks on, never on a dev server", () => {
    assert.isTrue(desktopAppUpdatesAutomatic(settings(true), undefined));
    assert.isFalse(desktopAppUpdatesAutomatic(settings(false), undefined));
    assert.isFalse(desktopAppUpdatesAutomatic(settings(true, false), undefined));
    assert.isFalse(desktopAppUpdatesAutomatic(settings(true), new URL("http://127.0.0.1:5733")));
  });

  it.effect("reports the policy at start and again on every change", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { frames, changes } = yield* report({ firstRead: settings(false) });
        assert.deepStrictEqual(frames, [policy(false)]);
        yield* PubSub.publish(changes, settings(true));
        yield* settle;
        // An unrelated change repeats nothing.
        yield* PubSub.publish(changes, { ...settings(true), continueThreadsAfterRestart: true });
        yield* settle;
        // Turning update checks off turns the policy off.
        yield* PubSub.publish(changes, settings(true, false));
        yield* settle;
        assert.deepStrictEqual(frames, [policy(false), policy(true), policy(false)]);
      }),
    ),
  );

  it.effect("reports a change made while it reads the settings, not the older read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { frames } = yield* report({
          firstRead: settings(false),
          duringRead: (changes) =>
            PubSub.publish(changes, settings(true)).pipe(Effect.andThen(settle)),
        });
        assert.deepStrictEqual(frames, [policy(true)]);
      }),
    ),
  );

  it.effect("reports off when the settings cannot be read, and always on a dev server", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const unreadable = yield* report({ firstRead: "fails" });
        assert.deepStrictEqual(unreadable.frames, [policy(false)]);
        const dev = yield* report({
          firstRead: settings(true),
          devUrl: new URL("http://127.0.0.1:5733"),
        });
        yield* PubSub.publish(dev.changes, settings(true));
        yield* settle;
        assert.deepStrictEqual(dev.frames, [policy(false)]);
      }),
    ),
  );
});

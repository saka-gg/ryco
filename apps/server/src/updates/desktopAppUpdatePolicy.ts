/**
 * desktopAppUpdatePolicy - tells the desktop app whether it may update itself unattended.
 *
 * A desktop-launched backend reports its node's automatic update setting to the Electron app
 * that launched it, as an `app-update-policy` frame on their private pipe: on while the node's
 * owner has `automaticUpdates` on together with provider update checks (the rule unattended
 * provider updates follow), never on a dev server. It is sent once when the backend starts and
 * again on every change. With it on, the app downloads the updates its own checks find and,
 * where the platform allows, installs one when it quits (`desktopAppAutomaticUpdateMode`).
 *
 * Desktop mode only (`server.ts`). The app takes the frame only from the backend it launched.
 *
 * @module desktopAppUpdatePolicy
 */
import type { ServerSettings } from "@ryco/contracts";
import type { DesktopAppUpdateRequestFrame } from "@ryco/shared/desktopResourceTelemetry";
import { Effect, Layer, Stream } from "effect";

import { ServerConfig } from "../config.ts";
import { desktopAppUpdateBridge } from "../desktopAppUpdateBridge.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { automaticUpdatesEnabled } from "./unattendedUpdatesLauncher.ts";

/** Whether the desktop app may download and install its own updates unattended. */
export const desktopAppUpdatesAutomatic = (
  settings: Pick<ServerSettings, "automaticUpdates" | "enableProviderUpdateChecks">,
  devUrl: URL | undefined,
): boolean => devUrl === undefined && automaticUpdatesEnabled(settings);

/** The policy reporter over `send`, the pipe write (a stand-in in tests). */
export const makeDesktopAppUpdatePolicyLayer = (
  send: (frame: DesktopAppUpdateRequestFrame) => boolean,
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const { devUrl } = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      let reported: boolean | null = null;
      const report = (automatic: boolean) =>
        Effect.sync(() => {
          if (automatic === reported) return;
          reported = automatic;
          send({ type: "app-update-policy", automatic });
        });
      // Subscribed before the read below, so a change made in between is reported.
      yield* serverSettings.streamChanges.pipe(
        Stream.runForEach((settings) => report(desktopAppUpdatesAutomatic(settings, devUrl))),
        Effect.forkScoped({ startImmediately: true }),
      );
      // An unreadable setting reports off: the app then installs nothing unattended.
      const initial = yield* serverSettings.getSettings.pipe(
        Effect.map((settings) => desktopAppUpdatesAutomatic(settings, devUrl)),
        Effect.orElseSucceed(() => false),
      );
      // A change that arrived during the read was reported already, and is newer than the read.
      if (reported === null) yield* report(initial);
    }),
  );

export const DesktopAppUpdatePolicyLive = makeDesktopAppUpdatePolicyLayer(
  desktopAppUpdateBridge.request,
);

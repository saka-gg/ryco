/**
 * unattendedUpdates - what runs once a node's owner turns on `automaticUpdates`.
 *
 * Loaded by the boot launcher (`unattendedUpdatesLauncher.ts`) with `import()` the first time the
 * setting is on (with provider update checks), and never on a dev server. It builds the update
 * window and the provider auto-updater and runs it until the server stops. The updater re-reads
 * the setting before every pick and right before every install, so turning it off stops further
 * installs without cutting off one in progress.
 *
 * Everything from boot arrives as an argument (the `cliUpdate.ts` pattern): this module and the
 * ones it loads import only types and `effect`, so loading them splits no boot module.
 *
 * @module unattendedUpdates
 */
import { Effect } from "effect";

import type { AgentWorkActivityShape } from "../orchestration/AgentWorkActivity.ts";
import type { ProviderInstallLockShape } from "../provider/Services/ProviderInstallLock.ts";
import type { ClientInteractionShape } from "./ClientInteraction.ts";
import { makeProviderAutoUpdater, type ProviderAutoUpdaterSources } from "./providerAutoUpdater.ts";
import { makeUpdateWindow } from "./updateWindow.ts";

export interface UnattendedUpdatesSources extends Omit<ProviderAutoUpdaterSources, "window"> {
  readonly clientInteraction: Pick<ClientInteractionShape, "sinceLast">;
  readonly installLock: Pick<ProviderInstallLockShape, "lock">;
  /**
   * The process's agent-work tracker (shared with sleep holds and the busy marker). It reports
   * nothing before the startup command gate opens, which keeps the window closed until then.
   */
  readonly agentWork: Pick<AgentWorkActivityShape, "interruptible">;
}

/** Runs unattended updates until interrupted. */
export const runUnattendedUpdates = (sources: UnattendedUpdatesSources): Effect.Effect<void> =>
  Effect.gen(function* () {
    const updater = makeProviderAutoUpdater({
      ...sources,
      window: makeUpdateWindow({
        agentWork: sources.agentWork,
        clientInteraction: sources.clientInteraction,
        installLock: sources.installLock,
      }),
    });
    yield* Effect.logInfo("Automatic provider updates are on");
    yield* updater.run;
  });

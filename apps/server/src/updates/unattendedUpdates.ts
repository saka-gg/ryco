/**
 * unattendedUpdates - what runs once a node's owner turns on `automaticUpdates`.
 *
 * Loaded by the boot launcher (`unattendedUpdatesLauncher.ts`) with `import()` the first time the
 * setting is on (with update checks), and never on a dev server. It builds the update window and
 * runs both updaters until the server stops: provider CLIs (`providerAutoUpdater.ts`) and, on a
 * CLI service node, Ryco itself (`nodeAutoUpdater.ts`). They re-read the setting before every
 * pick and right before every install or restart, so turning it off stops further updates
 * without cutting off one in progress.
 *
 * Everything from boot arrives as an argument (the `cliUpdate.ts` pattern): this module and the
 * ones it loads import no boot module but a few that update runs already load, so loading them
 * splits no boot module.
 *
 * @module unattendedUpdates
 */
import type { NodeReleaseChannel, NodeUpdateRun } from "@ryco/contracts";
import { Effect, type FileSystem, type Path } from "effect";
import { HttpClient } from "effect/http";

import type { NodeUpdateServiceShape } from "../nodeUpdate/NodeUpdateService.ts";
import type { AgentWorkActivityShape } from "../orchestration/AgentWorkActivity.ts";
import { fetchNpmVersionPublishedAt } from "../provider/providerReleaseAge.ts";
import type { ProviderInstallLockShape } from "../provider/Services/ProviderInstallLock.ts";
import type { ClientInteractionShape } from "./ClientInteraction.ts";
import { makeNodeAutoSkipList } from "./nodeAutoSkip.ts";
import { makeNodeAutoUpdater } from "./nodeAutoUpdater.ts";
import { makeProviderAutoUpdater, type ProviderAutoUpdaterSources } from "./providerAutoUpdater.ts";
import type { RestartSensitiveWorkShape } from "./restartSensitiveWork.ts";
import { makeUpdateWindow } from "./updateWindow.ts";

export interface UnattendedUpdatesSources extends Omit<ProviderAutoUpdaterSources, "window"> {
  readonly clientInteraction: Pick<ClientInteractionShape, "sinceLast">;
  readonly installLock: Pick<ProviderInstallLockShape, "lock">;
  /**
   * The process's agent-work tracker (shared with sleep holds and the busy marker). It reports
   * nothing before the startup command gate opens, which keeps the window closed until then.
   */
  readonly agentWork: Pick<AgentWorkActivityShape, "interruptible" | "restartInterruptible">;
  /** Whether a terminal runs a command or is starting. */
  readonly busyTerminals: Effect.Effect<boolean>;
  readonly restartSensitiveWork: Pick<RestartSensitiveWorkShape, "count">;
  /** This node's own release and update. */
  readonly node: {
    readonly update: Pick<
      NodeUpdateServiceShape,
      "current" | "check" | "update" | "changes" | "installLockKey" | "setAutomaticUpdateNote"
    >;
    /** The npm package Ryco's releases are published as. */
    readonly packageName: string;
    /** `<stateDir>/node-update/auto-skip.json`. */
    readonly autoSkipPath: string;
    readonly releaseChannelOf: (version: string) => NodeReleaseChannel;
    readonly isActiveRun: (run: NodeUpdateRun) => boolean;
  };
  readonly httpClient: HttpClient.HttpClient;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}

/** Runs unattended updates until interrupted. */
export const runUnattendedUpdates = (sources: UnattendedUpdatesSources): Effect.Effect<void> =>
  Effect.gen(function* () {
    const window = makeUpdateWindow({
      agentWork: sources.agentWork,
      clientInteraction: sources.clientInteraction,
      installLock: sources.installLock,
      busyTerminals: sources.busyTerminals,
      restartSensitiveWork: sources.restartSensitiveWork,
    });
    const providerUpdater = makeProviderAutoUpdater({ ...sources, window });
    const nodeUpdater = makeNodeAutoUpdater({
      enabled: sources.enabled,
      window,
      nodeUpdate: sources.node.update,
      installLock: sources.installLock,
      skipped: makeNodeAutoSkipList({
        filePath: sources.node.autoSkipPath,
        fileSystem: sources.fileSystem,
        path: sources.path,
      }),
      publishedAt: (version) =>
        fetchNpmVersionPublishedAt(sources.node.packageName, version).pipe(
          Effect.provideService(HttpClient.HttpClient, sources.httpClient),
        ),
      releaseChannelOf: sources.node.releaseChannelOf,
      isActiveRun: sources.node.isActiveRun,
    });
    yield* Effect.logInfo("Automatic updates are on");
    yield* Effect.all([providerUpdater.run, nodeUpdater.run], {
      concurrency: "unbounded",
      discard: true,
    });
  });

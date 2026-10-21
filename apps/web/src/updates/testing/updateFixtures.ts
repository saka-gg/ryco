import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ServerProvider,
  type DesktopUpdateState,
  type NodeUpdateRun,
  type NodeUpdateState,
  type ServerConfig,
} from "@ryco/contracts";
import { Schema } from "effect";

export type NodeUpdateStateOverrides = Omit<Partial<NodeUpdateState>, "run"> & {
  readonly run?: Partial<NodeUpdateRun>;
};

/** A CLI service node on 0.1.35 that can update itself to 0.1.36. */
export function nodeUpdateState(overrides: NodeUpdateStateOverrides = {}): NodeUpdateState {
  const { run, ...rest } = overrides;
  return {
    currentVersion: "0.1.35",
    latestVersion: "0.1.36",
    channel: "latest",
    availability: "behind_latest",
    installation: { kind: "npm-global", service: "launchd" },
    canUpdate: true,
    manualReason: null,
    manualCommand: null,
    checkedAt: "2026-10-21T00:00:00.000Z",
    ...rest,
    run: {
      status: "idle",
      requestId: null,
      fromVersion: null,
      targetVersion: null,
      startedAt: null,
      finishedAt: null,
      restartAt: null,
      progressPercent: null,
      message: null,
      output: null,
      ...run,
    },
  };
}

/** A ready provider on 1.0.0 that one click can update to 1.1.0; the driver is the id up to `_`. */
export function updatableProvider(instanceId: string): ServerProvider {
  return Schema.decodeUnknownSync(ServerProvider)({
    instanceId,
    driver: instanceId.split("_")[0],
    enabled: true,
    installed: true,
    status: "ready",
    version: "1.0.0",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-21T00:00:00.000Z",
    models: [],
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      canUpdate: true,
      updateCommand: null,
      checkedAt: null,
      message: null,
    },
  });
}

/** Only the parts of a node's config "Update everything" reads. */
export function nodeServerConfig(input: {
  readonly environmentId: string;
  readonly label?: string;
  readonly serverVersion?: string;
  readonly nodeSelfUpdate?: boolean;
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly continueThreadsAfterRestart?: boolean;
}): ServerConfig {
  return {
    environment: {
      environmentId: EnvironmentId.make(input.environmentId),
      label: input.label ?? "Node",
      serverVersion: input.serverVersion ?? "0.1.35",
      capabilities:
        input.nodeSelfUpdate === undefined ? {} : { nodeSelfUpdate: input.nodeSelfUpdate },
    },
    providers: input.providers ?? [],
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      continueThreadsAfterRestart: input.continueThreadsAfterRestart ?? false,
    },
  } as unknown as ServerConfig;
}

/** This desktop app's updater with 0.1.36 found and not yet downloaded. */
export function desktopUpdateState(
  overrides: Partial<DesktopUpdateState> = {},
): DesktopUpdateState {
  return {
    enabled: true,
    status: "available",
    channel: "latest",
    currentVersion: "0.1.35",
    availableVersion: "0.1.36",
    downloadedVersion: null,
    downloadPercent: null,
    checkedAt: "2026-10-21T00:00:00.000Z",
    message: null,
    errorContext: null,
    canRetry: false,
    ...overrides,
  };
}

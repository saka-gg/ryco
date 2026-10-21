import {
  EnvironmentId,
  ServerProvider,
  type NodeUpdateRun,
  type NodeUpdateState,
} from "@ryco/contracts";
import { Schema } from "effect";

import type { UpdateEverythingEnvironmentInput } from "../src/updates/plan.ts";

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

/**
 * A ready provider on 1.0.0 that one click can update to 1.1.0. The driver is
 * the instance id up to its first `_` unless `overrides` names one.
 */
export function updatableProvider(
  instanceId: string,
  overrides: Record<string, unknown> = {},
  advisory: Record<string, unknown> = {},
): ServerProvider {
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
      ...advisory,
    },
    ...overrides,
  });
}

/** A connected node this session owns, labelled `label`, with nothing busy. */
export function updateEverythingEnvironment(
  label: string,
  overrides: Partial<UpdateEverythingEnvironmentInput> = {},
): UpdateEverythingEnvironmentInput {
  return {
    environmentId: EnvironmentId.make(`env-${label.toLowerCase().replace(/\s+/g, "-")}`),
    label,
    connected: true,
    canMutate: true,
    hostedByThisApp: false,
    serverVersion: "0.1.35",
    supportsNodeUpdate: true,
    nodeUpdate: nodeUpdateState(),
    providers: [],
    busyProviderInstanceIds: [],
    runningChatCount: 0,
    continueThreadsAfterRestart: true,
    ...overrides,
  };
}

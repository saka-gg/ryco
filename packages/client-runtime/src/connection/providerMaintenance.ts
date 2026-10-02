import type {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
} from "@ryco/contracts";
import {
  deriveNodeMutationLease,
  nodeMutationLeaseIsCurrent,
  type NodeMutationLease,
  type NodeMutationReadiness,
} from "../authorization/nodeMutationLease.ts";
import type { WsRpcClient } from "../rpc/wsRpcClient.ts";

export interface ProviderMaintenanceEnvironment {
  readonly client: Pick<WsRpcClient, "server">;
  /** Supplied by the existing connection lifecycle owner; never inferred from connectivity. */
  readonly readiness: NodeMutationReadiness;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly activeInstanceIds: ReadonlyArray<ProviderInstanceId>;
}

export interface ProviderMaintenanceTarget {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly currentVersion: string | null;
  readonly latestVersion: string | null;
}

export interface ProviderMaintenancePreview {
  readonly targets: ReadonlyArray<ProviderMaintenanceTarget>;
}

export interface ProviderMaintenanceOutcome {
  readonly target: ProviderMaintenanceTarget;
  readonly status: "succeeded" | "unchanged" | "failed" | "skipped" | "unknown";
  readonly message: string | null;
}

type CapturedTarget = {
  readonly target: ProviderMaintenanceTarget;
  readonly client: ProviderMaintenanceEnvironment["client"];
  readonly lease: NodeMutationLease;
};
type Plan = {
  readonly captured: ReadonlyArray<CapturedTarget>;
  execution?: Promise<ReadonlyArray<ProviderMaintenanceOutcome>>;
};

function eligible(provider: ServerProvider, environment: ProviderMaintenanceEnvironment): boolean {
  return (
    provider.enabled &&
    provider.installed &&
    provider.availability !== "unavailable" &&
    provider.status !== "disabled" &&
    provider.versionAdvisory?.status === "behind_latest" &&
    provider.versionAdvisory.canUpdate &&
    provider.updateState?.status !== "queued" &&
    provider.updateState?.status !== "running" &&
    !environment.activeInstanceIds.includes(provider.instanceId)
  );
}

/**
 * Shared non-UI batch coordinator. A preview captures explicit instances and the
 * current owner lease. Executing the same preview is idempotent within this
 * controller, including after completion. An ambiguous RPC is never retried.
 * Server push streams remain the sole publisher of provider snapshots.
 */
export function createProviderMaintenanceController(input: {
  readonly readEnvironment: (environmentId: EnvironmentId) => ProviderMaintenanceEnvironment | null;
  readonly concurrency?: number;
}) {
  const concurrency = input.concurrency ?? 3;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new RangeError("Provider update concurrency must be an integer between 1 and 8.");
  }
  const plans = new WeakMap<ProviderMaintenancePreview, Plan>();
  let active: Promise<ReadonlyArray<ProviderMaintenanceOutcome>> | null = null;

  const currentEnvironment = (captured: CapturedTarget) => {
    const environment = input.readEnvironment(captured.target.environmentId);
    return environment?.client === captured.client &&
      nodeMutationLeaseIsCurrent(
        captured.lease,
        captured.target.environmentId,
        environment.readiness,
      )
      ? environment
      : null;
  };

  const preview = (environmentIds: ReadonlyArray<EnvironmentId>): ProviderMaintenancePreview => {
    const captured: CapturedTarget[] = [];
    const seen = new Set<string>();
    for (const environmentId of new Set(environmentIds)) {
      const environment = input.readEnvironment(environmentId);
      if (!environment) continue;
      const lease = deriveNodeMutationLease(environment.readiness);
      if (!lease || lease.environmentId !== environmentId) continue;
      for (const provider of environment.providers) {
        const identity = JSON.stringify([environmentId, provider.instanceId, provider.driver]);
        if (seen.has(identity) || !eligible(provider, environment)) continue;
        seen.add(identity);
        const target = Object.freeze({
          environmentId,
          instanceId: provider.instanceId,
          driver: provider.driver,
          currentVersion: provider.versionAdvisory?.currentVersion ?? provider.version,
          latestVersion: provider.versionAdvisory?.latestVersion ?? null,
        });
        captured.push({ target, client: environment.client, lease });
      }
    }
    const result = Object.freeze({ targets: Object.freeze(captured.map(({ target }) => target)) });
    plans.set(result, { captured });
    return result;
  };

  const executeTarget = async (
    captured: CapturedTarget,
    signal?: AbortSignal,
  ): Promise<ProviderMaintenanceOutcome> => {
    const outcome = (status: ProviderMaintenanceOutcome["status"], message: string | null) =>
      Object.freeze({ target: captured.target, status, message });
    if (signal?.aborted) return outcome("skipped", "Update cancelled before dispatch.");
    const environment = currentEnvironment(captured);
    if (!environment) return outcome("skipped", "Connection authority changed. Preview again.");
    const provider = environment.providers.find(
      (candidate) =>
        candidate.instanceId === captured.target.instanceId &&
        candidate.driver === captured.target.driver,
    );
    if (
      !provider ||
      !eligible(provider, environment) ||
      (provider.versionAdvisory?.currentVersion ?? provider.version) !==
        captured.target.currentVersion ||
      (provider.versionAdvisory?.latestVersion ?? null) !== captured.target.latestVersion
    ) {
      return outcome("skipped", "Provider changed or is no longer eligible. Preview again.");
    }
    try {
      const response = await captured.client.server.updateProvider({
        provider: captured.target.driver,
        instanceId: captured.target.instanceId,
      });
      if (!currentEnvironment(captured)) {
        return outcome(
          "unknown",
          "Connection authority changed after dispatch. Check provider status.",
        );
      }
      const updated = response.providers.find(
        (candidate) =>
          candidate.instanceId === captured.target.instanceId &&
          candidate.driver === captured.target.driver,
      );
      const status = updated?.updateState?.status;
      if (status === "succeeded" || status === "unchanged" || status === "failed") {
        return outcome(status, updated?.updateState?.message ?? null);
      }
      return outcome(
        "unknown",
        "Server did not return a terminal update result. Check provider status.",
      );
    } catch {
      // Even a lost response may follow a successful install. Do not silently retry.
      return outcome(
        "unknown",
        "Update response was lost or rejected. Check provider status before retrying.",
      );
    }
  };

  const execute = (
    reviewed: ProviderMaintenancePreview,
    signal?: AbortSignal,
  ): Promise<ReadonlyArray<ProviderMaintenanceOutcome>> => {
    const plan = plans.get(reviewed);
    if (!plan) return Promise.reject(new Error("Use a preview issued by this controller."));
    if (plan.execution) return plan.execution;
    if (active) return Promise.reject(new Error("A provider update batch is already running."));
    // Defer dispatch until single-flight ownership is installed, including synchronous RPC mocks.
    const execution = Promise.resolve().then(async () => {
      const outcomes: ProviderMaintenanceOutcome[] = [];
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(concurrency, plan.captured.length) }, async () => {
          while (next < plan.captured.length) {
            const index = next++;
            const captured = plan.captured[index]!;
            outcomes[index] = await executeTarget(captured, signal).catch(() =>
              Object.freeze({
                target: captured.target,
                status: "skipped" as const,
                message: "Could not verify current connection authority. Preview again.",
              }),
            );
          }
        }),
      );
      return Object.freeze(outcomes);
    });
    const result = execution.finally(() => {
      if (active === result) active = null;
    });
    plan.execution = result;
    active = result;
    return result;
  };

  return { preview, execute };
}

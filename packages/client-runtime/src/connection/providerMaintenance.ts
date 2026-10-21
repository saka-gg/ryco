import type {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUpdatedPayload,
} from "@ryco/contracts";
import {
  deriveNodeMutationLease,
  nodeMutationLeaseIsCurrent,
  type NodeMutationLease,
  type NodeMutationReadiness,
} from "../authorization/nodeMutationLease.ts";
import { forEachWithConcurrency } from "../concurrency.ts";
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

/**
 * Whether one click may update this provider now: it is set up, behind its
 * latest release, the node can install that release itself, no update of it is
 * already queued or running, and it has no running turn (`busyInstanceIds`).
 */
export function isProviderUpdateEligible(
  provider: ServerProvider,
  busyInstanceIds: ReadonlyArray<ProviderInstanceId>,
): boolean {
  return (
    provider.enabled &&
    provider.installed &&
    provider.availability !== "unavailable" &&
    provider.status !== "disabled" &&
    provider.versionAdvisory?.status === "behind_latest" &&
    provider.versionAdvisory.canUpdate &&
    provider.updateState?.status !== "queued" &&
    provider.updateState?.status !== "running" &&
    !busyInstanceIds.includes(provider.instanceId)
  );
}

/**
 * Whether this set-up provider is behind its latest release but the node cannot
 * install it by itself, so someone at that machine has to
 * (`versionAdvisory.updateCommand` says how, when known).
 */
export function isProviderUpdateManual(provider: ServerProvider): boolean {
  return (
    provider.enabled &&
    provider.installed &&
    provider.availability !== "unavailable" &&
    provider.versionAdvisory?.status === "behind_latest" &&
    !provider.versionAdvisory.canUpdate
  );
}

/** The provider's installed and latest release as its version advisory reports them. */
export function providerUpdateVersions(provider: ServerProvider): {
  readonly fromVersion: string | null;
  readonly toVersion: string | null;
} {
  return {
    fromVersion: provider.versionAdvisory?.currentVersion ?? provider.version,
    toVersion: provider.versionAdvisory?.latestVersion ?? null,
  };
}

export type ProviderUpdateResultStatus = "succeeded" | "unchanged" | "failed" | "unknown";

/**
 * Reads one instance's result out of a `server.updateProvider` answer. Anything
 * but a terminal `updateState` is `unknown`: the install may still have run.
 */
export function readProviderUpdateResult(
  response: ServerProviderUpdatedPayload,
  target: { readonly instanceId: ProviderInstanceId; readonly driver: ProviderDriverKind },
): { readonly status: ProviderUpdateResultStatus; readonly message: string | null } {
  const updated = response.providers.find(
    (candidate) => candidate.instanceId === target.instanceId && candidate.driver === target.driver,
  );
  const status = updated?.updateState?.status;
  if (status === "succeeded" || status === "unchanged" || status === "failed") {
    return { status, message: updated?.updateState?.message ?? null };
  }
  return {
    status: "unknown",
    message: "Server did not return a terminal update result. Check provider status.",
  };
}

function eligible(provider: ServerProvider, environment: ProviderMaintenanceEnvironment): boolean {
  return isProviderUpdateEligible(provider, environment.activeInstanceIds);
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
        const versions = providerUpdateVersions(provider);
        const target = Object.freeze({
          environmentId,
          instanceId: provider.instanceId,
          driver: provider.driver,
          currentVersion: versions.fromVersion,
          latestVersion: versions.toVersion,
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
    const versions = provider ? providerUpdateVersions(provider) : null;
    if (
      !provider ||
      !versions ||
      !eligible(provider, environment) ||
      versions.fromVersion !== captured.target.currentVersion ||
      versions.toVersion !== captured.target.latestVersion
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
      const result = readProviderUpdateResult(response, captured.target);
      return outcome(result.status, result.message);
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
      await forEachWithConcurrency(plan.captured.length, concurrency, async (index) => {
        const captured = plan.captured[index]!;
        outcomes[index] = await executeTarget(captured, signal).catch(() =>
          Object.freeze({
            target: captured.target,
            status: "skipped" as const,
            message: "Could not verify current connection authority. Preview again.",
          }),
        );
      });
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

import {
  isPromptLinkLookupSettled,
  type PromptLinkLookupEnvironment,
} from "@ryco/client-runtime/promptLinks";
import type { EnvironmentConnectionState, EnvironmentId } from "@ryco/contracts";

/**
 * When the web app may resolve a prompt link: the pure half of
 * `usePromptLinkLookup`.
 *
 * The gate opens on the session the app's own lifecycle owner already
 * establishes, never on a readiness check of its own:
 * - hosted: the selected node's session is one selecting it would adopt
 *   (`canAdoptHostedEnvironmentSession`: a fresh relay attempt that accepted
 *   its own current shell snapshot, not suspended or interrupted since);
 * - otherwise: the primary environment applied its shell snapshot (a
 *   browser with saved environments only has no primary to wait for).
 *
 * Past the gate the lookup also waits for machines still connecting, so a
 * repository on one of them is not reported missing, until they settle or the
 * view's wait runs out.
 */
export interface PromptLinkLookupInput {
  readonly hosted: boolean;
  /** Hosted only: the selected node's session record is adoptable. */
  readonly hostedSessionAdoptable: boolean;
  readonly primaryEnvironmentId: EnvironmentId | null;
  /** Each environment the store holds state for: whether its shell snapshot was applied. */
  readonly shellCurrentByEnvironmentId: Readonly<Record<string, boolean>>;
  /** Every connection this browser knows of: saved, desktop and hosted machines. */
  readonly connections: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly connectionState: EnvironmentConnectionState;
  }>;
}

export interface PromptLinkLookupState {
  readonly gateOpen: boolean;
  readonly settled: boolean;
}

export function resolvePromptLinkLookup(input: PromptLinkLookupInput): PromptLinkLookupState {
  const gateOpen = input.hosted
    ? input.hostedSessionAdoptable
    : input.primaryEnvironmentId === null ||
      input.shellCurrentByEnvironmentId[input.primaryEnvironmentId] === true;
  const environments = new Map<string, PromptLinkLookupEnvironment>();
  for (const [environmentId, shellCurrent] of Object.entries(input.shellCurrentByEnvironmentId)) {
    environments.set(environmentId, { shellCurrent, connecting: false });
  }
  for (const connection of input.connections) {
    const known = environments.get(connection.environmentId);
    environments.set(connection.environmentId, {
      shellCurrent: known?.shellCurrent ?? false,
      connecting: (known?.connecting ?? false) || connection.connectionState === "connecting",
    });
  }
  return {
    gateOpen,
    settled: gateOpen && isPromptLinkLookupSettled([...environments.values()]),
  };
}

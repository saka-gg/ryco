import { isRemoteEnvironmentAuthHttpError } from "@ryco/client-runtime/connection";
import {
  addDeviceCodeFromCredential,
  type AddDeviceOperations,
} from "@ryco/client-runtime/machineAccess/addDeviceCode";
import {
  hostedNodeRevokeFailure,
  type HostedNodeRevokeFailure,
} from "@ryco/client-runtime/machineAccess/hostedNodeRevoke";
import type {
  RemoteMachineAccessApi,
  RemoteMachineAccessTarget,
} from "@ryco/client-runtime/machineAccess/remoteMachineAccess";
import type { AuthSessionId, EnvironmentId } from "@ryco/contracts";

/**
 * The calls the machine access screen makes, as plain async functions.
 *
 * Kept out of the components on purpose: every one of them awaits inside a
 * try/catch, which React Compiler declines to compile when it sits in a hook or
 * component body. Nothing here holds a bearer: each call reads the pairing's
 * current one from the store, because a renewal may have superseded the last
 * one and the node revokes a pairing that presents a superseded bearer.
 */

export interface DirectAccessDependencies {
  readonly api: RemoteMachineAccessApi;
  readonly readHttpBaseUrl: (environmentId: EnvironmentId) => string | null;
  readonly readBearerToken: (environmentId: EnvironmentId) => Promise<string | null>;
}

export class MachinePairingUnavailableError extends Error {
  constructor() {
    super("This phone no longer has a saved pairing for the machine. Pair it again.");
    this.name = "MachinePairingUnavailableError";
  }
}

async function readTarget(
  environmentId: EnvironmentId,
  deps: DirectAccessDependencies,
): Promise<RemoteMachineAccessTarget> {
  const httpBaseUrl = deps.readHttpBaseUrl(environmentId);
  const bearerToken = httpBaseUrl === null ? null : await deps.readBearerToken(environmentId);
  if (httpBaseUrl === null || !bearerToken) throw new MachinePairingUnavailableError();
  return { httpBaseUrl, bearerToken };
}

export interface DirectAccessOperations extends AddDeviceOperations {
  readonly revokeClientSession: (sessionId: AuthSessionId) => Promise<void>;
  readonly revokeOtherClientSessions: () => Promise<number>;
}

export function createDirectAccessOperations(
  environmentId: EnvironmentId,
  deps: DirectAccessDependencies,
): DirectAccessOperations {
  return {
    createCode: async (label) =>
      addDeviceCodeFromCredential(
        await deps.api.createPairingCredential(await readTarget(environmentId, deps), label),
      ),
    revokeCode: async (id) => deps.api.revokePairingLink(await readTarget(environmentId, deps), id),
    revokeClientSession: async (sessionId) =>
      deps.api.revokeClientSession(await readTarget(environmentId, deps), sessionId),
    revokeOtherClientSessions: async () =>
      deps.api.revokeOtherClientSessions(await readTarget(environmentId, deps)),
  };
}

/** One bounded sentence for a refused or failed direct access call. */
export function directAccessErrorMessage(
  error: unknown,
  action: string,
  machineLabel: string,
): string {
  if (error instanceof MachinePairingUnavailableError) return error.message;
  if (isRemoteEnvironmentAuthHttpError(error)) {
    if (error.status === 401) {
      return `${machineLabel} did not accept this phone's pairing. Pair it again, then retry.`;
    }
    if (error.status === 403) {
      return `Only an owner pairing can ${action} on ${machineLabel}.`;
    }
    return `${machineLabel} could not ${action}: ${error.message}`;
  }
  return `Could not reach ${machineLabel} to ${action}. Check that it is online and reachable from this phone.`;
}

export type ActionOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

/** Runs one call and turns its failure into the screen's sentence. */
export async function runDirectAccessAction<T>(
  run: () => Promise<T>,
  describe: (error: unknown) => string,
): Promise<ActionOutcome<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

/**
 * Revokes a node on the Hub, resolving only once the Hub has answered.
 *
 * Null when the revocation landed. Otherwise the failure, worded for the app,
 * carrying whether anything is known to have changed: a request that left and
 * got no answer is `unknown`, never "nothing was changed".
 */
export async function attemptHostedNodeRevoke(
  revoke: () => Promise<void>,
): Promise<HostedNodeRevokeFailure | null> {
  try {
    await revoke();
    return null;
  } catch (cause) {
    return hostedNodeRevokeFailure(cause, "app");
  }
}

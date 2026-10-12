import { captureReviewedSendReadiness } from "@ryco/client-runtime/state/composer";
import {
  createThreadForkKey,
  resolveThreadForkApi,
  THREAD_FORK_COPY,
  threadForkShellPorts,
  type ThreadForkAttemptControllerPorts,
} from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, ThreadForkKey } from "@ryco/contracts";

import { ensureEnvironmentApi } from "../../connection/environmentApi";
import { randomHex } from "../../lib/uuid";
import { createMobileConnectionRegistry } from "../../runtime/bootstrap";

// Mobile's side of `threads.fork`: the platform's random source, its connection registry and
// its EnvironmentApi seam. The key policy, which connection a send is checked against, the call,
// its classification and the attempt registry all come from the shared fork-attempt controller
// (`createThreadForkAttemptController`); nothing here retries or re-mints a key.

/** A fresh idempotency key; the shared state machine decides when one may be minted. */
export function mintThreadForkKey(): ThreadForkKey {
  return createThreadForkKey(() => randomHex(16));
}

/**
 * Captures the environment's live shell generation, so a fork reviewed against one connection
 * is never sent over another. Never establishes readiness.
 */
export function captureThreadForkReadiness(environmentId: EnvironmentId): () => void {
  return captureReviewedSendReadiness(
    environmentId,
    () => createMobileConnectionRegistry().driver.supervisor.read(environmentId),
    THREAD_FORK_COPY.connectionChanged,
  );
}

/** The platform ports of one fork sheet on one environment. */
export function mobileForkSheetPorts(
  environmentId: EnvironmentId,
): ThreadForkAttemptControllerPorts {
  return {
    mintKey: mintThreadForkKey,
    captureReadiness: () => captureThreadForkReadiness(environmentId),
    // Without a live client nothing is sent: the shared machine records the refusal, which
    // leaves whatever the node may already hold for the key exactly as it was.
    resolveApi: () => resolveThreadForkApi(() => ensureEnvironmentApi(environmentId)),
    ...threadForkShellPorts(environmentId),
  };
}

import { captureReviewedSendReadiness } from "@ryco/client-runtime/state/composer";
import type { EnvironmentId } from "@ryco/contracts";
import { useState } from "react";

import { readRpcClient } from "../../connection/environmentApi";
import { useConnectionRegistry } from "../../providers/ConnectionRegistryProvider";
import { useHomeEnvironments } from "../home/useHomeEnvironments";
import {
  describeExplorerChangeError,
  EXPLORER_NOT_READY,
  explorerChangeOffer,
  type ExplorerChangeOffer,
} from "./projectExplorerModel";

type RpcClient = NonNullable<ReturnType<typeof readRpcClient>>;

const CONNECTION_CHANGED = "The connection changed. Reconnect and try again.";

export interface ExplorerChangeRequest<T> {
  /** Names the change in flight (a button shows "Sending…" for its own kind only). */
  readonly kind: string;
  readonly perform: (client: RpcClient) => Promise<T>;
  /** Shown when the failure carries no message of its own. */
  readonly failure: string;
  readonly onDone: (result: T) => void;
  /** The failure in this change's own terms; the host's words by default. */
  readonly describeFailure?: (cause: unknown) => string;
}

export interface ExplorerChange {
  /** The kind in flight; null when idle. */
  readonly pending: string | null;
  /** Why the last change failed, until the next one starts. */
  readonly error: string | null;
  readonly offer: (method: string) => ExplorerChangeOffer;
  readonly run: <T>(request: ExplorerChangeRequest<T>) => void;
  readonly clearError: () => void;
}

/**
 * One screen's changes to the host (a comment, a new issue, a re-run, a
 * transition). Each is refused unless the node takes changes now, and re-checks
 * at send time that the connection it was offered on is still the current one
 * (the capture the thread and pull request screens send with). One at a time.
 */
export function useExplorerChange(environmentId: EnvironmentId | null): ExplorerChange {
  const { driver } = useConnectionRegistry();
  const environments = useHomeEnvironments();
  const environment = environments.find((entry) => entry.environmentId === environmentId);
  const mutationReady = environment?.mutationReady === true;
  const role = environment?.role;
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = <T>(request: ExplorerChangeRequest<T>) => {
    if (pending !== null || environmentId === null) return;
    // Read on press, never in render: the compiler would keep a render-time read.
    const client = mutationReady ? readRpcClient(environmentId) : null;
    if (client === null) {
      setError(EXPLORER_NOT_READY);
      return;
    }
    const assertReady = captureReviewedSendReadiness(
      environmentId,
      () => driver.supervisor.read(environmentId),
      CONNECTION_CHANGED,
    );
    setPending(request.kind);
    setError(null);
    Promise.resolve()
      .then(() => {
        assertReady();
        return request.perform(client);
      })
      .then(
        (result) => {
          setPending(null);
          request.onDone(result);
        },
        (cause: unknown) => {
          setPending(null);
          setError(
            request.describeFailure
              ? request.describeFailure(cause)
              : describeExplorerChangeError(cause, request.failure),
          );
        },
      );
  };

  return {
    pending,
    error,
    offer: (method) => explorerChangeOffer({ mutationReady, role, method }),
    run,
    clearError: () => setError(null),
  };
}

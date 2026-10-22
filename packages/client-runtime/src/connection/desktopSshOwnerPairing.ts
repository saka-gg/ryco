import type { AuthSessionRole, EnvironmentId } from "@ryco/contracts";

/**
 * Desktop SSH nodes pair as owner: on direct transport a client session acts as
 * a viewer, so only an owner bearer can add projects there or receive a copied
 * project. Nodes added before owner SSH pairing hold a client bearer and re-pair
 * as owner over their own tunnel.
 */

/**
 * What the last owner pairing of a Desktop SSH environment found, kept while
 * the app runs, with the Ryco version the node reported then (null when it was
 * not known). `unsupported`: the remote CLI could not mint owner credentials.
 * `failed`: the attempt itself failed (an SSH hiccup, a busy node, a refused
 * redeem) at `at`, which says nothing about the remote CLI.
 */
export type DesktopSshOwnerRepairOutcome =
  | { readonly kind: "unsupported"; readonly serverVersion: string | null }
  | { readonly kind: "failed"; readonly at: number; readonly serverVersion: string | null };

/** How long after a failed owner re-pair the next one may run. */
export const DESKTOP_SSH_OWNER_REPAIR_RETRY_MS = 10 * 60_000;

/**
 * When the environment is asked again on the version the outcome was found
 * on: after a failed re-pair, once its retry delay has passed; after an
 * unsupported one, never (null), only on another version.
 */
export function desktopSshOwnerRepairRetryAt(outcome: DesktopSshOwnerRepairOutcome): number | null {
  return outcome.kind === "failed" ? outcome.at + DESKTOP_SSH_OWNER_REPAIR_RETRY_MS : null;
}

export interface DesktopSshOwnerRepairInput {
  /** The saved environment is reached through a Desktop SSH tunnel. */
  readonly desktopSsh: boolean;
  /** The role the node reported for the bearer this connect presented. */
  readonly sessionRole: AuthSessionRole | null | undefined;
  /**
   * This connect already minted that bearer through the tunnel. The pairing
   * script asks for owner first, so a fresh client bearer means the remote CLI
   * cannot mint owner credentials yet.
   */
  readonly bearerIssuedThisConnect: boolean;
  /** The environment's last owner pairing outcome, if one was recorded. */
  readonly lastOutcome: DesktopSshOwnerRepairOutcome | undefined;
  /** The Ryco version the node reports now, or null when it is not known. */
  readonly serverVersion: string | null;
  readonly now: number;
}

export function shouldRepairDesktopSshAsOwner(input: DesktopSshOwnerRepairInput): boolean {
  if (!input.desktopSsh || input.sessionRole !== "client" || input.bearerIssuedThisConnect) {
    return false;
  }
  const last = input.lastOutcome;
  if (last === undefined) return true;
  // Updating Ryco on the node is what lets its CLI mint owner credentials, and
  // restarts the node, which may also clear what failed the attempt: a node
  // that now reports another version than the one the outcome was found on,
  // or a first known one, is asked again at once.
  if (input.serverVersion !== null && input.serverVersion !== last.serverVersion) return true;
  const retryAt = desktopSshOwnerRepairRetryAt(last);
  return retryAt !== null && input.now >= retryAt;
}

/**
 * The owner re-pair state of the app's Desktop SSH environments, kept while it
 * runs: each environment's last outcome, the re-pair running, and the retry of
 * a failed one.
 */
export interface DesktopSshOwnerRepairTracker {
  /** Whether a re-pair should start now: none is running and the policy asks for one. */
  readonly shouldRepair: (
    environmentId: EnvironmentId,
    input: Pick<
      DesktopSshOwnerRepairInput,
      "sessionRole" | "bearerIssuedThisConnect" | "serverVersion"
    >,
  ) => boolean;
  /**
   * Records what a pairing settled for the environment; `undefined` forgets
   * it (an owner bearer, a disconnect, a removal). A failed outcome arms its
   * retry, any other cancels it.
   */
  readonly record: (
    environmentId: EnvironmentId,
    outcome: DesktopSshOwnerRepairOutcome | undefined,
  ) => void;
  /**
   * Runs one re-pair of the environment, never two at once: resolves null at
   * once while another runs. When `repair` throws, cancelled or not, the
   * attempt is recorded as failed on `serverVersion`, the version the node
   * reported when it was decided, unless something recorded an outcome
   * meanwhile (a disconnect, a removal, a new pairing); the error is rethrown.
   */
  readonly run: <T>(
    environmentId: EnvironmentId,
    serverVersion: string | null,
    repair: () => Promise<T | null>,
  ) => Promise<T | null>;
  readonly outcome: (environmentId: EnvironmentId) => DesktopSshOwnerRepairOutcome | undefined;
  readonly reset: () => void;
}

export function createDesktopSshOwnerRepairTracker(input: {
  /**
   * A failed re-pair's retry is due while none runs. A connected node re-pairs
   * in place: its socket stays up while it is healthy, so neither a connect nor
   * a socket snapshot would ask again. One without a connection is asked by
   * its next connect.
   */
  readonly onRetryDue: (environmentId: EnvironmentId) => void;
  readonly now?: () => number;
  readonly setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeout?: (timeoutId: ReturnType<typeof setTimeout>) => void;
}): DesktopSshOwnerRepairTracker {
  const now = input.now ?? Date.now;
  const schedule = input.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancel = input.clearTimeout ?? ((timeoutId) => clearTimeout(timeoutId));
  const outcomes = new Map<EnvironmentId, DesktopSshOwnerRepairOutcome>();
  const running = new Set<EnvironmentId>();
  const retryTimers = new Map<EnvironmentId, ReturnType<typeof setTimeout>>();
  // Bumped by every record, so a re-pair that throws knows whether something
  // else settled the environment meanwhile.
  const revisions = new Map<EnvironmentId, number>();

  const cancelRetry = (environmentId: EnvironmentId) => {
    const timeoutId = retryTimers.get(environmentId);
    if (timeoutId === undefined) return;
    cancel(timeoutId);
    retryTimers.delete(environmentId);
  };

  const armRetry = (environmentId: EnvironmentId) => {
    cancelRetry(environmentId);
    const outcome = outcomes.get(environmentId);
    const retryAt = outcome === undefined ? null : desktopSshOwnerRepairRetryAt(outcome);
    if (retryAt === null) return;
    retryTimers.set(
      environmentId,
      schedule(
        () => {
          retryTimers.delete(environmentId);
          if (outcomes.get(environmentId) !== outcome) return;
          // A clock set back fires early; the policy reads the clock.
          if (now() < retryAt) {
            armRetry(environmentId);
            return;
          }
          // A running re-pair records its own outcome, which arms the next retry.
          if (!running.has(environmentId)) input.onRetryDue(environmentId);
        },
        Math.max(0, retryAt - now()),
      ),
    );
  };

  const record: DesktopSshOwnerRepairTracker["record"] = (environmentId, outcome) => {
    revisions.set(environmentId, (revisions.get(environmentId) ?? 0) + 1);
    if (outcome === undefined) outcomes.delete(environmentId);
    else outcomes.set(environmentId, outcome);
    armRetry(environmentId);
  };

  return {
    shouldRepair: (environmentId, repairInput) =>
      !running.has(environmentId) &&
      shouldRepairDesktopSshAsOwner({
        desktopSsh: true,
        ...repairInput,
        lastOutcome: outcomes.get(environmentId),
        now: now(),
      }),
    record,
    run: async (environmentId, serverVersion, repair) => {
      if (running.has(environmentId)) return null;
      running.add(environmentId);
      const revision = revisions.get(environmentId);
      try {
        return await repair();
      } catch (error) {
        // A hung attempt the connect gave up, or a connection replaced under
        // it, settled nothing: it is retried like any failure.
        if (revisions.get(environmentId) === revision) {
          record(environmentId, { kind: "failed", at: now(), serverVersion });
        }
        throw error;
      } finally {
        running.delete(environmentId);
      }
    },
    outcome: (environmentId) => outcomes.get(environmentId),
    reset: () => {
      for (const timeoutId of retryTimers.values()) cancel(timeoutId);
      retryTimers.clear();
      outcomes.clear();
      running.clear();
      revisions.clear();
    },
  };
}

/**
 * Why a Desktop SSH node cannot take projects, or null. A connected SSH node
 * still on a client session has a remote CLI that cannot mint owner
 * credentials: the owner re-pair ran during the connect, before the role was
 * published, and runs again once the node reports another Ryco version, or a
 * failed one once its retry delay has passed. Node
 * catalogs read `SavedEnvironmentRecord.desktopSsh` and
 * `SavedEnvironmentRuntimeState.role` for it.
 */
export function desktopSshMutateBlockedReason(input: {
  readonly desktopSsh: boolean;
  readonly role: AuthSessionRole | null;
  readonly label: string;
}): string | null {
  return input.desktopSsh && input.role === "client"
    ? `Update Ryco on ${input.label} to copy projects here`
    : null;
}

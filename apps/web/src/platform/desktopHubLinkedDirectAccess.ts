import type { EnvironmentId } from "@ryco/contracts";
import {
  hubLinkedDirectAccessDue,
  isManuallyPairedEnvironment,
  resolveHubLinkedDirectTarget,
} from "@ryco/client-runtime/connection";

import { fetchRemoteEnvironmentDescriptor } from "../environments/remote/api";
import {
  addSavedEnvironment,
  connectDesktopWorkspaceEnvironment,
  listSavedEnvironmentRecords,
} from "../environments/runtime";
import { listLinkedDirectRecords } from "../environments/runtime/catalog";

/**
 * Hub-linked direct access on Desktop
 * (`docs/superpowers/specs/2026-10-14-hub-linked-direct-access-design.md`).
 *
 * The owner adds direct access to a Hub machine with one action: the machine
 * issues a one-time code over the trusted relay channel Desktop already holds,
 * Desktop checks which of its direct addresses answers as that machine, and
 * saves the connection — no pairing link, no approval on the machine. A linked
 * connection is renewed through the relay whenever Desktop reconnects to the
 * machine and the link has aged.
 *
 * The link is a route of the Hub machine, not a second environment: the
 * machine keeps its Hub id, and each connection attempt takes the linked
 * address when it answers as the machine (`desktopHubLinkedRoutes.ts`).
 * Renewing it rewrites the stored address and bearer in place.
 */

export type DesktopHubLinkOutcome =
  | "linked"
  /** The user already paired this machine by hand; that pairing is left alone. */
  | "already-paired"
  /** The machine listens on loopback only. */
  | "no-direct-endpoint"
  /** None of its direct addresses answered from this network. */
  | "unreachable";

const DEVICE_LABEL = "Ryco Desktop";
/** After a failed automatic renewal, the next attempt waits at least this long. */
const AUTOMATIC_RENEWAL_RETRY_MS = 15 * 60 * 1000;

const inFlight = new Map<EnvironmentId, Promise<DesktopHubLinkOutcome>>();
const lastAutomaticAttemptAt = new Map<EnvironmentId, number>();

async function link(machine: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}): Promise<DesktopHubLinkOutcome> {
  const connection = await connectDesktopWorkspaceEnvironment(machine);
  const access = await connection.client.server.issueLinkedDirectAccess({
    deviceLabel: DEVICE_LABEL,
  });
  if (access.kind === "unavailable") return "no-direct-endpoint";
  // A machine the user paired by hand stays theirs: an environment of its own.
  if (isManuallyPairedEnvironment(listSavedEnvironmentRecords(), access.environmentId)) {
    return "already-paired";
  }
  const target = await resolveHubLinkedDirectTarget({
    access,
    fetchDescriptor: (httpBaseUrl) => fetchRemoteEnvironmentDescriptor({ httpBaseUrl }),
  });
  if (target === null) return "unreachable";
  await addSavedEnvironment({
    label: machine.label,
    host: target.httpBaseUrl,
    pairingCode: target.credential,
    hubLink: { hubEnvironmentId: machine.environmentId, linkedAt: new Date().toISOString() },
  });
  return "linked";
}

/** One link per machine at a time; a second request joins the first. */
function linkOnce(machine: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}): Promise<DesktopHubLinkOutcome> {
  const running = inFlight.get(machine.environmentId);
  if (running) return running;
  const attempt = link(machine).finally(() => {
    if (inFlight.get(machine.environmentId) === attempt) inFlight.delete(machine.environmentId);
  });
  inFlight.set(machine.environmentId, attempt);
  return attempt;
}

/** The owner's "Add direct access". Rejects with the reason when the machine refuses. */
export function linkDesktopMachineDirectAccess(machine: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}): Promise<DesktopHubLinkOutcome> {
  return linkOnce(machine);
}

/**
 * The owner's "Remove direct access": the link and its bearer go, and the
 * machine's connection leaves the direct route for the relay.
 */
export async function unlinkDesktopMachineDirectAccess(
  hubEnvironmentId: EnvironmentId,
): Promise<void> {
  const { forgetDesktopHubLinkedDirectAccess } = await import("./desktopHubLinkedRoutes");
  await forgetDesktopHubLinkedDirectAccess(hubEnvironmentId);
}

/** The direct environment linked to a Hub machine, if any. */
export function readDesktopMachineDirectLink(hubEnvironmentId: EnvironmentId) {
  return (
    listLinkedDirectRecords().find(
      (record) => record.hubLink?.hubEnvironmentId === hubEnvironmentId,
    ) ?? null
  );
}

/**
 * After Desktop connects to a Hub machine: renew a link the owner made once it
 * has aged, well within the node's seven days. Machines never linked are left
 * alone, and a failure waits before the next connect tries again.
 */
export function renewDesktopMachineDirectAccess(
  machine: {
    readonly environmentId: EnvironmentId;
    readonly label: string;
  },
  options?: {
    /** The node refused the link's bearer: renew whatever its age. */
    readonly force?: boolean;
  },
): void {
  if (readDesktopMachineDirectLink(machine.environmentId) === null) return;
  const nowMs = Date.now();
  if (
    options?.force !== true &&
    !hubLinkedDirectAccessDue({
      hubEnvironmentId: machine.environmentId,
      records: listLinkedDirectRecords(),
      nowMs,
    })
  ) {
    return;
  }
  const lastAttemptAt = lastAutomaticAttemptAt.get(machine.environmentId);
  if (lastAttemptAt !== undefined && nowMs - lastAttemptAt < AUTOMATIC_RENEWAL_RETRY_MS) return;
  lastAutomaticAttemptAt.set(machine.environmentId, nowMs);
  void linkOnce(machine).catch(() => undefined);
}

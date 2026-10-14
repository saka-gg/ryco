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
 * Linking is explicit rather than automatic because the direct connection is a
 * separate environment with its own id: until one machine can be routed over
 * either path, adding it shows the machine a second time.
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

/** The direct environment linked to a Hub machine, if any. */
export function readDesktopMachineDirectLink(hubEnvironmentId: EnvironmentId) {
  return (
    listSavedEnvironmentRecords().find(
      (record) => record.hubLink?.hubEnvironmentId === hubEnvironmentId,
    ) ?? null
  );
}

/**
 * After Desktop connects to a Hub machine: renew a link the owner made once it
 * has aged, well within the node's seven days. Machines never linked are left
 * alone, and a failure waits before the next connect tries again.
 */
export function renewDesktopMachineDirectAccess(machine: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}): void {
  if (readDesktopMachineDirectLink(machine.environmentId) === null) return;
  const nowMs = Date.now();
  if (
    !hubLinkedDirectAccessDue({
      hubEnvironmentId: machine.environmentId,
      records: listSavedEnvironmentRecords(),
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

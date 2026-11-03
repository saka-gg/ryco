/**
 * linkedAccessCheck - Keeps the node's Hub-linked direct sessions in step with
 * the Hub (`docs/hub-linked-access-check.md`).
 *
 * The node asks its Hub which account-enrolled devices holding linked sessions
 * would still be admitted on a relay channel, and at what role, then revokes
 * the sessions of a device that lost access and the ones above a lowered role.
 * It never raises a role or extends a session from an answer. It asks when the
 * connector comes online, when the Hub nudges it (`node.linked-access.changed`),
 * after the Hub closed a device's channel for a revocation, and every 15
 * minutes while any linked session stands.
 *
 * @module hubConnector/linkedAccessCheck
 */
import {
  NODE_LINKED_ACCESS_MAX_SUBJECTS,
  NodeLinkedAccessSubject,
  type NodeLinkedAccessStatus,
} from "@ryco/contracts/node-linked-access";
import type { RelayCloseReason, RelayEffectiveRole } from "@ryco/contracts/relay";
import { Option, Schema } from "effect";

import type { LinkedSessionSelector } from "../auth/Services/SessionCredentialService.ts";
import { base64UrlEncode } from "../auth/utils.ts";
import type { RelayChannelAuthority } from "../ws/RpcPrincipal.ts";

/** A relay channel that authenticated a device. */
export type RelayChannelDevice = Exclude<RelayChannelAuthority, { readonly trustSource: "none" }>;

/** A device's own links: its key and trust source, and its enrollment and account when it names them. */
export type ChannelDeviceLinks = Extract<
  LinkedSessionSelector,
  { readonly clientFingerprint: string }
>;

/** A device holding live linked sessions, at the highest role any of them has. */
export interface LinkedAccessDevice {
  readonly trustSource: "account-enrolled" | "locally-verified";
  readonly enrollmentId: string | null;
  readonly clientFingerprint: string;
  readonly accountId: string | null;
  readonly role: RelayEffectiveRole;
}

export type LinkedAccessAskOutcome =
  | { readonly kind: "answered"; readonly results: ReadonlyArray<NodeLinkedAccessStatus> }
  /** The Hub predates the route: ask again only after the next connect. */
  | { readonly kind: "unsupported" }
  | { readonly kind: "failed" };

export type LinkedAccessCheckTrigger = "online" | "nudge" | "channel-closed";

/** Between two checks, whatever asked; a nudge in between waits for the next slot. */
export const LINKED_ACCESS_CHECK_MIN_INTERVAL_MS = 30_000;
export const LINKED_ACCESS_CHECK_PERIOD_MS = 15 * 60_000;
/** The check after a connect waits up to this long: nodes reconnecting together spread out. */
export const LINKED_ACCESS_CHECK_CONNECT_JITTER_MS = 10_000;
/**
 * After a Hub answered that it has no such route, the node asks again this much later (or at
 * the next connect, or at once on a nudge, which only a Hub with the route sends): a 404 can
 * also come from a proxy in front of a Hub that has it.
 */
export const LINKED_ACCESS_CHECK_UNSUPPORTED_RETRY_MS = 60 * 60_000;

const ROLE_RANK: Readonly<Record<RelayEffectiveRole, number>> = {
  viewer: 0,
  operator: 1,
  owner: 2,
};
const ROLES: ReadonlyArray<RelayEffectiveRole> = ["viewer", "operator", "owner"];

/** The roles above `role`: the sessions an answer of `role` revokes. */
export function rolesAbove(role: RelayEffectiveRole): ReadonlyArray<RelayEffectiveRole> {
  return ROLES.filter((candidate) => ROLE_RANK[candidate] > ROLE_RANK[role]);
}

/**
 * The links of the device a relay channel authenticated, under the channel's
 * own enrollment and account when it names one: an account-enrolled key that
 * several accounts share on one install never selects another account's links.
 * A locally verified link records no account, so it is selected by key alone.
 */
export function channelDeviceLinks(device: RelayChannelDevice): ChannelDeviceLinks {
  return {
    clientFingerprint: base64UrlEncode(device.clientIdentityFingerprint),
    trustSource: device.trustSource,
    ...(device.trustSource === "account-enrolled"
      ? {
          enrollmentId: device.enrollmentId,
          ...(device.accountId === undefined ? {} : { accountId: device.accountId }),
        }
      : {}),
  };
}

/**
 * A device opened a relay channel at `device.role`: the Hub's current grant
 * intersected with the device's own ceiling (`relayChannelAuthority`). Its links
 * above that role end, whatever its trust source, so a member the Hub lowered
 * cannot keep the higher role on a direct route until the link ends. A link at
 * or below it stays and nothing is raised; a promoted member gets the new role
 * at their next link. `null` when no link can be above it.
 */
export function linkedAccessOpenNarrowing(
  device: RelayChannelDevice,
): (ChannelDeviceLinks & { readonly roles: ReadonlyArray<RelayEffectiveRole> }) | null {
  const roles = rolesAbove(device.role);
  return roles.length === 0 ? null : { ...channelDeviceLinks(device), roles };
}

/**
 * The devices to ask about, from the links of live linked sessions and of
 * unredeemed linked codes (a code redeemed after a check would otherwise stand
 * until the next one). One entry per device and account, at its highest role.
 */
export function linkedAccessDevices(
  links: ReadonlyArray<{
    readonly trustSource: LinkedAccessDevice["trustSource"];
    readonly enrollmentId: string | null;
    readonly clientFingerprint: string;
    readonly accountId?: string;
    readonly role: RelayEffectiveRole;
  }>,
): ReadonlyArray<LinkedAccessDevice> {
  const byKey = new Map<string, LinkedAccessDevice>();
  for (const link of links) {
    const device: LinkedAccessDevice = {
      trustSource: link.trustSource,
      enrollmentId: link.enrollmentId,
      clientFingerprint: link.clientFingerprint,
      accountId: link.accountId ?? null,
      role: link.role,
    };
    const key = JSON.stringify([
      device.trustSource,
      device.clientFingerprint,
      device.accountId,
      device.enrollmentId,
    ]);
    const known = byKey.get(key);
    if (known === undefined || ROLE_RANK[device.role] > ROLE_RANK[known.role]) {
      byKey.set(key, device);
    }
  }
  return [...byKey.values()];
}

/**
 * What a Hub `channel.close` on a device's relay channel asks of the node.
 * `grant_revoked` means the member's grant on this node was revoked or replaced
 * (a role change): that device's links end now, and the Hub is asked about the
 * rest. `revoked` also covers a Hub sign-out, so it only asks. A client can close
 * its own channel with any reason, which only ends its own links.
 */
export function linkedAccessCloseReaction(
  reason: RelayCloseReason | undefined,
  device: { readonly clientIdentityFingerprint: Uint8Array } | null,
): { readonly revokeDevice: boolean; readonly check: boolean } {
  if (device === null) return { revokeDevice: false, check: false };
  if (reason === "grant_revoked") return { revokeDevice: true, check: true };
  return { revokeDevice: false, check: reason === "revoked" };
}

export interface LinkedAccessCheckDeps {
  readonly listDevices: () => Promise<ReadonlyArray<LinkedAccessDevice>>;
  readonly ask: (
    subjects: ReadonlyArray<NodeLinkedAccessSubject>,
  ) => Promise<LinkedAccessAskOutcome>;
  /**
   * Revokes the device's linked sessions (only those at `roles` when given) and
   * its unredeemed linked codes.
   */
  readonly revoke: (
    device: LinkedAccessDevice,
    roles?: ReadonlyArray<RelayEffectiveRole>,
  ) => Promise<void>;
  readonly isOnline: () => boolean;
  readonly now: () => number;
  readonly random: () => number;
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  readonly onError?: (error: unknown) => void;
}

export interface LinkedAccessCheck {
  readonly request: (trigger: LinkedAccessCheckTrigger) => void;
  readonly stop: () => void;
  /** Settles once no check is running (tests). */
  readonly idle: () => Promise<void>;
}

const decodeSubject = Schema.decodeUnknownOption(NodeLinkedAccessSubject);

function subjectOf(device: LinkedAccessDevice): NodeLinkedAccessSubject | null {
  // Only the Hub enrolled these; a locally verified key is the node owner's own decision.
  if (device.trustSource !== "account-enrolled" || device.enrollmentId === null) return null;
  // A stored value the route would refuse must not fail the other devices' question.
  return Option.getOrNull(
    decodeSubject({
      ...(device.accountId === null ? {} : { accountId: device.accountId }),
      enrollmentId: device.enrollmentId,
      clientFingerprint: device.clientFingerprint,
    }),
  );
}

export function startLinkedAccessCheck(deps: LinkedAccessCheckDeps): LinkedAccessCheck {
  let stopped = false;
  let unsupported = false;
  let running: Promise<void> | null = null;
  // A request that arrived while a check ran: its answer may predate the change.
  let dirty = false;
  // Counts connects, so a check from an earlier connection cannot mark the Hub unsupported.
  let connection = 0;
  let timer: unknown;
  let timerAt = Infinity;
  let lastStartedAt = -Infinity;

  const schedule = (delayMs: number) => {
    if (stopped) return;
    const at = deps.now() + Math.max(0, delayMs);
    if (timer !== undefined && timerAt <= at) return;
    if (timer !== undefined) deps.clearTimeout(timer);
    timerAt = at;
    timer = deps.setTimeout(
      () => {
        timer = undefined;
        timerAt = Infinity;
        start();
      },
      Math.max(0, delayMs),
    );
  };

  const nextSlot = () =>
    Math.max(0, lastStartedAt + LINKED_ACCESS_CHECK_MIN_INTERVAL_MS - deps.now());

  const periodicDelay = () => LINKED_ACCESS_CHECK_PERIOD_MS * (0.8 + 0.4 * deps.random());

  const applyAnswers = async (
    devices: ReadonlyArray<LinkedAccessDevice>,
    results: ReadonlyArray<NodeLinkedAccessStatus>,
  ) => {
    for (let index = 0; index < devices.length; index += 1) {
      if (stopped) return;
      const device = devices[index]!;
      const result = results[index]!;
      if (result.status === "withdrawn") {
        await deps.revoke(device);
      } else if (result.status === "active" && ROLE_RANK[result.role] < ROLE_RANK[device.role]) {
        await deps.revoke(device, rolesAbove(result.role));
      }
    }
  };

  /** `true` when every answer arrived and applied. */
  const check = async (startedOn: number): Promise<boolean> => {
    const devices = (await deps.listDevices()).flatMap((device) => {
      const subject = subjectOf(device);
      return subject === null ? [] : [{ device, subject }];
    });
    for (let start = 0; start < devices.length; start += NODE_LINKED_ACCESS_MAX_SUBJECTS) {
      if (stopped || !deps.isOnline()) return false;
      const batch = devices.slice(start, start + NODE_LINKED_ACCESS_MAX_SUBJECTS);
      const outcome = await deps.ask(batch.map((entry) => entry.subject));
      if (outcome.kind === "unsupported") {
        if (startedOn === connection) unsupported = true;
        return false;
      }
      if (outcome.kind === "failed") return false;
      if (startedOn === connection) unsupported = false;
      // One answer per subject, or none of them is trusted.
      if (outcome.results.length !== batch.length) return false;
      if (stopped) return false;
      await applyAnswers(
        batch.map((entry) => entry.device),
        outcome.results,
      );
    }
    return true;
  };

  const start = () => {
    if (stopped || !deps.isOnline()) return;
    if (running !== null) {
      dirty = true;
      return;
    }
    const wait = nextSlot();
    if (wait > 0) {
      schedule(wait);
      return;
    }
    dirty = false;
    lastStartedAt = deps.now();
    running = check(connection)
      .catch((error: unknown) => {
        deps.onError?.(error);
        return false;
      })
      .then(() => {
        running = null;
        if (stopped) return;
        if (unsupported) {
          schedule(LINKED_ACCESS_CHECK_UNSUPPORTED_RETRY_MS);
          return;
        }
        if (dirty) {
          dirty = false;
          schedule(nextSlot());
          return;
        }
        schedule(periodicDelay());
      });
  };

  return {
    request: (trigger) => {
      if (stopped) return;
      if (trigger === "online") {
        // A new connection may reach a Hub that gained (or lost) the route.
        connection += 1;
        unsupported = false;
        schedule(deps.random() * LINKED_ACCESS_CHECK_CONNECT_JITTER_MS);
        return;
      }
      // Only a Hub with the route nudges; any other request waits out an unsupported Hub.
      if (trigger === "nudge") unsupported = false;
      else if (unsupported) return;
      if (running !== null) {
        dirty = true;
        return;
      }
      schedule(nextSlot());
    },
    stop: () => {
      stopped = true;
      if (timer !== undefined) deps.clearTimeout(timer);
      timer = undefined;
    },
    idle: async () => {
      while (running !== null) await running;
    },
  };
}

/**
 * NodePushRegistry - The node's push registrations, device presence and the
 * Hub's last answer, shared by the device RPCs and the attention publisher
 * (`docs/push-alerts.md`).
 *
 * Only this tag and its types are on the boot path. The store behind it
 * (`nodePushRegistryStore.ts`) is built with the Hub connector, which provides
 * it to each relay channel's RPCs: push needs a Hub-enrolled device, so a
 * direct connection never finds it.
 *
 * @module push/NodePushRegistry
 */
import type {
  PushDeviceStatus,
  PushHubDelivery,
  PushPresence,
  PushRegisterDeviceInput,
} from "@ryco/contracts/push";
import { Context, type Effect } from "effect";

import type { RpcPrincipalRole } from "../ws/RpcPrincipal.ts";
import type { PushRegistration } from "./pushRegistrations.ts";

/** The device a relay channel's verified grant names, and the role it acts at. */
export interface PushDeviceIdentity {
  readonly enrollmentId: string;
  readonly role: RpcPrincipalRole;
}

export interface NodePushRegistryShape {
  readonly register: (
    device: PushDeviceIdentity,
    input: PushRegisterDeviceInput,
  ) => Effect.Effect<PushDeviceStatus>;
  readonly unregister: (
    device: PushDeviceIdentity,
    keyId: string,
  ) => Effect.Effect<{ readonly removed: boolean }>;
  readonly setPresence: (device: PushDeviceIdentity, presence: PushPresence) => Effect.Effect<void>;
  /** Live registrations, pruned. */
  readonly list: Effect.Effect<ReadonlyArray<PushRegistration>>;
  /** Enrollments whose device said it is in front within the hold. */
  readonly foregroundEnrollments: (nowMs: number) => Effect.Effect<ReadonlySet<string>>;
  /** The next signal's sequence, persisted before it is returned. */
  readonly reserveSequence: Effect.Effect<number>;
  readonly removeEnrollments: (enrollmentIds: ReadonlyArray<string>) => Effect.Effect<void>;
  /** Forgets every registration (the node left its Hub). The sequence keeps growing. */
  readonly clear: Effect.Effect<void>;
  readonly setHubDelivery: (delivery: PushHubDelivery) => Effect.Effect<void>;
}

export class NodePushRegistry extends Context.Service<NodePushRegistry, NodePushRegistryShape>()(
  "ryco/push/NodePushRegistry",
) {}

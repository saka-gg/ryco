import {
  resolveHostedDeliveryNotice,
  type HostedDeliveryNotice,
} from "@ryco/client-runtime/authorization";
import type { EnvironmentId } from "@ryco/contracts";

import type {
  MobileHostedConnectionCoordinator,
  MobileHostedConnectionState,
} from "../../connection/hostedConnectionCoordinator";

export type ThreadDeliveryRecord = Pick<
  MobileHostedConnectionState,
  "environmentId" | "label" | "sessionStatus" | "sessionRecoveredAfterUnknown"
>;

/**
 * The thread's machine's own connection record, not the shared selection
 * cursor — so a retained, non-selected machine shows and clears its notice from
 * its thread too. Records are replaced only when they change, so the selection
 * stays referentially stable across unrelated publishes.
 */
export function selectThreadDeliveryRecord<Record extends ThreadDeliveryRecord>(
  records: ReadonlyArray<Record>,
  environmentId: EnvironmentId,
): Record | null {
  return records.find((candidate) => candidate.environmentId === environmentId) ?? null;
}

export function buildThreadDeliveryNotice(
  record: ThreadDeliveryRecord | null,
): HostedDeliveryNotice | null {
  return record ? resolveHostedDeliveryNotice(record, record.label) : null;
}

export function acknowledgeThreadDelivery(
  coordinator: Pick<MobileHostedConnectionCoordinator, "acknowledgeDeliveryUnknown">,
  environmentId: EnvironmentId,
): void {
  coordinator.acknowledgeDeliveryUnknown(environmentId);
}

import type { ProviderDriverKind, ProviderInstanceId, ServerProvider } from "@ryco/contracts";
import type { Stream } from "effect";
import type { ProviderConversationRollbackMode } from "./Services/ProviderAdapter.ts";
import type { ServerProviderShape } from "./Services/ServerProvider.ts";

export type ProviderSnapshotSource = {
  /**
   * Routing key — uniquely identifies this instance in the aggregated
   * snapshot list. Two different snapshot sources may share the same
   * driver kind (multiple instances of the same driver).
   */
  readonly instanceId: ProviderInstanceId;
  /** Driver implementation kind. */
  readonly driverKind: ProviderDriverKind;
  /**
   * The adapter's checkpoint-revert capability, stamped onto every snapshot as
   * `supportsConversationRollback`. Absent when the source has no adapter.
   */
  readonly conversationRollback?: ProviderConversationRollbackMode;
  readonly getSnapshot: ServerProviderShape["getSnapshot"];
  readonly revalidate: ServerProviderShape["revalidate"];
  readonly refresh: ServerProviderShape["refresh"];
  readonly streamChanges: Stream.Stream<ServerProvider>;
};

import {
  CONTEXT_HANDOFF_CONTEXT_VERSION,
  CONTEXT_HANDOFF_ERROR_MAX_CHARS,
  ContextHandoffId,
  ContextHandoffStatus,
  IsoDateTime,
  MessageId,
  ModelSelection,
  PositiveInt,
  RuntimeSessionId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "@ryco/contracts";
import { Context, Option, Schema } from "effect";
import type { Effect } from "effect";

import type { ContextHandoffRepositoryError } from "../Errors.ts";

/** An operation record's status: the activity payload's statuses, persisted as the same literals. */
export const ContextHandoffOperationalStatus = ContextHandoffStatus;
export type ContextHandoffOperationalStatus = ContextHandoffStatus;

const ContextDigest = TrimmedNonEmptyString.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const ContextHandoffError = TrimmedNonEmptyString.check(
  Schema.isMaxLength(CONTEXT_HANDOFF_ERROR_MAX_CHARS),
);

export const ContextHandoffRecord = Schema.Struct({
  handoffId: ContextHandoffId,
  threadId: ThreadId,
  sourceSelection: ModelSelection,
  targetSelection: ModelSelection,
  sourceRuntimeSessionId: Schema.NullOr(RuntimeSessionId),
  targetRuntimeSessionId: Schema.NullOr(RuntimeSessionId),
  status: ContextHandoffOperationalStatus,
  contextVersion: PositiveInt,
  structuredContext: Schema.NullOr(Schema.Unknown),
  contextDigest: Schema.NullOr(ContextDigest),
  deliveryArtifact: Schema.NullOr(Schema.Unknown),
  firstMessageId: MessageId,
  acceptedProviderTurnId: Schema.NullOr(TurnId),
  error: Schema.NullOr(ContextHandoffError),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ContextHandoffRecord = typeof ContextHandoffRecord.Type;

export const CreateContextHandoffInput = ContextHandoffRecord;
export type CreateContextHandoffInput = typeof CreateContextHandoffInput.Type;

export const GetContextHandoffInput = Schema.Struct({
  handoffId: ContextHandoffId,
});
export type GetContextHandoffInput = typeof GetContextHandoffInput.Type;

export const ListContextHandoffsByThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListContextHandoffsByThreadInput = typeof ListContextHandoffsByThreadInput.Type;

export const CompareAndSetContextHandoffStatusInput = Schema.Struct({
  handoffId: ContextHandoffId,
  expectedStatus: ContextHandoffOperationalStatus,
  nextStatus: ContextHandoffOperationalStatus,
  targetRuntimeSessionId: Schema.NullOr(RuntimeSessionId),
  acceptedProviderTurnId: Schema.NullOr(TurnId),
  error: Schema.NullOr(ContextHandoffError),
  updatedAt: IsoDateTime,
});
export type CompareAndSetContextHandoffStatusInput =
  typeof CompareAndSetContextHandoffStatusInput.Type;

export const StoreContextHandoffContextInput = Schema.Struct({
  handoffId: ContextHandoffId,
  contextVersion: PositiveInt,
  structuredContext: Schema.Unknown,
  contextDigest: ContextDigest,
  updatedAt: IsoDateTime,
});
export type StoreContextHandoffContextInput = typeof StoreContextHandoffContextInput.Type;

export const StoreContextHandoffDeliveryArtifactInput = Schema.Struct({
  handoffId: ContextHandoffId,
  deliveryArtifact: Schema.Unknown,
  updatedAt: IsoDateTime,
});
export type StoreContextHandoffDeliveryArtifactInput =
  typeof StoreContextHandoffDeliveryArtifactInput.Type;

export const makeRequestedContextHandoffRecord = (
  input: Omit<
    ContextHandoffRecord,
    | "status"
    | "contextVersion"
    | "structuredContext"
    | "contextDigest"
    | "deliveryArtifact"
    | "targetRuntimeSessionId"
    | "acceptedProviderTurnId"
    | "error"
  >,
): ContextHandoffRecord => ({
  ...input,
  targetRuntimeSessionId: null,
  status: "requested",
  contextVersion: CONTEXT_HANDOFF_CONTEXT_VERSION,
  structuredContext: null,
  contextDigest: null,
  deliveryArtifact: null,
  acceptedProviderTurnId: null,
  error: null,
});

export interface ContextHandoffRepositoryShape {
  readonly create: (
    input: CreateContextHandoffInput,
  ) => Effect.Effect<boolean, ContextHandoffRepositoryError>;
  readonly getById: (
    input: GetContextHandoffInput,
  ) => Effect.Effect<Option.Option<ContextHandoffRecord>, ContextHandoffRepositoryError>;
  readonly listByThread: (
    input: ListContextHandoffsByThreadInput,
  ) => Effect.Effect<ReadonlyArray<ContextHandoffRecord>, ContextHandoffRepositoryError>;
  readonly listRecoverable: () => Effect.Effect<
    ReadonlyArray<ContextHandoffRecord>,
    ContextHandoffRepositoryError
  >;
  readonly compareAndSetStatus: (
    input: CompareAndSetContextHandoffStatusInput,
  ) => Effect.Effect<boolean, ContextHandoffRepositoryError>;
  readonly storeContextIfEmpty: (
    input: StoreContextHandoffContextInput,
  ) => Effect.Effect<boolean, ContextHandoffRepositoryError>;
  readonly storeDeliveryArtifactIfEmpty: (
    input: StoreContextHandoffDeliveryArtifactInput,
  ) => Effect.Effect<boolean, ContextHandoffRepositoryError>;
}

export class ContextHandoffRepository extends Context.Service<
  ContextHandoffRepository,
  ContextHandoffRepositoryShape
>()("ryco/persistence/Services/ContextHandoffs/ContextHandoffRepository") {}

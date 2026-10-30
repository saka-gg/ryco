import type {
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderSessionRuntimeStatus,
  RuntimeSessionId,
  RuntimeMode,
  ThreadId,
} from "@ryco/contracts";
import { Option, Context } from "effect";
import type { Effect } from "effect";

import type {
  ProviderSessionDirectoryPersistenceError,
  ProviderValidationError,
} from "../Errors.ts";

export interface ProviderRuntimeBinding {
  readonly threadId: ThreadId;
  readonly provider: ProviderDriverKind;
  /**
   * Routing key for the configured provider instance that owns this
   * session. The persistence layer promotes legacy null rows before
   * exposing bindings; runtime callers must not infer this from `provider`.
   */
  readonly providerInstanceId?: ProviderInstanceId;
  /**
   * Exact provider-native runtime epoch. Omission is accepted only for
   * persisted rows created before the context-handoff migration.
   */
  readonly runtimeSessionId?: RuntimeSessionId;
  readonly adapterKey?: string;
  readonly status?: ProviderSessionRuntimeStatus;
  readonly resumeCursor?: unknown | null;
  readonly runtimePayload?: unknown | null;
  readonly runtimeMode?: RuntimeMode;
}

export interface ProviderRuntimeBindingWithMetadata extends ProviderRuntimeBinding {
  readonly lastSeenAt: string;
}

export type ProviderSessionDirectoryReadError = ProviderSessionDirectoryPersistenceError;

export type ProviderSessionDirectoryWriteError =
  | ProviderValidationError
  | ProviderSessionDirectoryPersistenceError;

export interface ProviderSessionDirectoryShape {
  readonly upsert: (
    binding: ProviderRuntimeBinding,
  ) => Effect.Effect<void, ProviderSessionDirectoryWriteError>;

  readonly getProvider: (
    threadId: ThreadId,
  ) => Effect.Effect<ProviderDriverKind, ProviderSessionDirectoryReadError>;

  readonly getBinding: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProviderRuntimeBinding>, ProviderSessionDirectoryReadError>;

  /** Every binding the node has ever recorded, stopped ones included. */
  readonly listBindings: () => Effect.Effect<
    ReadonlyArray<ProviderRuntimeBindingWithMetadata>,
    ProviderSessionDirectoryPersistenceError
  >;

  /**
   * The bindings that are not stopped: their session may still hold a provider process.
   * Grows with the sessions in use, not with the node's history.
   */
  readonly listActiveBindings: () => Effect.Effect<
    ReadonlyArray<ProviderRuntimeBindingWithMetadata>,
    ProviderSessionDirectoryPersistenceError
  >;
}

export class ProviderSessionDirectory extends Context.Service<
  ProviderSessionDirectory,
  ProviderSessionDirectoryShape
>()("ryco/provider/Services/ProviderSessionDirectory") {}

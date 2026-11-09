/**
 * AutomationHookStore - The hooks of webhook schedules (`docs/automation-webhooks.md`).
 *
 * Node state beside the automation definitions: each webhook schedule's hook id, its secret (in
 * the server secret store), the last request it took, the delivery keys it handled in the last
 * 48 hours, and what the Hub took at the last sync. The automation lifecycle keeps the hooks in
 * step (`reconcile`); the request pipeline (`automationHookRequest.ts`) and the Hub sync read
 * them.
 *
 * @module automationHooks/Services/AutomationHookStore
 */
import type {
  AgentControlAutomation,
  AgentControlAutomationId,
  AutomationHookRequestOutcome,
} from "@ryco/contracts";
import { Context, Data } from "effect";
import type { Effect, Option } from "effect";

export class AutomationHookStoreError extends Data.TaggedError("AutomationHookStoreError")<{
  readonly operation: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return `Automation hook storage failed in ${this.operation}.`;
  }
}

export type AutomationHookVia = "cloud" | "direct";

export interface AutomationHookRecord {
  readonly automationId: AgentControlAutomationId;
  readonly hookId: string;
  readonly createdAt: string;
  readonly secretUpdatedAt: string;
  readonly lastRequest: {
    readonly at: string;
    readonly via: AutomationHookVia;
    readonly outcome: AutomationHookRequestOutcome;
  } | null;
}

/**
 * What the node knows about its Hub and hooks: `unsupported` after a Hub answered the sync with
 * 404 (until the next connect), `synced` after an answered sync, `unknown` before either.
 */
export type AutomationHookHubSyncState = "unknown" | "synced" | "unsupported";

export interface AutomationHookStoreShape {
  /**
   * Keeps the automation's hook in step with its definition: a webhook schedule that is not
   * cancelled has one (created with a fresh id and secret when missing); anything else has
   * none (its hook, secret and delivery keys are deleted). Tells the listeners either way.
   */
  readonly reconcile: (
    automation: AgentControlAutomation,
  ) => Effect.Effect<Option.Option<AutomationHookRecord>, AutomationHookStoreError>;
  readonly get: (
    automationId: AgentControlAutomationId,
  ) => Effect.Effect<Option.Option<AutomationHookRecord>, AutomationHookStoreError>;
  readonly findByHookId: (
    hookId: string,
  ) => Effect.Effect<Option.Option<AutomationHookRecord>, AutomationHookStoreError>;
  /** The hook's secret, as senders configure it (unpadded base64url of 32 random bytes). */
  readonly secret: (
    hook: AutomationHookRecord,
  ) => Effect.Effect<Option.Option<string>, AutomationHookStoreError>;
  /** Replaces the secret; the old one stops working at once. */
  readonly regenerate: (
    automationId: AgentControlAutomationId,
  ) => Effect.Effect<Option.Option<AutomationHookRecord>, AutomationHookStoreError>;
  readonly recordRequest: (input: {
    readonly automationId: AgentControlAutomationId;
    readonly at: string;
    readonly via: AutomationHookVia;
    readonly outcome: AutomationHookRequestOutcome;
  }) => Effect.Effect<void, AutomationHookStoreError>;
  /** Whether the hook handled any of these delivery keys at or after `since`. */
  readonly seenDelivery: (input: {
    readonly hookId: string;
    readonly keys: ReadonlyArray<string>;
    readonly since: string;
  }) => Effect.Effect<boolean, AutomationHookStoreError>;
  /** Records handled delivery keys (and drops every key older than `pruneBefore`). */
  readonly rememberDelivery: (input: {
    readonly hookId: string;
    readonly keys: ReadonlyArray<string>;
    readonly at: string;
    readonly started: boolean;
    readonly pruneBefore: string;
  }) => Effect.Effect<void, AutomationHookStoreError>;
  readonly forgetDelivery: (input: {
    readonly hookId: string;
    readonly keys: ReadonlyArray<string>;
  }) => Effect.Effect<void, AutomationHookStoreError>;
  /** The requests that started a run at or after `since`, and the oldest of them. */
  readonly startedSince: (input: {
    readonly hookId: string;
    readonly since: string;
  }) => Effect.Effect<
    { readonly count: number; readonly oldest: string | null },
    AutomationHookStoreError
  >;
  /** The hook ids of enabled, not cancelled webhook schedules: what the Hub should hold. */
  readonly enabledHookIds: Effect.Effect<ReadonlyArray<string>, AutomationHookStoreError>;
  /** The hook ids the Hub took at the last answered sync. */
  readonly hubRegistered: Effect.Effect<ReadonlyArray<string>, AutomationHookStoreError>;
  readonly setHubRegistered: (
    hookIds: ReadonlyArray<string>,
  ) => Effect.Effect<void, AutomationHookStoreError>;
  readonly hubSyncState: () => AutomationHookHubSyncState;
  readonly setHubSyncState: (state: AutomationHookHubSyncState) => void;
  /** Called after any hook may have changed (created, deleted, paused, resumed). */
  readonly onChange: (listener: () => void) => () => void;
  /** Tells the listeners that the set of enabled hooks may have changed. */
  readonly notifyChanged: () => void;
}

export class AutomationHookStore extends Context.Service<
  AutomationHookStore,
  AutomationHookStoreShape
>()("ryco/automationHooks/Services/AutomationHookStore") {}

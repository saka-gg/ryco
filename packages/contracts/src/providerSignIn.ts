/**
 * Signing a provider instance in from any client: the node runs the provider's own login and
 * owners follow it through `provider.signIn.subscribe`. Clients send only an instance id; the
 * node resolves the binary, homes and environment the way the instance's driver does.
 *
 * @module providerSignIn
 */
import * as Schema from "effect/Schema";

import {
  ForwardCompatibleUnion,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const FlowId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));

/**
 * - `codexDeviceCode`: Codex's device-code login; the page opens on the client's own device.
 * - `terminal`: the CLI's login command in a terminal the node runs.
 */
export const ProviderSignInMethod = Schema.Literals(["codexDeviceCode", "terminal"]);
export type ProviderSignInMethod = typeof ProviderSignInMethod.Type;

/** `succeeded`, `failed`, `cancelled` and `expired` end a flow; the node shows them a while. */
export const ProviderSignInPhase = Schema.Literals([
  "idle",
  "starting",
  "waiting",
  "verifying",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
]);
export type ProviderSignInPhase = typeof ProviderSignInPhase.Type;

/** What the user acts on while a flow waits. */
export const ProviderSignInInteraction = ForwardCompatibleUnion(
  [
    Schema.Struct({
      type: Schema.Literal("deviceCode"),
      /** Always an `https:` URL. */
      verificationUrl: Schema.String.check(Schema.isMaxLength(2048)),
      userCode: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
    }),
    Schema.Struct({ type: Schema.Literal("terminal"), cols: PositiveInt, rows: PositiveInt }),
  ],
  "type",
);
export type ProviderSignInInteraction = typeof ProviderSignInInteraction.Type;

export const ProviderSignInState = Schema.Struct({
  instanceId: ProviderInstanceId,
  phase: ProviderSignInPhase,
  flowId: Schema.NullOr(FlowId),
  /** While idle, the method Start would use; `null` when sign-in is unavailable. */
  method: Schema.NullOr(ProviderSignInMethod),
  unavailableReason: Schema.NullOr(Schema.String.check(Schema.isMaxLength(300))),
  interaction: Schema.NullOr(ProviderSignInInteraction),
  expiresAt: Schema.NullOr(IsoDateTime),
  message: Schema.NullOr(Schema.String.check(Schema.isMaxLength(500))),
});
export type ProviderSignInState = typeof ProviderSignInState.Type;

/** An event as the node builds it. */
export const ProviderSignInEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("state"), state: ProviderSignInState }),
  /**
   * Terminal output; `offset` is the transcript offset of `data[0]`. `reset` marks the retained
   * tail a (re)subscription starts with.
   */
  Schema.Struct({
    type: Schema.Literal("output"),
    flowId: FlowId,
    offset: NonNegativeInt,
    data: Schema.String.check(Schema.isMaxLength(65_536)),
    reset: Schema.optional(Schema.Boolean),
  }),
]);
export type ProviderSignInEvent = typeof ProviderSignInEvent.Type;

/** An event as a client decodes it: one a newer node adds decodes to a placeholder it skips. */
export const ProviderSignInWireEvent = ForwardCompatibleUnion(ProviderSignInEvent.members, "type");
export type ProviderSignInWireEvent = typeof ProviderSignInWireEvent.Type;

export const ProviderSignInAction = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("input"),
    data: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4096)),
  }),
  Schema.Struct({
    type: Schema.Literal("resize"),
    cols: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })),
    rows: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 })),
  }),
  Schema.Struct({ type: Schema.Literal("cancel") }),
]);
export type ProviderSignInAction = typeof ProviderSignInAction.Type;

export const ProviderSignInInput = Schema.Struct({ instanceId: ProviderInstanceId });
export type ProviderSignInInput = typeof ProviderSignInInput.Type;

export const ProviderSignInRespondInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  flowId: FlowId,
  action: ProviderSignInAction,
});
export type ProviderSignInRespondInput = typeof ProviderSignInRespondInput.Type;

export class ProviderSignInError extends Schema.TaggedError<ProviderSignInError>()(
  "ProviderSignInError",
  { message: Schema.String },
) {}

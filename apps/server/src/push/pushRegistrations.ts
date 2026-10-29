/**
 * pushRegistrations - Which native devices want this node's push alerts, as a
 * pure state value (`docs/push-alerts.md`).
 *
 * A registration is an application record a device asks for over its own
 * account-enrolled relay channel. It is not an E2EE admission record: it holds
 * the device's push public key, never its identity keys, and the node keys it
 * by the enrollment the channel's verified grant named. One registration per
 * enrollment; a new key replaces the old one. Devices refresh it on every
 * connect, so one that stops coming back ages out.
 *
 * @module push/pushRegistrations
 */
import {
  PUSH_ACTION_ALERT_KINDS,
  PushAlertKind,
  PushKeyId,
  PushPublicKey,
  type PushRegisterDeviceInput,
} from "@ryco/contracts/push";
import { Schema } from "effect";

import type { RpcPrincipalRole } from "../ws/RpcPrincipal.ts";

/** A registration nobody refreshed for this long is dropped. */
export const PUSH_REGISTRATION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
/** The least recently refreshed registration gives way beyond this many. */
export const PUSH_MAX_REGISTRATIONS = 64;

const IsoMillis = Schema.Number.check(
  Schema.makeFilter((value) => Number.isSafeInteger(value) && value >= 0),
);

export const PushRegistration = Schema.Struct({
  enrollmentId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  keyId: PushKeyId,
  publicKey: PushPublicKey,
  role: Schema.Literals(["viewer", "operator", "owner"]),
  kinds: Schema.Array(PushAlertKind),
  sound: Schema.Boolean,
  /** 32 random bytes, base64url: keys this device's collapse ids. */
  collapseSalt: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u)),
  createdAt: IsoMillis,
  refreshedAt: IsoMillis,
});
export type PushRegistration = typeof PushRegistration.Type;

export const PushRegistrationState = Schema.Struct({
  version: Schema.Literal(1),
  /**
   * The least sequence the next attention signal may use. Sequences only grow,
   * and never fall below the clock (see {@link reservePushSequence}), so even a
   * lost state file cannot make the Hub take a new signal for a replay.
   */
  nextSequence: IsoMillis,
  registrations: Schema.Array(PushRegistration),
});
export type PushRegistrationState = typeof PushRegistrationState.Type;

export const EMPTY_PUSH_REGISTRATION_STATE: PushRegistrationState = {
  version: 1,
  nextSequence: 1,
  registrations: [],
};

/** The next signal's sequence: above every earlier one, and at least the clock in ms. */
export function reservePushSequence(
  state: PushRegistrationState,
  nowMs: number,
): { readonly state: PushRegistrationState; readonly sequence: number } {
  const sequence = Math.max(state.nextSequence, Math.floor(nowMs));
  return { state: { ...state, nextSequence: sequence + 1 }, sequence };
}

/** The kinds a registration receives: what it asked for, without action kinds for a viewer. */
export function effectivePushKinds(
  registration: Pick<PushRegistration, "kinds" | "role">,
): ReadonlyArray<PushAlertKind> {
  return registration.role === "viewer"
    ? registration.kinds.filter((kind) => !PUSH_ACTION_ALERT_KINDS.has(kind))
    : registration.kinds;
}

/** Drops expired registrations and keeps the most recently refreshed ones within the cap. */
export function prunePushRegistrations(
  state: PushRegistrationState,
  nowMs: number,
): PushRegistrationState {
  const live = state.registrations
    .filter((registration) => nowMs - registration.refreshedAt < PUSH_REGISTRATION_TTL_MS)
    .toSorted((left, right) => right.refreshedAt - left.refreshedAt)
    .slice(0, PUSH_MAX_REGISTRATIONS);
  return live.length === state.registrations.length &&
    live.every((registration, index) => registration === state.registrations[index])
    ? state
    : { ...state, registrations: live };
}

/**
 * Records `input` for the device `enrollmentId` speaks for. Re-registering the
 * same key keeps its collapse salt (alerts keep replacing each other); a new
 * key starts over with `newSalt`.
 */
export function registerPushDevice(
  state: PushRegistrationState,
  device: {
    readonly enrollmentId: string;
    readonly role: RpcPrincipalRole;
    readonly input: PushRegisterDeviceInput;
    readonly newSalt: string;
    readonly nowMs: number;
  },
): PushRegistrationState {
  const previous = state.registrations.find(
    (registration) => registration.enrollmentId === device.enrollmentId,
  );
  const sameKey = previous?.keyId === device.input.keyId;
  const next: PushRegistration = {
    enrollmentId: device.enrollmentId,
    keyId: device.input.keyId,
    publicKey: device.input.publicKey,
    role: device.role,
    kinds: Array.from(new Set(device.input.kinds)),
    sound: device.input.sound,
    collapseSalt: sameKey ? previous.collapseSalt : device.newSalt,
    createdAt: sameKey ? previous.createdAt : device.nowMs,
    refreshedAt: device.nowMs,
  };
  return prunePushRegistrations(
    {
      ...state,
      registrations: [
        next,
        ...state.registrations.filter(
          (registration) => registration.enrollmentId !== device.enrollmentId,
        ),
      ],
    },
    device.nowMs,
  );
}

/** Removes the device's registration if it still holds `keyId`. */
export function unregisterPushDevice(
  state: PushRegistrationState,
  device: { readonly enrollmentId: string; readonly keyId: string },
): { readonly state: PushRegistrationState; readonly removed: boolean } {
  const registrations = state.registrations.filter(
    (registration) =>
      registration.enrollmentId !== device.enrollmentId || registration.keyId !== device.keyId,
  );
  return registrations.length === state.registrations.length
    ? { state, removed: false }
    : { state: { ...state, registrations }, removed: true };
}

/** Removes every registration of the given enrollments (revoked, or no longer authorized). */
export function removePushEnrollments(
  state: PushRegistrationState,
  enrollmentIds: ReadonlySet<string>,
): PushRegistrationState {
  const registrations = state.registrations.filter(
    (registration) => !enrollmentIds.has(registration.enrollmentId),
  );
  return registrations.length === state.registrations.length ? state : { ...state, registrations };
}

const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(PushRegistrationState));

/** The stored state; an unreadable file reads as empty (registrations are refreshed on connect). */
export function decodePushRegistrationState(raw: string): PushRegistrationState {
  const decoded = decodeState(raw);
  return decoded._tag === "Some" ? decoded.value : EMPTY_PUSH_REGISTRATION_STATE;
}

export function encodePushRegistrationState(state: PushRegistrationState): string {
  return `${JSON.stringify(state)}\n`;
}

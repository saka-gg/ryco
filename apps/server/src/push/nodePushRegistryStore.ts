/**
 * nodePushRegistryStore - The store behind {@link NodePushRegistry}, loaded on
 * the first push call.
 *
 * Registrations live in `hub-push.json` beside the node's other Hub state,
 * read on first use and written atomically through one lock. Presence is
 * memory only: a device that says it is in front is skipped for
 * {@link PUSH_FOREGROUND_HOLD_MS} unless it says so again, so a phone that
 * died in front gets push again within a minute.
 *
 * @module push/nodePushRegistryStore
 */
import { randomBytes } from "node:crypto";

import type { PushDeviceStatus, PushHubDelivery } from "@ryco/contracts/push";
import { Effect, FileSystem, Option, Path, Semaphore } from "effect";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import type { NodePushRegistry, NodePushRegistryShape } from "./NodePushRegistry.ts";

/** Beside the node's Hub identity state, so it moves and is erased with it. */
export const PUSH_REGISTRATION_FILE_NAME = "hub-push.json";
import {
  decodePushRegistrationState,
  EMPTY_PUSH_REGISTRATION_STATE,
  effectivePushKinds,
  encodePushRegistrationState,
  prunePushRegistrations,
  registerPushDevice,
  removePushEnrollments,
  reservePushSequence,
  unregisterPushDevice,
  type PushRegistration,
  type PushRegistrationState,
} from "./pushRegistrations.ts";

/** How long a device's "I'm in front" holds without being said again. */
export const PUSH_FOREGROUND_HOLD_MS = 45_000;

const toStatus = (
  registration: PushRegistration | undefined,
  hubDelivery: PushHubDelivery,
): PushDeviceStatus => ({
  eligible: true,
  registered: registration !== undefined,
  keyId: registration?.keyId ?? null,
  kinds: registration === undefined ? [] : effectivePushKinds(registration),
  hubDelivery,
});

export const makeNodePushRegistry = (options: {
  readonly filePath: string;
  readonly now?: () => number;
  readonly newSalt?: () => string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    const now = options.now ?? Date.now;
    const newSalt = options.newSalt ?? (() => randomBytes(32).toString("base64url"));
    const lock = yield* Semaphore.make(1);
    let state: PushRegistrationState | null = null;
    let hubDelivery: PushHubDelivery = "offline";
    const foregroundUntil = new Map<string, number>();

    const load = Effect.gen(function* () {
      if (state !== null) return state;
      const raw = yield* fs.readFileString(options.filePath).pipe(Effect.option);
      state = Option.isSome(raw)
        ? decodePushRegistrationState(raw.value)
        : EMPTY_PUSH_REGISTRATION_STATE;
      return state;
    });

    /** Applies `change` under the lock and persists the result when it differs. */
    const update = <A>(
      change: (current: PushRegistrationState) => {
        readonly state: PushRegistrationState;
        readonly value: A;
      },
    ) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const current = prunePushRegistrations(yield* load, now());
          const next = change(current);
          if (next.state !== state) {
            yield* writeFileStringAtomically({
              filePath: options.filePath,
              contents: encodePushRegistrationState(next.state),
            });
            state = next.state;
          }
          return next.value;
        }).pipe(Effect.provideContext(platform)),
      );

    const find = (current: PushRegistrationState, enrollmentId: string) =>
      current.registrations.find((registration) => registration.enrollmentId === enrollmentId);

    const service: NodePushRegistryShape = {
      register: (device, input) =>
        update((current) => {
          const next = registerPushDevice(current, {
            enrollmentId: device.enrollmentId,
            role: device.role,
            input,
            newSalt: newSalt(),
            nowMs: now(),
          });
          return { state: next, value: toStatus(find(next, device.enrollmentId), hubDelivery) };
        }).pipe(Effect.orDie),
      unregister: (device, input) =>
        update((current) => {
          const result = unregisterPushDevice(current, {
            enrollmentId: device.enrollmentId,
            keyId: input.keyId,
            publicKey: input.publicKey,
          });
          return { state: result.state, value: { removed: result.removed } };
        }).pipe(Effect.orDie),
      setPresence: (device, presence) =>
        Effect.sync(() => {
          if (presence === "foreground") {
            foregroundUntil.set(device.enrollmentId, now() + PUSH_FOREGROUND_HOLD_MS);
          } else {
            foregroundUntil.delete(device.enrollmentId);
          }
        }).pipe(
          // Read, never written: a presence tick must not rewrite the registration file.
          Effect.andThen(lock.withPermits(1)(load)),
          Effect.map((current) =>
            toStatus(
              find(prunePushRegistrations(current, now()), device.enrollmentId),
              hubDelivery,
            ),
          ),
          Effect.orDie,
        ),
      list: lock
        .withPermits(1)(load)
        .pipe(
          Effect.map((current) => prunePushRegistrations(current, now()).registrations),
          Effect.orDie,
        ),
      foregroundEnrollments: (nowMs) =>
        Effect.sync(() => {
          const enrollments = new Set<string>();
          for (const [enrollmentId, until] of foregroundUntil) {
            if (until > nowMs) enrollments.add(enrollmentId);
            else foregroundUntil.delete(enrollmentId);
          }
          return enrollments;
        }),
      reserveSequence: update((current) => {
        const reserved = reservePushSequence(current, now());
        return { state: reserved.state, value: reserved.sequence };
      }).pipe(Effect.orDie),
      removeEnrollments: (enrollmentIds) =>
        enrollmentIds.length === 0
          ? Effect.void
          : update((current) => ({
              state: removePushEnrollments(current, new Set(enrollmentIds)),
              value: undefined,
            })).pipe(Effect.orDie),
      clear: update((current) => ({
        state: current.registrations.length === 0 ? current : { ...current, registrations: [] },
        value: undefined,
      })).pipe(
        Effect.tap(() => Effect.sync(() => foregroundUntil.clear())),
        Effect.orDie,
      ),
      setHubDelivery: (delivery) =>
        Effect.sync(() => {
          hubDelivery = delivery;
        }),
    };
    return service;
  });

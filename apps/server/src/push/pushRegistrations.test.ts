import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_PUSH_REGISTRATION_STATE,
  PUSH_MAX_REGISTRATIONS,
  PUSH_REGISTRATION_TTL_MS,
  decodePushRegistrationState,
  effectivePushKinds,
  encodePushRegistrationState,
  prunePushRegistrations,
  registerPushDevice,
  removePushEnrollments,
  reservePushSequence,
  unregisterPushDevice,
} from "./pushRegistrations.ts";

const KEY_A = "AAAAAAAAAAAAAAAAAAAAAA";
const KEY_B = "BBBBBBBBBBBBBBBBBBBBBB";
const PUBLIC = "x".repeat(43);
const SALT_1 = "1".repeat(43);
const SALT_2 = "2".repeat(43);

const register = (
  state = EMPTY_PUSH_REGISTRATION_STATE,
  overrides: Partial<{
    enrollmentId: string;
    accountId: string;
    keyId: string;
    role: "viewer" | "operator" | "owner";
    newSalt: string;
    nowMs: number;
  }> = {},
) =>
  registerPushDevice(state, {
    enrollmentId: overrides.enrollmentId ?? "enr_device",
    accountId: overrides.accountId ?? "acct_alice",
    role: overrides.role ?? "owner",
    input: {
      keyId: overrides.keyId ?? KEY_A,
      publicKey: PUBLIC,
      kinds: ["approval", "completed", "completed"],
      sound: true,
    },
    newSalt: overrides.newSalt ?? SALT_1,
    nowMs: overrides.nowMs ?? 1_000,
  });

describe("push registrations", () => {
  it("keeps one registration per enrollment, its salt while the key stays", () => {
    const first = register();
    const refreshed = register(first, { newSalt: SALT_2, nowMs: 2_000 });
    expect(refreshed.registrations).toHaveLength(1);
    expect(refreshed.registrations[0]).toMatchObject({
      keyId: KEY_A,
      collapseSalt: SALT_1,
      createdAt: 1_000,
      refreshedAt: 2_000,
      kinds: ["approval", "completed"],
    });
    const rekeyed = register(refreshed, { keyId: KEY_B, newSalt: SALT_2, nowMs: 3_000 });
    expect(rekeyed.registrations[0]).toMatchObject({
      keyId: KEY_B,
      collapseSalt: SALT_2,
      createdAt: 3_000,
    });
  });

  it("never sends action alerts to a viewer", () => {
    const viewer = register(undefined, { role: "viewer" }).registrations[0]!;
    expect(effectivePushKinds(viewer)).toEqual(["completed"]);
    const owner = register(undefined, { role: "owner" }).registrations[0]!;
    expect(effectivePushKinds(owner)).toEqual(["approval", "completed"]);
  });

  it("unregisters only the key the device still holds", () => {
    const state = register();
    expect(unregisterPushDevice(state, { enrollmentId: "enr_device", keyId: KEY_B }).removed).toBe(
      false,
    );
    expect(unregisterPushDevice(state, { enrollmentId: "enr_other", keyId: KEY_A }).removed).toBe(
      false,
    );
    const result = unregisterPushDevice(state, { enrollmentId: "enr_device", keyId: KEY_A });
    expect(result.removed).toBe(true);
    expect(result.state.registrations).toEqual([]);
  });

  it("retires a key an earlier installation of the same account left, by its public key", () => {
    // The reinstalled app is a new enrollment of the same account; it names the key its
    // earlier installation left.
    const state = register(register(), { enrollmentId: "enr_new", keyId: KEY_B });
    const otherPublic = "y".repeat(43);
    expect(
      unregisterPushDevice(state, {
        enrollmentId: "enr_new",
        accountId: "acct_alice",
        keyId: KEY_A,
        publicKey: otherPublic,
      }).removed,
    ).toBe(false);
    const result = unregisterPushDevice(state, {
      enrollmentId: "enr_new",
      accountId: "acct_alice",
      keyId: KEY_A,
      publicKey: PUBLIC,
    });
    expect(result.removed).toBe(true);
    expect(result.state.registrations.map((entry) => entry.enrollmentId)).toEqual(["enr_new"]);
  });

  it("never lets another account remove a registration by its public key", () => {
    // Bob reads Alice's public key from a node he owns, where Alice's phone registered too,
    // and names it on a node where he has a viewer grant.
    const state = register();
    expect(
      unregisterPushDevice(state, {
        enrollmentId: "enr_bob",
        accountId: "acct_bob",
        keyId: KEY_A,
        publicKey: PUBLIC,
      }).removed,
    ).toBe(false);
    // Nor a caller whose account is unknown, nor a registration from before accounts were kept.
    expect(
      unregisterPushDevice(state, { enrollmentId: "enr_new", keyId: KEY_A, publicKey: PUBLIC })
        .removed,
    ).toBe(false);
    const { accountId: _dropped, ...legacy } = state.registrations[0]!;
    expect(
      unregisterPushDevice(
        { ...state, registrations: [legacy] },
        { enrollmentId: "enr_new", accountId: "acct_alice", keyId: KEY_A, publicKey: PUBLIC },
      ).removed,
    ).toBe(false);
  });

  it("drops stale registrations and keeps the most recent within the cap", () => {
    let state = EMPTY_PUSH_REGISTRATION_STATE;
    for (let index = 0; index < PUSH_MAX_REGISTRATIONS + 3; index += 1) {
      state = register(state, { enrollmentId: `enr_${index}`, nowMs: 10_000 + index });
    }
    expect(state.registrations).toHaveLength(PUSH_MAX_REGISTRATIONS);
    expect(state.registrations.some((registration) => registration.enrollmentId === "enr_0")).toBe(
      false,
    );
    const later = prunePushRegistrations(state, 10_000 + 70 + PUSH_REGISTRATION_TTL_MS);
    expect(later.registrations).toEqual([]);
    expect(prunePushRegistrations(state, 10_100)).toBe(state);
  });

  it("removes revoked enrollments", () => {
    const state = register(register(undefined, { enrollmentId: "enr_a" }), {
      enrollmentId: "enr_b",
    });
    expect(
      removePushEnrollments(state, new Set(["enr_a"])).registrations.map(
        (registration) => registration.enrollmentId,
      ),
    ).toEqual(["enr_b"]);
    expect(removePushEnrollments(state, new Set(["enr_c"]))).toBe(state);
  });

  it("hands out growing sequences that never fall below the clock", () => {
    const first = reservePushSequence(EMPTY_PUSH_REGISTRATION_STATE, 5_000);
    expect(first.sequence).toBe(5_000);
    const second = reservePushSequence(first.state, 4_000);
    expect(second.sequence).toBe(5_001);
    // A lost state file restarts from the clock, still above anything sent before.
    expect(reservePushSequence(EMPTY_PUSH_REGISTRATION_STATE, 9_000).sequence).toBe(9_000);
  });

  it("round-trips through the state file and reads a broken one as empty", () => {
    const state = reservePushSequence(register(), 7_000).state;
    expect(decodePushRegistrationState(encodePushRegistrationState(state))).toEqual(state);
    expect(decodePushRegistrationState("{not json")).toEqual(EMPTY_PUSH_REGISTRATION_STATE);
    expect(decodePushRegistrationState('{"version":2}')).toEqual(EMPTY_PUSH_REGISTRATION_STATE);
  });
});

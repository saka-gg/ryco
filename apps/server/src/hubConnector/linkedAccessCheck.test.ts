import type { NodeLinkedAccessSubject } from "@ryco/contracts/node-linked-access";
import type { RelayEffectiveRole } from "@ryco/contracts/relay";
import { describe, expect, it } from "vite-plus/test";

import {
  channelDeviceLinks,
  linkedAccessCloseReaction,
  linkedAccessOpenNarrowing,
  LINKED_ACCESS_CHECK_MIN_INTERVAL_MS,
  LINKED_ACCESS_CHECK_PERIOD_MS,
  LINKED_ACCESS_CHECK_UNSUPPORTED_RETRY_MS,
  rolesAbove,
  startLinkedAccessCheck,
  linkedAccessDevices,
  type LinkedAccessAskOutcome,
  type LinkedAccessDevice,
} from "./linkedAccessCheck.ts";

const fingerprint = (fill: string) => fill.repeat(43);

const device = (
  overrides: Partial<LinkedAccessDevice> & { readonly clientFingerprint: string },
): LinkedAccessDevice => ({
  trustSource: "account-enrolled",
  enrollmentId: `enr_${"a".repeat(22)}`,
  accountId: "acct_1",
  role: "owner",
  ...overrides,
});

/** A clock and timer queue the test advances by hand. */
function harness(input: {
  readonly devices: () => ReadonlyArray<LinkedAccessDevice>;
  readonly answer: (
    subjects: ReadonlyArray<NodeLinkedAccessSubject>,
  ) => LinkedAccessAskOutcome | Promise<LinkedAccessAskOutcome>;
}) {
  let now = 1_000_000;
  let online = true;
  const timers: Array<{ at: number; callback: () => void; id: number }> = [];
  let nextId = 1;
  const asked: Array<ReadonlyArray<NodeLinkedAccessSubject>> = [];
  const revoked: Array<{ fingerprint: string; roles?: ReadonlyArray<RelayEffectiveRole> }> = [];
  const check = startLinkedAccessCheck({
    listDevices: async () => input.devices(),
    ask: async (subjects) => {
      asked.push(subjects);
      return input.answer(subjects);
    },
    revoke: async (target, roles) => {
      revoked.push({
        fingerprint: target.clientFingerprint,
        ...(roles === undefined ? {} : { roles }),
      });
    },
    isOnline: () => online,
    now: () => now,
    random: () => 0.5,
    setTimeout: (callback, delayMs) => {
      const id = nextId++;
      timers.push({ at: now + delayMs, callback, id });
      return id;
    },
    clearTimeout: (handle) => {
      const index = timers.findIndex((timer) => timer.id === handle);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      timers.sort((left, right) => left.at - right.at);
      const next = timers[0];
      if (next === undefined || next.at > until) break;
      timers.shift();
      now = next.at;
      next.callback();
      await check.idle();
    }
    now = until;
  };
  return {
    check,
    asked,
    revoked,
    advance,
    setOnline: (value: boolean) => {
      online = value;
    },
  };
}

describe("linked access check", () => {
  it("ends a device's links when the Hub closes its channel for a revoked grant", () => {
    const device = { clientIdentityFingerprint: new Uint8Array(32) };
    expect(linkedAccessCloseReaction("grant_revoked", device)).toEqual({
      revokeDevice: true,
      check: true,
    });
    // `revoked` is also a Hub sign-out: ask, don't assume.
    expect(linkedAccessCloseReaction("revoked", device)).toEqual({
      revokeDevice: false,
      check: true,
    });
    for (const reason of [undefined, "node_offline", "server_draining"] as const) {
      expect(linkedAccessCloseReaction(reason, device)).toEqual({
        revokeDevice: false,
        check: false,
      });
    }
    // A channel with no device (web, legacy) links nothing.
    expect(linkedAccessCloseReaction("grant_revoked", null)).toEqual({
      revokeDevice: false,
      check: false,
    });
  });

  it("narrows a device's own links to the role its new relay channel opened at", () => {
    const key = new Uint8Array(32).fill(7);
    const encoded = Buffer.from(key).toString("base64url");
    const enrolled = {
      trustSource: "account-enrolled",
      enrollmentId: "enr_studio",
      accountId: "acct_a",
      clientIdentityFingerprint: key,
    } as const;
    // Only the channel's own enrollment and account: another account on the same key keeps its own.
    expect(linkedAccessOpenNarrowing({ ...enrolled, role: "viewer" })).toEqual({
      clientFingerprint: encoded,
      trustSource: "account-enrolled",
      enrollmentId: "enr_studio",
      accountId: "acct_a",
      roles: ["operator", "owner"],
    });
    expect(linkedAccessOpenNarrowing({ ...enrolled, role: "operator" })?.roles).toEqual(["owner"]);
    // Nothing is above owner, and nothing is ever raised.
    expect(linkedAccessOpenNarrowing({ ...enrolled, role: "owner" })).toBeNull();
    // A locally verified device: its key, under no enrollment.
    expect(
      linkedAccessOpenNarrowing({
        trustSource: "locally-verified",
        clientIdentityFingerprint: key,
        role: "viewer",
      }),
    ).toEqual({
      clientFingerprint: encoded,
      trustSource: "locally-verified",
      roles: ["operator", "owner"],
    });
    // A grant from before nodes kept the account names none.
    const { accountId: _accountId, ...withoutAccount } = enrolled;
    expect(channelDeviceLinks({ ...withoutAccount, role: "owner" })).toEqual({
      clientFingerprint: encoded,
      trustSource: "account-enrolled",
      enrollmentId: "enr_studio",
    });
  });

  it("revokes a withdrawn device and the sessions above a lowered role, never more", async () => {
    const devices = [
      device({ clientFingerprint: fingerprint("a") }),
      device({ clientFingerprint: fingerprint("b"), role: "owner" }),
      device({ clientFingerprint: fingerprint("c"), role: "operator" }),
      device({ clientFingerprint: fingerprint("d") }),
    ];
    const h = harness({
      devices: () => devices,
      answer: () => ({
        kind: "answered",
        results: [
          { status: "withdrawn" },
          { status: "active", role: "viewer" },
          // A promotion is not applied: the device links again at its next renewal.
          { status: "active", role: "owner" },
          { status: "unknown" },
        ],
      }),
    });

    h.check.request("online");
    await h.advance(10_000);

    expect(h.asked).toHaveLength(1);
    expect(h.revoked).toEqual([
      { fingerprint: fingerprint("a") },
      { fingerprint: fingerprint("b"), roles: ["operator", "owner"] },
    ]);
    expect(rolesAbove("operator")).toEqual(["owner"]);
  });

  it("asks only about Hub-enrolled devices, by account, enrollment and key", async () => {
    const h = harness({
      devices: () => [
        device({ clientFingerprint: fingerprint("a") }),
        device({ clientFingerprint: fingerprint("b"), accountId: null }),
        device({
          clientFingerprint: fingerprint("c"),
          trustSource: "locally-verified",
          enrollmentId: null,
          accountId: null,
        }),
        // Not a fingerprint the route accepts: left out rather than failing the others.
        device({ clientFingerprint: "short" }),
      ],
      answer: (subjects) => ({
        kind: "answered",
        results: subjects.map(() => ({ status: "unknown" }) as const),
      }),
    });

    h.check.request("online");
    await h.advance(10_000);

    expect(h.asked).toEqual([
      [
        {
          accountId: "acct_1",
          enrollmentId: `enr_${"a".repeat(22)}`,
          clientFingerprint: fingerprint("a"),
        },
        { enrollmentId: `enr_${"a".repeat(22)}`, clientFingerprint: fingerprint("b") },
      ],
    ]);
  });

  it("applies nothing from an answer that does not match its question", async () => {
    const h = harness({
      devices: () => [
        device({ clientFingerprint: fingerprint("a") }),
        device({ clientFingerprint: fingerprint("b") }),
      ],
      answer: () => ({ kind: "answered", results: [{ status: "withdrawn" }] }),
    });

    h.check.request("online");
    await h.advance(10_000);

    expect(h.asked).toHaveLength(1);
    expect(h.revoked).toEqual([]);
  });

  it("checks again after a nudge that arrived while it was asking", async () => {
    let answers = 0;
    let release: (() => void) | undefined;
    const h = harness({
      devices: () => [device({ clientFingerprint: fingerprint("a") })],
      answer: () => {
        answers += 1;
        if (answers > 1) return { kind: "answered", results: [{ status: "withdrawn" }] };
        // The first answer predates the change the nudge reports.
        return new Promise((resolve) => {
          release = () =>
            resolve({ kind: "answered", results: [{ status: "active", role: "owner" }] });
        });
      },
    });

    h.check.request("online");
    const first = h.advance(10_000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.check.request("nudge");
    release?.();
    await first;
    expect(h.revoked).toEqual([]);

    // The next check waits for its slot, then sees the change.
    await h.advance(LINKED_ACCESS_CHECK_MIN_INTERVAL_MS);
    expect(answers).toBe(2);
    expect(h.revoked).toEqual([{ fingerprint: fingerprint("a") }]);
  });

  it("holds nudges to one check per interval and checks every period", async () => {
    const h = harness({
      devices: () => [device({ clientFingerprint: fingerprint("a") })],
      answer: () => ({ kind: "answered", results: [{ status: "active", role: "owner" }] }),
    });

    h.check.request("nudge");
    await h.advance(0);
    expect(h.asked).toHaveLength(1);

    for (let index = 0; index < 5; index += 1) h.check.request("nudge");
    await h.advance(LINKED_ACCESS_CHECK_MIN_INTERVAL_MS - 1);
    expect(h.asked).toHaveLength(1);
    await h.advance(1);
    expect(h.asked).toHaveLength(2);

    await h.advance(LINKED_ACCESS_CHECK_PERIOD_MS);
    expect(h.asked).toHaveLength(3);
  });

  it("waits out a Hub without the route: an hour, a nudge or the next connect asks again", async () => {
    let outcome: LinkedAccessAskOutcome = { kind: "unsupported" };
    const h = harness({
      devices: () => [device({ clientFingerprint: fingerprint("a") })],
      answer: () => outcome,
    });

    h.check.request("online");
    await h.advance(10_000);
    h.check.request("channel-closed");
    await h.advance(2 * LINKED_ACCESS_CHECK_PERIOD_MS);
    expect(h.asked).toHaveLength(1);
    // A 404 may have come from a proxy: the node asks again within the hour.
    await h.advance(LINKED_ACCESS_CHECK_UNSUPPORTED_RETRY_MS);
    expect(h.asked).toHaveLength(2);

    // Only a Hub that has the route nudges: that answers the question at once.
    outcome = { kind: "answered", results: [{ status: "active", role: "owner" }] };
    h.check.request("nudge");
    await h.advance(0);
    expect(h.asked).toHaveLength(3);

    // Offline, nothing is asked; the next connect asks.
    outcome = { kind: "answered", results: [{ status: "withdrawn" }] };
    h.setOnline(false);
    h.check.request("online");
    await h.advance(2 * LINKED_ACCESS_CHECK_PERIOD_MS);
    expect(h.asked).toHaveLength(3);
    h.setOnline(true);
    h.check.request("online");
    await h.advance(10_000);
    expect(h.asked).toHaveLength(4);
    expect(h.revoked).toEqual([{ fingerprint: fingerprint("a") }]);
  });

  it("ignores a no-route answer from a check that began on an earlier connection", async () => {
    let release: ((outcome: LinkedAccessAskOutcome) => void) | undefined;
    let calls = 0;
    const h = harness({
      devices: () => [device({ clientFingerprint: fingerprint("a") })],
      answer: () => {
        calls += 1;
        if (calls === 1) return new Promise((resolve) => (release = resolve));
        return { kind: "answered", results: [{ status: "withdrawn" }] };
      },
    });

    h.check.request("online");
    const first = h.advance(10_000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The connection dropped and came back while the old check waited.
    h.check.request("online");
    release?.({ kind: "unsupported" });
    await first;
    await h.advance(LINKED_ACCESS_CHECK_MIN_INTERVAL_MS + 10_000);
    expect(calls).toBe(2);
    expect(h.revoked).toEqual([{ fingerprint: fingerprint("a") }]);

    // The Hub still counts as having the route: a closed channel asks again.
    h.check.request("channel-closed");
    await h.advance(LINKED_ACCESS_CHECK_MIN_INTERVAL_MS);
    expect(calls).toBe(3);
  });

  it("asks once per device and account, at its highest linked role, codes included", () => {
    const link = (overrides: {
      readonly clientFingerprint: string;
      readonly role: RelayEffectiveRole;
      readonly accountId?: string;
      readonly trustSource?: LinkedAccessDevice["trustSource"];
    }) => ({
      trustSource: overrides.trustSource ?? ("account-enrolled" as const),
      enrollmentId: `enr_${"a".repeat(22)}`,
      clientFingerprint: overrides.clientFingerprint,
      role: overrides.role,
      ...(overrides.accountId === undefined ? {} : { accountId: overrides.accountId }),
    });
    expect(
      linkedAccessDevices([
        // A session at viewer and a newer, unredeemed code at operator: one device.
        link({ clientFingerprint: fingerprint("a"), accountId: "acct_1", role: "viewer" }),
        link({ clientFingerprint: fingerprint("a"), accountId: "acct_1", role: "operator" }),
        // The same key under another account, before accounts were kept, or verified locally.
        link({ clientFingerprint: fingerprint("a"), accountId: "acct_2", role: "owner" }),
        link({ clientFingerprint: fingerprint("a"), role: "viewer" }),
        link({
          clientFingerprint: fingerprint("a"),
          role: "owner",
          trustSource: "locally-verified",
        }),
      ]),
    ).toEqual([
      device({ clientFingerprint: fingerprint("a"), accountId: "acct_1", role: "operator" }),
      device({ clientFingerprint: fingerprint("a"), accountId: "acct_2", role: "owner" }),
      device({ clientFingerprint: fingerprint("a"), accountId: null, role: "viewer" }),
      device({
        clientFingerprint: fingerprint("a"),
        accountId: null,
        role: "owner",
        trustSource: "locally-verified",
      }),
    ]);
  });

  it("asks in batches of 64 devices", async () => {
    const devices = Array.from({ length: 65 }, (_, index) =>
      device({
        clientFingerprint: `${String(index).padStart(2, "0")}${"f".repeat(41)}`,
      }),
    );
    const h = harness({
      devices: () => devices,
      answer: (subjects) => ({
        kind: "answered",
        results: subjects.map(() => ({ status: "active", role: "owner" }) as const),
      }),
    });

    h.check.request("online");
    await h.advance(10_000);

    expect(h.asked.map((subjects) => subjects.length)).toEqual([64, 1]);
  });
});

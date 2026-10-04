import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  E2EE_APPROVED_CLIENTS_MAX,
  E2EE_KEY_FINGERPRINT_BYTES,
  E2EE_PAIRING_RESERVATION_LIFETIME,
  E2EE_PAIRING_WINDOW,
  E2EE_PENDING_CLIENT_RETENTION,
  E2EE_PENDING_CLIENTS_MAX_GLOBAL,
  E2EE_PENDING_CLIENTS_MAX_PER_ACCOUNT,
  E2EE_REVOKED_CLIENTS_RETAINED_MAX,
} from "@ryco/shared/relayE2eeConstants";
import {
  type E2eeAdmittedAuthoritySnapshot,
  type E2eeClientAuthorizationKey,
  type E2eeModeTransition,
  type E2eeNodeHandshake,
  type E2eeNodeHandshakeOptions,
  e2eeAuthorizationWithdrawn,
} from "@ryco/shared/relayE2eeHandshake";
import { describe, expect, it } from "vite-plus/test";

import {
  makeNodeClientAuthorizationClient,
  type NodeClientAuthorizationClient,
} from "./NodeClientAuthorizationClient.ts";
import {
  makeNodeClientAuthorizationStore,
  type NodeClientAuthorizationRecordFile,
  type NodeClientAuthorizationStore,
  NodeClientAuthorizationStoreError,
  type StoredClientAuthorizationEntry,
} from "./NodeClientAuthorizationStore.ts";

const HUB_ORIGIN = "https://relay.example";
const OTHER_HUB_ORIGIN = "https://other-relay.example";
const ACCOUNT_ID = "acct_0123456789";
const CAPABILITY = "ryco.rpc";
const SAFETY_NUMBER = Array.from({ length: 12 }, (_, index) => String(index % 10).repeat(5)).join(
  " ",
);
const START = 1_700_000_000_000;
/** The `channel.open` role a pairing attempt arrives under, unless a test names another. */
const OBSERVED_ROLE = "owner";

function fingerprintBytes(seed: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, offset) =>
    offset === 0 ? seed % 256 : offset === 1 ? (seed >> 8) % 256 : 0,
  );
}

function fingerprint(seed: number): string {
  return Buffer.from(fingerprintBytes(seed)).toString("base64url");
}

function key(seed: number, accountId: string = ACCOUNT_ID): E2eeClientAuthorizationKey {
  return { hubOrigin: HUB_ORIGIN, accountId, clientIdentityFingerprint: fingerprintBytes(seed) };
}

function pendingEntry(
  seed: number,
  overrides: Partial<StoredClientAuthorizationEntry> = {},
): StoredClientAuthorizationEntry {
  return {
    hubOrigin: HUB_ORIGIN,
    accountId: ACCOUNT_ID,
    clientIdentityFingerprint: fingerprint(seed),
    maxRole: "viewer",
    capabilitySet: [],
    createdAt: START,
    safetyNumber: SAFETY_NUMBER,
    ...overrides,
  };
}

interface Harness {
  readonly path: string;
  readonly store: NodeClientAuthorizationStore;
  readonly client: NodeClientAuthorizationClient;
  readonly at: (value: number) => void;
  readonly advance: (delta: number) => void;
  readonly stored: () => Promise<NodeClientAuthorizationRecordFile>;
  readonly pair: (
    input: E2eeClientAuthorizationKey,
    observedRole?: string,
  ) => Promise<ReturnType<NodeClientAuthorizationClient["evaluatePairingAdmission"]>>;
}

async function harness(seed?: Partial<NodeClientAuthorizationRecordFile>): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "ryco-client-authz-"));
  const path = join(root, "hub-e2ee-clients.json");
  if (seed !== undefined) {
    await writeFile(
      path,
      `${JSON.stringify({
        version: 1,
        revision: 1,
        pending: [],
        approved: [],
        revoked: [],
        pairingWindow: null,
        ...seed,
      })}\n`,
      { mode: 0o600 },
    );
  }
  let clock = START;
  const store = await makeNodeClientAuthorizationStore({ path });
  const client = await makeNodeClientAuthorizationClient({ store, now: () => clock });
  return {
    path,
    store,
    client,
    at: (value) => {
      clock = value;
    },
    advance: (delta) => {
      clock += delta;
    },
    stored: async () =>
      JSON.parse(await readFile(path, "utf8")) as NodeClientAuthorizationRecordFile,
    pair: async (input, observedRole = OBSERVED_ROLE) => {
      const decision = client.evaluatePairingAdmission({
        hubOrigin: input.hubOrigin,
        accountId: input.accountId,
        clientIdentityFingerprint: input.clientIdentityFingerprint,
        safetyNumber: SAFETY_NUMBER,
        observedRole,
      });
      await client.commitPairingAdmission(decision);
      return decision;
    },
  };
}

function snapshotOf(
  input: E2eeClientAuthorizationKey,
  authority: { maxRole: string; capabilitySet: readonly string[] },
): E2eeAdmittedAuthoritySnapshot {
  return {
    hubOrigin: input.hubOrigin,
    accountId: input.accountId,
    clientIdentityFingerprint: input.clientIdentityFingerprint,
    status: "approved",
    maxRole: authority.maxRole,
    capabilitySet: authority.capabilitySet,
  };
}

describe("node client authorization caps and partitions", () => {
  it("refuses past the per-account cap without evicting, and other partitions still admit", async () => {
    const test = await harness();
    for (let index = 0; index < E2EE_PENDING_CLIENTS_MAX_PER_ACCOUNT; index += 1) {
      expect((await test.pair(key(index))).kind).toBe("admit");
      test.advance(1);
    }
    const refused = await test.pair(key(900));
    expect(refused).toMatchObject({ kind: "refused", reason: "pending_cap_per_account" });

    // Refused means refused: nothing created, nothing evicted, nothing refreshed.
    const stored = await test.stored();
    expect(stored.pending).toHaveLength(E2EE_PENDING_CLIENTS_MAX_PER_ACCOUNT);

    // The partition bounds growth per namespace; it is not a global limit.
    expect((await test.pair(key(901, "acct_other"))).kind).toBe("admit");
    expect((await test.stored()).pending).toHaveLength(E2EE_PENDING_CLIENTS_MAX_PER_ACCOUNT + 1);
  });

  it("refuses past the global cap", async () => {
    const pending = Array.from({ length: E2EE_PENDING_CLIENTS_MAX_GLOBAL }, (_, index) =>
      pendingEntry(index, {
        accountId: `acct_${Math.floor(index / E2EE_PENDING_CLIENTS_MAX_PER_ACCOUNT)}`,
        createdAt: START + index,
      }),
    );
    const test = await harness({ pending });
    expect(await test.pair(key(900, "acct_fresh"))).toMatchObject({
      kind: "refused",
      reason: "pending_cap_global",
    });
    expect((await test.stored()).pending).toHaveLength(E2EE_PENDING_CLIENTS_MAX_GLOBAL);
  });

  it("never lets an unapproved flood evict approved or revoked state", async () => {
    const approved = pendingEntry(700, {
      accountId: "acct_owner",
      maxRole: "owner",
      capabilitySet: [CAPABILITY],
      approvedAt: START,
    });
    const revoked = pendingEntry(701, { accountId: "acct_owner", revokedAt: START });
    const pending = Array.from({ length: E2EE_PENDING_CLIENTS_MAX_GLOBAL }, (_, index) =>
      pendingEntry(index, {
        accountId: `acct_${Math.floor(index / E2EE_PENDING_CLIENTS_MAX_PER_ACCOUNT)}`,
        createdAt: START + index,
      }),
    );
    const test = await harness({ approved: [approved], revoked: [revoked], pending });

    for (let attempt = 0; attempt < 200; attempt += 1) {
      const decision = await test.pair(key(2_000 + attempt, `acct_flood_${attempt % 5}`));
      expect(decision.kind).toBe("refused");
      test.advance(10);
    }

    const stored = await test.stored();
    expect(stored.approved).toEqual([approved]);
    expect(stored.revoked).toEqual([revoked]);
    expect(stored.pending.map((entry) => entry.clientIdentityFingerprint).toSorted()).toEqual(
      pending.map((entry) => entry.clientIdentityFingerprint).toSorted(),
    );
    const listing = await test.client.list();
    expect(listing.pendingGlobalSaturated).toBe(true);
    expect(listing.refusedPairingAttempts).toBe(200);
    test.client.clearRefusedPairingAttempts();
    expect((await test.client.list()).refusedPairingAttempts).toBe(0);
  });

  it("expires pending records at the retention bound and frees their slots", async () => {
    const test = await harness();
    expect((await test.pair(key(1))).kind).toBe("admit");
    expect(await test.client.get(key(1))).toMatchObject({ status: "pending" });

    test.advance(E2EE_PENDING_CLIENT_RETENTION + 1);
    expect(await test.client.get(key(1))).toBeUndefined();
    expect((await test.client.list()).records).toEqual([]);

    // The same key pairs again rather than being told a record already exists.
    expect((await test.pair(key(1))).kind).toBe("admit");
    const stored = await test.stored();
    expect(stored.pending).toHaveLength(1);
    expect(stored.pending[0]?.createdAt).toBeGreaterThan(START);
  });

  it("purges expired pending records on demand", async () => {
    const pending = Array.from({ length: 3 }, (_, index) =>
      pendingEntry(index, { createdAt: START + index }),
    );
    const test = await harness({ pending });
    test.advance(E2EE_PENDING_CLIENT_RETENTION + 3);
    expect(await test.client.sweepExpired()).toBe(3);
    expect((await test.stored()).pending).toEqual([]);
  });

  it("fails an approval past the approved cap instead of evicting anything", async () => {
    const approved = Array.from({ length: E2EE_APPROVED_CLIENTS_MAX }, (_, index) =>
      pendingEntry(index, {
        accountId: `acct_${index}`,
        maxRole: "viewer",
        capabilitySet: [CAPABILITY],
        approvedAt: START,
      }),
    );
    const test = await harness({ approved, pending: [pendingEntry(9_000)] });
    await expect(
      test.client.approve({ key: key(9_000), maxRole: "viewer", capabilitySet: [CAPABILITY] }),
    ).rejects.toMatchObject({ code: "client_authorization_approved_cap" });
    const stored = await test.stored();
    expect(stored.approved).toHaveLength(E2EE_APPROVED_CLIENTS_MAX);
    expect(stored.pending).toHaveLength(1);
  });

  it("evicts only the oldest revoked records past the revoked cap", async () => {
    const revoked = Array.from({ length: E2EE_REVOKED_CLIENTS_RETAINED_MAX }, (_, index) =>
      pendingEntry(index, { accountId: `acct_${index}`, revokedAt: START + index }),
    );
    const oldest = revoked[0]!;
    const test = await harness({
      revoked,
      approved: [
        pendingEntry(9_000, { maxRole: "owner", capabilitySet: [CAPABILITY], approvedAt: START }),
      ],
    });
    test.at(START + 10_000);
    await test.client.revoke(key(9_000));
    const stored = await test.stored();
    expect(stored.revoked).toHaveLength(E2EE_REVOKED_CLIENTS_RETAINED_MAX);
    expect(
      stored.revoked.some(
        (entry) => entry.clientIdentityFingerprint === oldest.clientIdentityFingerprint,
      ),
    ).toBe(false);
    expect(
      stored.revoked.some((entry) => entry.clientIdentityFingerprint === fingerprint(9_000)),
    ).toBe(true);
  });

  it("coalesces last-seen writes to one per interval", async () => {
    const test = await harness({
      approved: [
        pendingEntry(1, { maxRole: "owner", capabilitySet: [CAPABILITY], approvedAt: START }),
      ],
    });
    expect(await test.client.touch(key(1))).toBe(true);
    expect(await test.client.touch(key(1))).toBe(false);
    test.advance(3_600 * 1_000);
    expect(await test.client.touch(key(1))).toBe(true);
    expect(await test.client.touch(key(2))).toBe(false);
  });
});

describe("node client authorization observed role", () => {
  // §8.3 makes a native client's intended role equal the `channel.open` role,
  // and §8.6 step 6 then requires it to fit under `maxRole` — so an approval
  // below the role the Hub assigned refuses the device rather than limiting it.
  // The owner can only name the usable ceiling if the node kept the role it saw.

  it("stores the role a first-seen key arrived under, and never as authority", async () => {
    const test = await harness();
    expect((await test.pair(key(30), "operator")).kind).toBe("admit");

    const [record] = (await test.client.list()).records;
    expect(record).toMatchObject({
      status: "pending",
      maxRole: "viewer",
      observedRole: "operator",
    });
    expect((await test.stored()).pending[0]?.observedRole).toBe("operator");
    // A pending record still grants nothing, whatever role it carries.
    expect(test.client.lookupClientAuthorization(key(30))).toMatchObject({
      status: "pending",
      maxRole: "viewer",
      capabilitySet: [],
    });
  });

  it("follows the device while the record is pending, and writes only when it moved", async () => {
    // A request recorded before this field existed carries none; the device's
    // next attempt fills it in, so the owner is not stuck approving blind.
    const test = await harness({ pending: [pendingEntry(31)] });
    expect((await test.client.list()).records[0]?.observedRole).toBeUndefined();

    expect(await test.pair(key(31), "owner")).toMatchObject({
      kind: "existing",
      status: "pending",
      observedRoleRefresh: { observedRole: "owner" },
    });
    expect((await test.client.list()).records[0]?.observedRole).toBe("owner");

    // The same role again owes nothing, so the attempt writes nothing.
    const revision = (await test.stored()).revision;
    expect(await test.pair(key(31), "owner")).toMatchObject({
      kind: "existing",
      observedRoleRefresh: undefined,
    });
    expect((await test.stored()).revision).toBe(revision);

    // …and a role the Hub changed since is followed, still pending.
    await test.pair(key(31), "viewer");
    const stored = await test.stored();
    expect(stored.pending[0]).toMatchObject({ observedRole: "viewer", maxRole: "viewer" });
    expect(stored.approved).toEqual([]);
  });

  it("never rewrites an approved or revoked record from a peer's hello", async () => {
    const test = await harness();
    await test.pair(key(32), "owner");
    await test.client.approve({ key: key(32), maxRole: "owner", capabilitySet: [CAPABILITY] });
    await test.pair(key(33), "owner");
    await test.client.revoke(key(33));
    const before = await test.stored();

    for (const seed of [32, 33]) {
      expect(await test.pair(key(seed), "viewer")).toMatchObject({
        kind: "existing",
        observedRoleRefresh: undefined,
      });
    }
    expect(await test.stored()).toEqual(before);
  });

  it("drops a refresh decided while pending once the owner approved or revoked the record", async () => {
    // The decision is taken before the reject and committed after the close,
    // so the owner can act in between. The commit must find only the pending
    // class: a hello may never rewrite what an owner action just settled.
    const test = await harness();
    await test.pair(key(36), "owner");
    await test.pair(key(37), "owner");
    const decide = (seed: number) =>
      test.client.evaluatePairingAdmission({
        hubOrigin: HUB_ORIGIN,
        accountId: ACCOUNT_ID,
        clientIdentityFingerprint: fingerprintBytes(seed),
        safetyNumber: SAFETY_NUMBER,
        observedRole: "viewer",
      });
    const toApproved = decide(36);
    const toRevoked = decide(37);
    for (const decision of [toApproved, toRevoked]) {
      expect(decision).toMatchObject({
        kind: "existing",
        status: "pending",
        observedRoleRefresh: { observedRole: "viewer" },
      });
    }

    await test.client.approve({ key: key(36), maxRole: "owner", capabilitySet: [CAPABILITY] });
    await test.client.revoke(key(37));
    const before = await test.stored();

    await test.client.commitPairingAdmission(toApproved);
    await test.client.commitPairingAdmission(toRevoked);
    expect(await test.stored()).toEqual(before);
    expect(await test.client.get(key(36))).toMatchObject({
      status: "approved",
      observedRole: "owner",
    });
    expect(await test.client.get(key(37))).toMatchObject({
      status: "revoked",
      observedRole: "owner",
    });
  });

  it("is carried through approve, relabel and revoke", async () => {
    const test = await harness();
    await test.pair(key(34), "owner");
    await test.client.approve({ key: key(34), maxRole: "owner", capabilitySet: [CAPABILITY] });
    expect((await test.client.get(key(34)))?.observedRole).toBe("owner");
    await test.client.setDisplayLabel({ key: key(34), displayLabel: "Phone" });
    expect((await test.client.get(key(34)))?.observedRole).toBe("owner");
    await test.client.revoke(key(34));
    expect(await test.client.get(key(34))).toMatchObject({
      status: "revoked",
      observedRole: "owner",
    });
  });

  it("records the request without a role it cannot rank, rather than dropping it", async () => {
    // §13.2 step 3 must not lose the pending record over display metadata.
    const test = await harness();
    expect((await test.pair(key(35), "superuser")).kind).toBe("admit");
    const [record] = (await test.client.list()).records;
    expect(record?.status).toBe("pending");
    expect(record?.observedRole).toBeUndefined();
  });
});

describe("node client authorization Local Trusted Introduction", () => {
  const introduce = (client: NodeClientAuthorizationClient, seed: number, overrides = {}) =>
    client.introduce({
      key: key(seed),
      maxRole: "owner",
      capabilitySet: [CAPABILITY],
      safetyNumber: SAFETY_NUMBER,
      displayLabel: "Desktop",
      ...overrides,
    });

  it("creates the ordinary approved Branch A record directly", async () => {
    const test = await harness();
    const result = await introduce(test.client, 40);
    expect(result).toMatchObject({
      disposition: "created",
      record: {
        status: "approved",
        maxRole: "owner",
        capabilitySet: [CAPABILITY],
        safetyNumber: SAFETY_NUMBER,
        displayLabel: "Desktop",
        approvedAt: START,
      },
    });
    expect(test.client.lookupClientAuthorization(key(40))).toEqual({
      status: "approved",
      maxRole: "owner",
      capabilitySet: [CAPABILITY],
    });
    const stored = await test.stored();
    expect(stored.pending).toEqual([]);
    expect(stored.approved).toHaveLength(1);
  });

  it("promotes an exact pending record and preserves its creation time", async () => {
    const test = await harness();
    await test.pair(key(41));
    test.advance(500);
    const result = await introduce(test.client, 41);
    expect(result.disposition).toBe("promoted");
    expect(result.record).toMatchObject({
      status: "approved",
      createdAt: START,
      approvedAt: START + 500,
    });
    expect((await test.stored()).pending).toEqual([]);
  });

  it("reconciles only an exactly equal approval and preserves its approval time", async () => {
    const test = await harness();
    const first = await introduce(test.client, 42);
    test.advance(10_000);
    const second = await introduce(test.client, 42);
    expect(second.disposition).toBe("reconciled");
    expect(second.record.approvedAt).toBe(first.record.approvedAt);
    expect((await test.stored()).approved).toHaveLength(1);

    await expect(introduce(test.client, 42, { maxRole: "operator" })).rejects.toMatchObject({
      code: "client_authorization_conflict",
    });
    await expect(introduce(test.client, 42, { capabilitySet: [] })).rejects.toMatchObject({
      code: "client_authorization_conflict",
    });
    await expect(
      introduce(test.client, 42, { safetyNumber: SAFETY_NUMBER.replace(/^0/, "9") }),
    ).rejects.toMatchObject({ code: "client_authorization_conflict" });
    await expect(
      introduce(test.client, 42, { displayLabel: "Another Desktop" }),
    ).rejects.toMatchObject({ code: "client_authorization_conflict" });
  });

  it("never resurrects a revoked client", async () => {
    const test = await harness();
    await introduce(test.client, 43);
    await test.client.revoke(key(43));
    await expect(introduce(test.client, 43)).rejects.toMatchObject({
      code: "client_authorization_conflict",
    });
    expect(await test.client.get(key(43))).toMatchObject({ status: "revoked" });
  });

  it("honors the same approved-record cap and validates local inputs", async () => {
    const approved = Array.from({ length: E2EE_APPROVED_CLIENTS_MAX }, (_, index) =>
      pendingEntry(index, {
        maxRole: "owner",
        capabilitySet: [CAPABILITY],
        approvedAt: START,
      }),
    );
    const full = await harness({ approved });
    await expect(introduce(full.client, 9_999)).rejects.toMatchObject({
      code: "client_authorization_approved_cap",
    });
    expect((await full.stored()).approved).toEqual(approved);

    const test = await harness();
    await expect(introduce(test.client, 44, { safetyNumber: "12345" })).rejects.toMatchObject({
      code: "client_authorization_invalid",
    });
    await expect(introduce(test.client, 44, { displayLabel: " padded" })).rejects.toMatchObject({
      code: "client_authorization_invalid",
    });
  });
});

describe("node client authorization pairing window", () => {
  const saturatedPartition = () =>
    Array.from({ length: E2EE_PENDING_CLIENTS_MAX_PER_ACCOUNT }, (_, index) =>
      pendingEntry(index, { createdAt: START + index }),
    );

  it("grants the reservation only to the attempt matching the owner's discriminator", async () => {
    const test = await harness({ pending: saturatedPartition() });
    const opened = await test.client.openPairingWindow(fingerprintBytes(900));
    expect(opened.spent).toBe(false);

    // A fabricated identity, however precisely timed against the window.
    expect(await test.pair(key(901))).toMatchObject({
      kind: "refused",
      reason: "pending_cap_per_account",
    });
    expect((await test.client.list()).pairingWindow).toMatchObject({ spent: false });
    expect((await test.stored()).pending).toHaveLength(E2EE_PENDING_CLIENTS_MAX_PER_ACCOUNT);

    const admitted = await test.pair(key(900));
    expect(admitted.kind).toBe("admit");
    const stored = await test.stored();
    expect(stored.pending).toHaveLength(E2EE_PENDING_CLIENTS_MAX_PER_ACCOUNT);
    // The oldest eligible record in the partition, and nothing else.
    expect(stored.pending.some((entry) => entry.clientIdentityFingerprint === fingerprint(0))).toBe(
      false,
    );
    const created = stored.pending.find(
      (entry) => entry.clientIdentityFingerprint === fingerprint(900),
    );
    expect(created?.pairingReservedAt).toBe(START);
  });

  it("admits at most one record per window", async () => {
    const test = await harness({ pending: saturatedPartition() });
    await test.client.openPairingWindow(fingerprintBytes(900));
    expect((await test.pair(key(900))).kind).toBe("admit");
    expect((await test.client.list()).pairingWindow).toMatchObject({ spent: true });

    // The same owner-named key under a second account is a second record, and
    // the window's single reservation is already spent.
    const other = { ...key(900), accountId: "acct_second" };
    const pending = Array.from({ length: E2EE_PENDING_CLIENTS_MAX_PER_ACCOUNT }, (_, index) =>
      pendingEntry(index + 100, { accountId: "acct_second", createdAt: START + index }),
    );
    await test.store.update((current) => ({
      ...current,
      revision: current.revision + 1,
      pending: [...current.pending, ...pending],
    }));
    await test.client.reload();
    expect(await test.pair(other)).toMatchObject({
      kind: "refused",
      reason: "pending_cap_per_account",
    });
  });

  it("scopes the eviction to the partition whose cap was exceeded", async () => {
    // Global cap reached, with the attempt's own partition also full: §13.6
    // makes the per-account partition govern, because a victim outside it would
    // relieve only the global cap.
    const pending = Array.from({ length: E2EE_PENDING_CLIENTS_MAX_GLOBAL }, (_, index) =>
      pendingEntry(index, {
        accountId: `acct_${Math.floor(index / E2EE_PENDING_CLIENTS_MAX_PER_ACCOUNT)}`,
        createdAt: START + index,
      }),
    );
    const test = await harness({ pending });
    await test.client.openPairingWindow(fingerprintBytes(900));
    const attempt = { ...key(900), accountId: "acct_3" };
    expect((await test.pair(attempt)).kind).toBe("admit");

    const stored = await test.stored();
    expect(stored.pending).toHaveLength(E2EE_PENDING_CLIENTS_MAX_GLOBAL);
    // The oldest record of acct_3, not the oldest record anywhere.
    const victim = pending.find((entry) => entry.accountId === "acct_3")!;
    expect(
      stored.pending.some(
        (entry) => entry.clientIdentityFingerprint === victim.clientIdentityFingerprint,
      ),
    ).toBe(false);
    expect(
      stored.pending.some(
        (entry) => entry.clientIdentityFingerprint === pending[0]!.clientIdentityFingerprint,
      ),
    ).toBe(true);
  });

  it("evicts the oldest eligible record anywhere when only the global cap is exceeded", async () => {
    const pending = Array.from({ length: E2EE_PENDING_CLIENTS_MAX_GLOBAL }, (_, index) =>
      pendingEntry(index, {
        accountId: `acct_${Math.floor(index / E2EE_PENDING_CLIENTS_MAX_PER_ACCOUNT)}`,
        createdAt: START + index,
      }),
    );
    const test = await harness({ pending });
    await test.client.openPairingWindow(fingerprintBytes(900));
    // A partition with room of its own, so only the global cap is exceeded.
    expect((await test.pair({ ...key(900), accountId: "acct_fresh" })).kind).toBe("admit");
    const stored = await test.stored();
    expect(
      stored.pending.some(
        (entry) => entry.clientIdentityFingerprint === pending[0]!.clientIdentityFingerprint,
      ),
    ).toBe(false);
  });

  it("never evicts a record that still holds a reservation, and releases it at the lifetime", async () => {
    const pending = saturatedPartition();
    pending[0] = { ...pending[0]!, pairingReservedAt: START };
    const test = await harness({ pending });
    await test.client.openPairingWindow(fingerprintBytes(900));
    expect((await test.pair(key(900))).kind).toBe("admit");
    // The reserved record survives; the next-oldest eligible one is taken.
    const stored = await test.stored();
    expect(stored.pending.some((entry) => entry.clientIdentityFingerprint === fingerprint(0))).toBe(
      true,
    );
    expect(stored.pending.some((entry) => entry.clientIdentityFingerprint === fingerprint(1))).toBe(
      false,
    );

    // Past `E2EE_PAIRING_RESERVATION_LIFETIME` the reservation is spent and the
    // record is eligible again — which is what stops the reserved class from
    // filling up with records the owner never approved.
    test.advance(E2EE_PAIRING_RESERVATION_LIFETIME + 1);
    await test.client.openPairingWindow(fingerprintBytes(902));
    expect((await test.pair(key(902))).kind).toBe("admit");
    expect(
      (await test.stored()).pending.some(
        (entry) => entry.clientIdentityFingerprint === fingerprint(0),
      ),
    ).toBe(false);
  });

  it("refuses rather than evicting when every pending record still holds a reservation", async () => {
    const pending = Array.from({ length: E2EE_PENDING_CLIENTS_MAX_PER_ACCOUNT }, (_, index) =>
      pendingEntry(index, { createdAt: START + index, pairingReservedAt: START }),
    );
    const test = await harness({ pending });
    await test.client.openPairingWindow(fingerprintBytes(900));
    expect(await test.pair(key(900))).toMatchObject({
      kind: "refused",
      reason: "pending_cap_per_account",
    });
    expect((await test.stored()).pending).toHaveLength(E2EE_PENDING_CLIENTS_MAX_PER_ACCOUNT);
  });

  it("survives a sustained flood and still pairs the owner's device", async () => {
    // The self-poisoning case an earlier draft of §13.6 had: a flood that could
    // spend the window, or convert every slot into an un-evictable one, would
    // disable the owner's escape hatch permanently.
    const test = await harness({ pending: saturatedPartition() });
    await test.client.openPairingWindow(fingerprintBytes(900));
    for (let attempt = 0; attempt < 500; attempt += 1) {
      expect((await test.pair(key(1_000 + attempt))).kind).toBe("refused");
      test.advance(1);
    }
    expect((await test.client.list()).pairingWindow).toMatchObject({ spent: false });
    const stored = await test.stored();
    expect(stored.pending).toHaveLength(E2EE_PENDING_CLIENTS_MAX_PER_ACCOUNT);
    expect(stored.pending.every((entry) => entry.pairingReservedAt === undefined)).toBe(true);

    expect((await test.pair(key(900))).kind).toBe("admit");
    expect(
      (await test.stored()).pending.some(
        (entry) => entry.clientIdentityFingerprint === fingerprint(900),
      ),
    ).toBe(true);
  });

  it("closes the window at E2EE_PAIRING_WINDOW", async () => {
    const test = await harness({ pending: saturatedPartition() });
    await test.client.openPairingWindow(fingerprintBytes(900));
    test.advance(E2EE_PAIRING_WINDOW + 1);
    expect((await test.client.list()).pairingWindow).toBeUndefined();
    expect(await test.pair(key(900))).toMatchObject({ kind: "refused" });
  });

  it("spends the window on the owner's own device even when its record exists", async () => {
    // §13.6 spends the reservation on "the first attempt that matches the
    // discriminator, whatever that attempt's outcome". The owner's device
    // reaching a node that already holds its pending record is such an attempt.
    // Deciding the outcome before matching the discriminator leaves the window
    // open after the device it names has arrived, and the CLI then shows the
    // owner a window still waiting for a device that is already on file.
    const test = await harness();
    expect((await test.pair(key(900))).kind).toBe("admit");
    await test.client.openPairingWindow(fingerprintBytes(900));
    expect((await test.client.list()).pairingWindow).toMatchObject({ spent: false });

    expect(await test.pair(key(900))).toMatchObject({ kind: "existing", status: "pending" });
    expect((await test.client.list()).pairingWindow).toMatchObject({ spent: true });
    // Durably spent, so a restart does not hand the reservation out again.
    expect((await test.stored()).pairingWindow?.spentAt).toBe(START);
  });

  it("does not spend the window on an attempt that does not match it", async () => {
    const test = await harness();
    expect((await test.pair(key(901))).kind).toBe("admit");
    await test.client.openPairingWindow(fingerprintBytes(900));
    expect(await test.pair(key(901))).toMatchObject({ kind: "existing" });
    expect((await test.client.list()).pairingWindow).toMatchObject({ spent: false });
    expect((await test.stored()).pairingWindow?.spentAt).toBeUndefined();
  });

  it("never spends a window the decision did not match, however the gap is filled", async () => {
    // §13.2 step 3 defers the durable spend past the reject and the close, and
    // the owner can open a NEW window in that gap — the two halves of the
    // decision are therefore separated here exactly as the relay path separates
    // them, rather than through `pair`.
    const test = await harness();
    await test.client.openPairingWindow(fingerprintBytes(900));
    const decision = test.client.evaluatePairingAdmission({
      hubOrigin: HUB_ORIGIN,
      accountId: ACCOUNT_ID,
      clientIdentityFingerprint: fingerprintBytes(900),
      safetyNumber: SAFETY_NUMBER,
      observedRole: OBSERVED_ROLE,
    });
    expect(decision.kind).toBe("admit");

    // The owner names a SECOND device before the commit lands.
    await test.client.openPairingWindow(fingerprintBytes(901));
    await test.client.commitPairingAdmission(decision);

    // §13.6's `spent` is "some other attempt consumed the window — impossible
    // without the owner's own client key". An attempt that never named device
    // 901 may not raise it, durably or in the listing.
    const stored = await test.stored();
    expect(stored.pairingWindow?.clientIdentityFingerprint).toBe(fingerprint(901));
    expect(stored.pairingWindow?.spentAt).toBeUndefined();
    expect((await test.client.list()).pairingWindow).toMatchObject({ spent: false });
    // And the reservation — the owner's only way past a saturated pending cap —
    // is still there for the device they just named.
    expect(await test.pair(key(901))).toMatchObject({ kind: "admit" });
    expect((await test.stored()).pairingWindow?.spentAt).toBe(START);
  });

  it("still spends the matched window when the gap changed nothing", async () => {
    // The other side of the identity check: a commit that lands with the SAME
    // window still open owes the durable spend, so the check above cannot be
    // satisfied by never spending anything.
    const test = await harness();
    await test.client.openPairingWindow(fingerprintBytes(900));
    const decision = test.client.evaluatePairingAdmission({
      hubOrigin: HUB_ORIGIN,
      accountId: ACCOUNT_ID,
      clientIdentityFingerprint: fingerprintBytes(900),
      safetyNumber: SAFETY_NUMBER,
      observedRole: OBSERVED_ROLE,
    });
    await test.client.commitPairingAdmission(decision);
    expect((await test.stored()).pairingWindow?.spentAt).toBe(START);
  });

  it("matches the discriminator on the whole digest and never a prefix of it", async () => {
    // §11.2 names key and fingerprint equality (§7.1) among the comparisons that
    // MUST be constant-time, and §13.2 step 3 now reaches this one from an
    // unauthenticated peer's hello. Whatever primitive carries it, the property
    // it has to keep is this: the digests differ only in their LAST byte, and
    // the owner's window is not spent on a device they never named.
    const test = await harness();
    const named = fingerprintBytes(900);
    const nearMiss = Uint8Array.from(named);
    nearMiss[E2EE_KEY_FINGERPRINT_BYTES - 1] = 1;
    await test.client.openPairingWindow(named);

    await test.client.commitPairingAdmission(
      test.client.evaluatePairingAdmission({
        hubOrigin: HUB_ORIGIN,
        accountId: ACCOUNT_ID,
        clientIdentityFingerprint: nearMiss,
        safetyNumber: SAFETY_NUMBER,
        observedRole: OBSERVED_ROLE,
      }),
    );
    expect((await test.client.list()).pairingWindow).toMatchObject({ spent: false });
    expect((await test.stored()).pairingWindow?.spentAt).toBeUndefined();
    // And the device the owner DID name still has its reservation.
    expect(await test.pair(key(900))).toMatchObject({ kind: "admit" });
    expect((await test.stored()).pairingWindow?.spentAt).toBe(START);
  });

  it("requires a fingerprint to open a window", async () => {
    const test = await harness();
    await expect(test.client.openPairingWindow(new Uint8Array(31))).rejects.toMatchObject({
      code: "client_authorization_invalid",
    });
  });
});

describe("node client authorization withdrawal", () => {
  interface Sweepable {
    readonly closed: string[];
    readonly statusesAtClose: (string | undefined)[];
  }

  async function approvedHarness(): Promise<{
    readonly test: Harness;
    readonly observed: Sweepable;
    readonly snapshot: E2eeAdmittedAuthoritySnapshot;
    readonly register: (name: string, snapshot: E2eeAdmittedAuthoritySnapshot) => void;
  }> {
    const test = await harness({
      approved: [
        pendingEntry(1, { maxRole: "owner", capabilitySet: [CAPABILITY], approvedAt: START }),
      ],
    });
    const observed: Sweepable = { closed: [], statusesAtClose: [] };
    const snapshot = snapshotOf(key(1), { maxRole: "owner", capabilitySet: [CAPABILITY] });
    const register = (name: string, forSnapshot: E2eeAdmittedAuthoritySnapshot): void => {
      const admission = test.client.admitActiveChannel({
        admittedAuthority: forSnapshot,
        close: () => {
          observed.closed.push(name);
          // §13.6 orders the commit BEFORE the sweep, so by the time a channel
          // is closed the narrowed record is already the one a fresh handshake
          // would read.
          observed.statusesAtClose.push(test.client.lookupClientAuthorization(forSnapshot)?.status);
        },
      });
      expect(admission.kind).toBe("entered");
    };
    return { test, observed, snapshot, register };
  }

  it("commits, then sweeps, then acknowledges — for a revocation", async () => {
    const { test, observed, snapshot, register } = await approvedHarness();
    register("channel", snapshot);
    const inFlight: string[] = [];
    test.client.registerInFlightHandshake({
      admittedAuthority: snapshot,
      abort: () => {
        inFlight.push("handshake");
      },
    });

    const result = await test.client.revoke(key(1));
    expect(result).toEqual({ closedChannels: 1, abortedHandshakes: 1 });
    expect(observed.closed).toEqual(["channel"]);
    expect(observed.statusesAtClose).toEqual(["revoked"]);
    expect(inFlight).toEqual(["handshake"]);
    expect((await test.stored()).revoked).toHaveLength(1);
  });

  it("treats a role reduction and a capability removal as withdrawals", async () => {
    for (const narrowing of [{ maxRole: "viewer" }, { capabilitySet: [] as readonly string[] }]) {
      const { test, observed, snapshot, register } = await approvedHarness();
      register("channel", snapshot);
      const result = await test.client.narrow({ key: key(1), ...narrowing });
      expect(result.closedChannels).toBe(1);
      expect(observed.closed).toEqual(["channel"]);
      // The record is still `approved`; a status-only re-check would have
      // passed a channel the owner just narrowed.
      expect(observed.statusesAtClose).toEqual(["approved"]);
    }
  });

  it("closes a channel admitted below a ceiling the owner has now lowered", async () => {
    // The snapshot, not the authority the channel is exercising: a channel
    // admitted at `viewer` under an `owner` ceiling closes when the ceiling
    // drops, which is the conservative direction §13.6 chooses on purpose.
    const { test, observed, snapshot, register } = await approvedHarness();
    register("channel", snapshot);
    expect((await test.client.narrow({ key: key(1), maxRole: "operator" })).closedChannels).toBe(1);
    expect(observed.closed).toEqual(["channel"]);
  });

  it("does not sweep a widening change", async () => {
    const test = await harness({
      approved: [pendingEntry(1, { maxRole: "viewer", capabilitySet: [], approvedAt: START })],
    });
    const closed: string[] = [];
    const admission = test.client.admitActiveChannel({
      admittedAuthority: snapshotOf(key(1), { maxRole: "viewer", capabilitySet: [] }),
      close: () => {
        closed.push("channel");
      },
    });
    expect(admission.kind).toBe("entered");
    const result = await test.client.approve({
      key: key(1),
      maxRole: "owner",
      capabilitySet: [CAPABILITY],
    });
    expect(result).toEqual({ closedChannels: 0, abortedHandshakes: 0 });
    expect(closed).toEqual([]);
  });

  it("compares the FULL record key, so another account's channels survive", async () => {
    const test = await harness({
      approved: [
        pendingEntry(1, { maxRole: "owner", capabilitySet: [CAPABILITY], approvedAt: START }),
        pendingEntry(1, {
          accountId: "acct_second",
          maxRole: "owner",
          capabilitySet: [CAPABILITY],
          approvedAt: START,
        }),
        {
          ...pendingEntry(1, {
            maxRole: "owner",
            capabilitySet: [CAPABILITY],
            approvedAt: START,
          }),
          hubOrigin: OTHER_HUB_ORIGIN,
        },
      ],
    });
    const closed: string[] = [];
    for (const [name, snapshot] of [
      ["same", snapshotOf(key(1), { maxRole: "owner", capabilitySet: [CAPABILITY] })],
      [
        "other-account",
        snapshotOf(key(1, "acct_second"), { maxRole: "owner", capabilitySet: [CAPABILITY] }),
      ],
      [
        "other-origin",
        snapshotOf(
          { ...key(1), hubOrigin: OTHER_HUB_ORIGIN },
          { maxRole: "owner", capabilitySet: [CAPABILITY] },
        ),
      ],
    ] as const) {
      const admission = test.client.admitActiveChannel({
        admittedAuthority: snapshot,
        close: () => {
          closed.push(name);
        },
      });
      expect(admission.kind).toBe("entered");
    }
    expect((await test.client.revoke(key(1))).closedChannels).toBe(1);
    expect(closed).toEqual(["same"]);
  });

  it("does not acknowledge before the sweep has completed", async () => {
    const { test, snapshot } = await approvedHarness();
    let acknowledged = false;
    let release!: () => void;
    let closing!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const closeStarted = new Promise<void>((resolve) => {
      closing = resolve;
    });
    test.client.admitActiveChannel({
      admittedAuthority: snapshot,
      close: () => {
        closing();
        return gate;
      },
    });
    const pending = test.client.revoke(key(1)).then((result) => {
      acknowledged = true;
      return result;
    });
    await closeStarted;
    // The close is in progress and the record is already committed; §13.6 says
    // the command MUST NOT complete until the sweep has.
    expect(test.client.lookupClientAuthorization(key(1))?.status).toBe("revoked");
    expect(acknowledged).toBe(false);
    release();
    expect(await pending).toEqual({ closedChannels: 1, abortedHandshakes: 0 });
    expect(acknowledged).toBe(true);
  });

  it("sweeps a purge, which §13.6 counts as status leaving approved", async () => {
    const { test, observed, snapshot, register } = await approvedHarness();
    register("channel", snapshot);
    expect((await test.client.purge(key(1))).closedChannels).toBe(1);
    expect(observed.closed).toEqual(["channel"]);
    expect(observed.statusesAtClose).toEqual([undefined]);
    expect(await test.client.get(key(1))).toBeUndefined();
  });

  it("refuses a channel at row N3 when the withdrawal already committed", async () => {
    const { test, snapshot } = await approvedHarness();
    await test.client.revoke(key(1));
    const admission = test.client.admitActiveChannel({
      admittedAuthority: snapshot,
      close: () => undefined,
    });
    expect(admission).toEqual({ kind: "refused", reason: "authorization_withdrawn" });
    // The refusal is exactly the row N3 transition the handshake expects.
    const transition: E2eeModeTransition =
      admission.kind === "refused"
        ? { kind: "refused", reason: admission.reason }
        : { kind: "entered" };
    expect(transition).toEqual({ kind: "refused", reason: "authorization_withdrawn" });
  });

  it("releases a channel registration so a later withdrawal counts nothing", async () => {
    const { test, snapshot } = await approvedHarness();
    const closed: string[] = [];
    const admission = test.client.admitActiveChannel({
      admittedAuthority: snapshot,
      close: () => {
        closed.push("channel");
      },
    });
    if (admission.kind === "entered") admission.release();
    expect((await test.client.revoke(key(1))).closedChannels).toBe(0);
    expect(closed).toEqual([]);
  });

  it("refuses a registration whose key it could never have stored", async () => {
    // The sweep is keyed on the full record key. A registration this node cannot
    // encode a key for is one no owner command can ever select, so admitting it
    // would put a channel on the list that is neither swept nor visibly
    // rejected. §8.6 step 5 validated all three fields before step 6 took the
    // snapshot, so reaching here with one is a local mistake and says so.
    const { test } = await approvedHarness();
    const unencodable: E2eeAdmittedAuthoritySnapshot = {
      ...snapshotOf(key(1), {
        maxRole: "owner",
        capabilitySet: [CAPABILITY],
      }),
      hubOrigin: "not-an-origin",
    };

    let fromInFlight: unknown;
    try {
      test.client.registerInFlightHandshake({
        admittedAuthority: unencodable,
        abort: () => undefined,
      });
    } catch (error: unknown) {
      fromInFlight = error;
    }
    expect(fromInFlight).toMatchObject({ code: "client_authorization_invalid" });

    let fromActive: unknown;
    try {
      test.client.admitActiveChannel({ admittedAuthority: unencodable, close: () => undefined });
    } catch (error: unknown) {
      fromActive = error;
    }
    expect(fromActive).toMatchObject({ code: "client_authorization_invalid" });

    // Nothing joined the sweep set, so a withdrawal on the real key is unaffected
    // and the refused pair left no residue behind it.
    expect(await test.client.revoke(key(1))).toEqual({
      closedChannels: 0,
      abortedHandshakes: 0,
    });
  });
});

describe("node client authorization withdrawal crash ordering", () => {
  const approvedSeed = {
    approved: [
      pendingEntry(1, { maxRole: "owner", capabilitySet: [CAPABILITY], approvedAt: START }),
    ],
  };
  const snapshot = snapshotOf(key(1), { maxRole: "owner", capabilitySet: [CAPABILITY] });

  it("crashing before the commit leaves the record intact and sweeps nothing", async () => {
    const test = await harness(approvedSeed);
    const closed: string[] = [];
    const failing: NodeClientAuthorizationStore = {
      read: test.store.read,
      reset: test.store.reset,
      update: () => Promise.reject(new Error("crash")),
    };
    const client = await makeNodeClientAuthorizationClient({ store: failing, now: () => START });
    client.admitActiveChannel({
      admittedAuthority: snapshot,
      close: () => {
        closed.push("channel");
      },
    });
    await expect(client.revoke(key(1))).rejects.toThrow("crash");
    expect(closed).toEqual([]);
    expect((await test.stored()).approved).toHaveLength(1);
  });

  it("crashing between the commit and the sweep leaves the commit standing and the retry sweeps", async () => {
    const test = await harness(approvedSeed);
    const closed: string[] = [];
    let failNext = true;
    test.client.admitActiveChannel({
      admittedAuthority: snapshot,
      close: () => {
        closed.push(failNext ? "first" : "second");
        if (failNext) {
          failNext = false;
          throw new Error("close failed");
        }
      },
    });
    await expect(test.client.revoke(key(1))).rejects.toMatchObject({
      code: "client_authorization_sweep_failed",
    });
    expect(closed).toEqual(["first"]);
    // The commit stands: this is exactly the state a crash after (a) would
    // leave, and it is the safe one — a handshake reaching §8.6 step 6 now
    // reads `revoked`.
    expect((await test.stored()).revoked).toHaveLength(1);
    expect((await test.stored()).approved).toEqual([]);

    // A channel the sweep could not close stays registered, so the owner's
    // retry finds it and the acknowledgement means what §13.6 says it means.
    expect((await test.client.revoke(key(1))).closedChannels).toBe(1);
    expect(closed).toEqual(["first", "second"]);
  });

  it("re-runs the sweep on a retry whose commit is already durable", async () => {
    // The §13.6 acknowledgement means "no channel admitted under the withdrawn
    // authority is still open". A retry that finds nothing left to commit and
    // concludes there is nothing left to DO reports success with zero counts
    // while the channel is open — the operator is told the withdrawal took
    // effect when it did not.
    for (const withdraw of [
      (client: NodeClientAuthorizationClient) => client.purge(key(1)),
      (client: NodeClientAuthorizationClient) => client.revoke(key(1)),
      (client: NodeClientAuthorizationClient) => client.narrow({ key: key(1), maxRole: "viewer" }),
    ]) {
      const test = await harness(approvedSeed);
      const closed: string[] = [];
      let failNext = true;
      test.client.admitActiveChannel({
        admittedAuthority: snapshot,
        close: () => {
          closed.push(failNext ? "first" : "second");
          if (failNext) {
            failNext = false;
            throw new Error("close failed");
          }
        },
      });
      await expect(withdraw(test.client)).rejects.toMatchObject({
        code: "client_authorization_sweep_failed",
      });
      expect(closed).toEqual(["first"]);

      const retried = await withdraw(test.client);
      expect(retried).toEqual({ closedChannels: 1, abortedHandshakes: 0 });
      expect(closed).toEqual(["first", "second"]);
      // And a third attempt, with the channel now gone, is the honest zero.
      expect(await withdraw(test.client)).toEqual({ closedChannels: 0, abortedHandshakes: 0 });
    }
  });

  it("dispatches a handshake crossing row N3 mid-sweep exactly once", async () => {
    const test = await harness(approvedSeed);
    const events: string[] = [];
    // On the in-flight list when the snapshot is taken, and reaching row N3
    // while the sweep runs. Two independent registration sets would miss it in
    // both — not yet an active channel for one, no longer in flight for the
    // other — and leave an established channel open behind an acknowledgement
    // that says none is.
    let admission: string | undefined;
    const crossing = test.client.registerInFlightHandshake({
      admittedAuthority: snapshot,
      abort: async () => {
        events.push("abort");
        const verdict = crossing.establish({ close: () => void events.push("close") });
        admission = verdict.kind === "refused" ? verdict.reason : verdict.kind;
      },
    });

    const result = await test.client.revoke(key(1));
    expect(events).toEqual(["abort"]);
    expect(result).toEqual({ closedChannels: 0, abortedHandshakes: 1 });
    // Row N3 re-applied the test against the already committed record, so the
    // channel is refused rather than admitted behind the sweep.
    expect(admission).toBe("authorization_withdrawn");
  });

  it("sweeps a row-N3 test that never completed as an in-flight handshake", async () => {
    const test = await harness(approvedSeed);
    const events: string[] = [];
    const admission = test.client
      .registerInFlightHandshake({
        admittedAuthority: snapshot,
        abort: () => void events.push("abort"),
      })
      .establish({ close: () => void events.push("close") });
    if (admission.kind !== "entered") throw new Error(admission.reason);

    // §13.6's active E2EE channel is "a channel whose node-side mode machine is
    // in the `e2ee` state of §4.4". This one's accept has not reached the send
    // path, so it is a handshake: the FATAL-PRE abort with the generic reject,
    // never the `policy` code, which §13.6 reserves for the post-key side where
    // the peer is already authenticated.
    expect(await test.client.revoke(key(1))).toEqual({
      closedChannels: 0,
      abortedHandshakes: 1,
    });
    expect(events).toEqual(["abort"]);

    // And the phase change cannot resurrect what the sweep already terminated.
    admission.established();
    expect(
      await test.client.approve({ key: key(1), maxRole: "owner", capabilitySet: [CAPABILITY] }),
    ).toEqual({ closedChannels: 0, abortedHandshakes: 0 });
    expect(events).toEqual(["abort"]);
  });

  it("does not abort a handshake row N3 already refused earlier in the same sweep", async () => {
    const test = await harness(approvedSeed);
    const events: string[] = [];
    // The other interleaving of the crossing: row N3 arrives while the sweep is
    // awaiting an EARLIER entry's close, so the handshake is refused and retires
    // itself BEFORE the sweep reaches its own snapshot entry. Acting on the
    // entry anyway is one channel terminated twice, and a count that says the
    // withdrawal reached one more handshake than it did.
    test.client.admitActiveChannel({
      admittedAuthority: snapshot,
      close: () => {
        events.push("channel:close");
        const verdict = crossing.establish({ close: () => void events.push("crossing:close") });
        events.push(`crossing:${verdict.kind === "refused" ? verdict.reason : verdict.kind}`);
      },
    });
    const crossing = test.client.registerInFlightHandshake({
      admittedAuthority: snapshot,
      abort: () => void events.push("crossing:abort"),
    });

    const result = await test.client.revoke(key(1));
    expect(events).toEqual(["channel:close", "crossing:authorization_withdrawn"]);
    expect(result).toEqual({ closedChannels: 1, abortedHandshakes: 0 });
  });

  it("does not close a channel released after the sweep's snapshot", async () => {
    const test = await harness(approvedSeed);
    const closed: string[] = [];
    // The owner has already let this one go. Closing it again is harmless; the
    // COUNT is not, and the count is what the acknowledgement means.
    test.client.admitActiveChannel({
      admittedAuthority: snapshot,
      close: () => {
        closed.push("first");
        if (released.kind === "entered") released.release();
      },
    });
    const released = test.client.admitActiveChannel({
      admittedAuthority: snapshot,
      close: () => void closed.push("released"),
    });

    const result = await test.client.revoke(key(1));
    expect(closed).toEqual(["first"]);
    expect(result).toEqual({ closedChannels: 1, abortedHandshakes: 0 });
  });

  it("discharges the sweep a failed revocation owes when the owner re-approves", async () => {
    const test = await harness(approvedSeed);
    const closed: string[] = [];
    let failNext = true;
    test.client.admitActiveChannel({
      admittedAuthority: snapshot,
      close: () => {
        closed.push(failNext ? "first" : "second");
        if (failNext) {
          failNext = false;
          throw new Error("close failed");
        }
      },
    });
    await expect(test.client.revoke(key(1))).rejects.toMatchObject({
      code: "client_authorization_sweep_failed",
    });
    expect(closed).toEqual(["first"]);

    // §13.6 makes a widening — including a re-approval — effective "only on a
    // fresh ticket, channel, and handshake" and "never retroactively on an open
    // one", so the survivor of the failed revocation is still a channel admitted
    // under the withdrawn authority. The re-approval's own withdrawal test no
    // longer names it, because the record is `approved` again at the same
    // authority; without the outstanding sweep the command would succeed and
    // leave that channel open with nothing left recording that anything is owed.
    const approved = await test.client.approve({
      key: key(1),
      maxRole: "owner",
      capabilitySet: [CAPABILITY],
    });
    expect(approved).toEqual({ closedChannels: 1, abortedHandshakes: 0 });
    expect(closed).toEqual(["first", "second"]);
    // Discharged exactly once: the next command owes nothing.
    expect(await test.client.revoke(key(1))).toEqual({
      closedChannels: 0,
      abortedHandshakes: 0,
    });
  });

  it("refuses row N3 while a termination is still owed, even after a re-approval", async () => {
    const test = await harness(approvedSeed);
    const events: string[] = [];
    const crossing = test.client.registerInFlightHandshake({
      admittedAuthority: snapshot,
      abort: () => {
        events.push("abort");
        throw new Error("reject failed");
      },
    });
    await expect(test.client.revoke(key(1))).rejects.toMatchObject({
      code: "client_authorization_sweep_failed",
    });
    // A widening retries the debt like any other command, and is no more
    // acknowledgeable than the revocation was while the abort keeps failing.
    await expect(
      test.client.approve({ key: key(1), maxRole: "owner", capabilitySet: [CAPABILITY] }),
    ).rejects.toMatchObject({ code: "client_authorization_sweep_failed" });
    expect(events).toEqual(["abort", "abort"]);

    // The record is `approved` again at the same authority, so the withdrawal
    // test alone would admit this handshake — into `e2ee`, while its snapshot
    // entry still names the FATAL-PRE abort a sweep owes it, which is also how
    // the frozen dispatch would end up aborting an established channel.
    expect(crossing.establish({ close: () => void events.push("close") })).toEqual({
      kind: "refused",
      reason: "authorization_withdrawn",
    });
    expect(events).toEqual(["abort", "abort"]);
  });

  it("refuses a channel that reconnects after a restart under a withdrawn authority", async () => {
    const test = await harness(approvedSeed);
    await test.client.revoke(key(1));
    // A restarted process reads the committed record, so row N3 refuses the
    // channel outright rather than admitting it and relying on a later sweep.
    const restarted = await makeNodeClientAuthorizationClient({
      store: test.store,
      now: () => START + 1,
    });
    expect(
      restarted.admitActiveChannel({ admittedAuthority: snapshot, close: () => undefined }),
    ).toEqual({ kind: "refused", reason: "authorization_withdrawn" });
  });

  it("crashing between the sweep and the acknowledgement is idempotent on retry", async () => {
    const test = await harness(approvedSeed);
    const closed: string[] = [];
    const admission = test.client.admitActiveChannel({
      admittedAuthority: snapshot,
      close: () => {
        closed.push("channel");
      },
    });
    await test.client.revoke(key(1));
    expect(closed).toEqual(["channel"]);
    if (admission.kind === "entered") admission.release();

    // The operator never saw the acknowledgement and runs the command again.
    const repeated = await test.client.revoke(key(1));
    expect(repeated).toEqual({ closedChannels: 0, abortedHandshakes: 0 });
    expect((await test.stored()).revoked).toHaveLength(1);
  });

  it("never leaves the index granting more than the record on disk", async () => {
    // A durable write can land and the operation still reject. The index is
    // what the SYNCHRONOUS §8.6 step 6 read answers from, so leaving the
    // pre-commit view published would let step 6 grant an authority the record
    // no longer holds.
    const test = await harness(approvedSeed);
    const landing: NodeClientAuthorizationStore = {
      read: test.store.read,
      reset: test.store.reset,
      update: async (change) => {
        await test.store.update(change);
        throw new Error("failed after the write landed");
      },
    };
    const client = await makeNodeClientAuthorizationClient({ store: landing, now: () => START });
    expect(client.lookupClientAuthorization(key(1))?.status).toBe("approved");
    await expect(client.revoke(key(1))).rejects.toThrow("failed after the write landed");
    expect(client.lookupClientAuthorization(key(1))?.status).toBe("revoked");
  });

  it("falls back to no authority when the record cannot be re-read either", async () => {
    const test = await harness(approvedSeed);
    let readable = true;
    const broken: NodeClientAuthorizationStore = {
      read: () => (readable ? test.store.read() : Promise.reject(new Error("unreadable"))),
      reset: test.store.reset,
      update: () => {
        readable = false;
        return Promise.reject(new Error("write failed"));
      },
    };
    const client = await makeNodeClientAuthorizationClient({ store: broken, now: () => START });
    await expect(client.revoke(key(1))).rejects.toThrow();
    // No record is no authority, which is the direction §8.6 step 6 already
    // takes for an absent key.
    expect(client.lookupClientAuthorization(key(1))).toBeUndefined();
  });

  it("carries a newer binary's per-record keys through an owner command", async () => {
    const test = await harness();
    await writeFile(
      test.path,
      `${JSON.stringify({
        version: 1,
        revision: 1,
        pending: [],
        approved: [
          {
            ...pendingEntry(1, {
              maxRole: "owner",
              capabilitySet: [CAPABILITY],
              approvedAt: START,
            }),
            revocationScope: ["hub.example"],
          },
        ],
        revoked: [],
        pairingWindow: null,
      })}\n`,
      { mode: 0o600 },
    );
    await test.client.reload();
    await test.client.revoke(key(1));
    const stored = await test.stored();
    // The owner command rebuilds the entry field by field, which is exactly how
    // a field this binary does not know about gets silently deleted from a
    // record whose loss is an authority change.
    expect(stored.revoked[0]).toMatchObject({ revocationScope: ["hub.example"] });
  });

  it("re-reads the record set from disk when another process committed", async () => {
    const test = await harness(approvedSeed);
    expect(test.client.lookupClientAuthorization(key(1))?.status).toBe("approved");
    // A second process, holding its own handle on the same record.
    const otherProcess = await makeNodeClientAuthorizationClient({
      store: await makeNodeClientAuthorizationStore({ path: test.path }),
      now: () => START,
    });
    await otherProcess.revoke(key(1));
    expect(test.client.lookupClientAuthorization(key(1))?.status).toBe("approved");
    await test.client.reload();
    expect(test.client.lookupClientAuthorization(key(1))?.status).toBe("revoked");
  });
});

describe("node client authorization handshake contract", () => {
  it("satisfies the §8.6 step 6 and §8.9 option types", async () => {
    const test = await harness({
      approved: [
        pendingEntry(1, { maxRole: "owner", capabilitySet: [CAPABILITY], approvedAt: START }),
      ],
    });

    // Compile-time proof that these are the shapes the handshake declares.
    const nodeOptions = {
      lookupClientAuthorization: test.client.lookupClientAuthorization,
    } satisfies Pick<E2eeNodeHandshakeOptions, "lookupClientAuthorization">;
    const implicitFinish = {
      reReadAuthorization: test.client.reReadAuthorization,
    } satisfies Pick<
      Parameters<E2eeNodeHandshake["authenticateImplicitFinish"]>[0],
      "reReadAuthorization"
    >;

    const record = nodeOptions.lookupClientAuthorization(key(1));
    expect(record).toEqual({ status: "approved", maxRole: "owner", capabilitySet: [CAPABILITY] });
    const snapshot = snapshotOf(key(1), {
      maxRole: record!.maxRole,
      capabilitySet: record!.capabilitySet,
    });
    expect(e2eeAuthorizationWithdrawn(snapshot, implicitFinish.reReadAuthorization(key(1)))).toBe(
      false,
    );

    await test.client.narrow({ key: key(1), maxRole: "viewer" });
    expect(e2eeAuthorizationWithdrawn(snapshot, implicitFinish.reReadAuthorization(key(1)))).toBe(
      true,
    );

    // A pending record authorizes nothing, and an unknown key is absent.
    expect((await test.pair(key(2))).kind).toBe("admit");
    expect(nodeOptions.lookupClientAuthorization(key(2))).toEqual({
      status: "pending",
      maxRole: "viewer",
      capabilitySet: [],
    });
    expect(nodeOptions.lookupClientAuthorization(key(3))).toBeUndefined();
    // A key this node could never have stored is absent, not a throw: a throw
    // inside `receiveHello` is a local failure rather than the §11.2 P12 an
    // absent record deserves.
    expect(
      nodeOptions.lookupClientAuthorization({
        hubOrigin: "not-an-origin",
        accountId: ACCOUNT_ID,
        clientIdentityFingerprint: fingerprintBytes(1),
      }),
    ).toBeUndefined();
  });

  it("refuses owner commands with invalid authority vocabulary", async () => {
    const test = await harness({
      approved: [
        pendingEntry(1, { maxRole: "owner", capabilitySet: [CAPABILITY], approvedAt: START }),
      ],
    });
    await expect(
      test.client.approve({ key: key(1), maxRole: "root", capabilitySet: [CAPABILITY] }),
    ).rejects.toMatchObject({ code: "client_authorization_invalid" });
    await expect(
      test.client.approve({ key: key(1), maxRole: "owner", capabilitySet: ["ryco.shell"] }),
    ).rejects.toMatchObject({ code: "client_authorization_invalid" });
    await expect(
      test.client.approve({
        key: key(1),
        maxRole: "owner",
        capabilitySet: [CAPABILITY],
        displayLabel: "x".repeat(101),
      }),
    ).rejects.toMatchObject({ code: "client_authorization_invalid" });
    // A widening is refused: `narrow` can never be the path an authority
    // increase takes.
    await test.client.narrow({ key: key(1), maxRole: "viewer", capabilitySet: [] });
    await expect(test.client.narrow({ key: key(1), maxRole: "owner" })).rejects.toMatchObject({
      code: "client_authorization_not_narrowing",
    });
    await expect(test.client.revoke(key(9_999))).rejects.toMatchObject({
      code: "client_authorization_not_found",
    });
  });

  it("lists records with the display form, never a raw key", async () => {
    const test = await harness();
    expect((await test.pair(key(1))).kind).toBe("admit");
    await test.client.approve({
      key: key(1),
      maxRole: "operator",
      capabilitySet: [CAPABILITY],
      displayLabel: "Owner phone",
    });
    const listing = await test.client.list();
    expect(listing.records).toHaveLength(1);
    expect(listing.records[0]).toMatchObject({
      status: "approved",
      maxRole: "operator",
      capabilitySet: [CAPABILITY],
      displayLabel: "Owner phone",
      safetyNumber: SAFETY_NUMBER,
    });
    expect(listing.records[0]?.fingerprintDisplay).toBe(
      `SHA256:${fingerprint(1).replace(/=+$/, "")}`,
    );
    await test.client.setDisplayLabel({ key: key(1), displayLabel: undefined });
    expect((await test.client.list()).records[0]?.displayLabel).toBeUndefined();
  });
});

describe("node client authorization commit failure containment", () => {
  /**
   * A store that serves one snapshot and then fails everything.
   *
   * BOTH HALVES FAIL, which is the condition that matters: `read` takes the same
   * single-writer lock `update` does, so a CLI in another process holding it
   * past the lock deadline — or a state directory that has become unreadable —
   * fails the write AND the re-read that follows it.
   */
  function failingStore(seed: NodeClientAuthorizationRecordFile): {
    readonly store: NodeClientAuthorizationStore;
    readonly fail: () => void;
  } {
    let failing = false;
    const refuse = (): never => {
      throw new NodeClientAuthorizationStoreError("client_authorization_state_locked");
    };
    return {
      fail: () => {
        failing = true;
      },
      store: {
        read: async () => (failing ? refuse() : seed),
        update: async () => refuse(),
        reset: async () => refuse(),
      },
    };
  }

  const approvedSeed = (): NodeClientAuthorizationRecordFile => ({
    version: 1,
    revision: 1,
    pending: [],
    approved: [
      pendingEntry(1, { maxRole: "operator", capabilitySet: [CAPABILITY], approvedAt: START }),
    ],
    revoked: [],
    pairingWindow: null,
  });

  it("keeps every approved client readable when a pairing commit cannot be written", async () => {
    // §13.2 step 3 put this commit on a path an UNAUTHENTICATED peer's hello
    // reaches, and one whose failure §13.2 makes best-effort and the caller
    // therefore swallows. A pending-class change appends a record that grants
    // nothing, spends the owner's window, or drops a pending entry, so no
    // failure of it can leave memory granting more than disk — and publishing
    // the empty record instead would refuse every approved client with the same
    // generic reject a revocation takes, silently, until an owner command
    // republished disk state.
    const failing = failingStore(approvedSeed());
    const client = await makeNodeClientAuthorizationClient({
      store: failing.store,
      now: () => START,
    });
    const decision = client.evaluatePairingAdmission({
      hubOrigin: HUB_ORIGIN,
      accountId: ACCOUNT_ID,
      clientIdentityFingerprint: fingerprintBytes(900),
      safetyNumber: SAFETY_NUMBER,
      observedRole: OBSERVED_ROLE,
    });
    expect(decision.kind).toBe("admit");
    failing.fail();

    await expect(client.commitPairingAdmission(decision)).rejects.toMatchObject({
      code: "client_authorization_state_failed",
    });
    expect(client.lookupClientAuthorization(key(1))).toMatchObject({
      status: "approved",
      maxRole: "operator",
      capabilitySet: [CAPABILITY],
    });
  });

  it("still fails an owner change closed when neither the write nor the re-read lands", async () => {
    // The other direction, unchanged: an owner change CAN widen authority and a
    // durable write can land while the operation still rejects, so a failure
    // that cannot even re-read publishes the empty record — no record is no
    // authority, the direction §8.6 step 6 already takes for an absent key.
    const failing = failingStore(approvedSeed());
    const client = await makeNodeClientAuthorizationClient({
      store: failing.store,
      now: () => START,
    });
    expect(client.lookupClientAuthorization(key(1))).toMatchObject({ status: "approved" });
    failing.fail();

    await expect(client.revoke(key(1))).rejects.toMatchObject({
      code: "client_authorization_state_failed",
    });
    expect(client.lookupClientAuthorization(key(1))).toBeUndefined();
  });
});

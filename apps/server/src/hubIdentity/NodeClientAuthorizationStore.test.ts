import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  E2EE_APPROVED_CLIENTS_MAX,
  E2EE_PENDING_CLIENTS_MAX_GLOBAL,
  E2EE_PENDING_CLIENTS_MAX_PER_ACCOUNT,
  E2EE_REVOKED_CLIENTS_RETAINED_MAX,
} from "@ryco/shared/relayE2eeConstants";
import { describe, expect, it } from "vite-plus/test";

import {
  makeNodeClientAuthorizationStore,
  type StoredClientAuthorizationEntry,
} from "./NodeClientAuthorizationStore.ts";

const HUB_ORIGIN = "https://relay.example";
const ACCOUNT_ID = "acct_0123456789";
const SAFETY_NUMBER = Array.from({ length: 12 }, (_, index) => String(index % 10).repeat(5)).join(
  " ",
);

function fingerprint(seed: number): string {
  return Buffer.from(new Uint8Array(32).fill(seed)).toString("base64url");
}

function entry(overrides: Partial<StoredClientAuthorizationEntry> = {}): Record<string, unknown> {
  return {
    hubOrigin: HUB_ORIGIN,
    accountId: ACCOUNT_ID,
    clientIdentityFingerprint: fingerprint(1),
    maxRole: "viewer",
    capabilitySet: [],
    createdAt: 1_000,
    safetyNumber: SAFETY_NUMBER,
    ...overrides,
  };
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "ryco-client-authz-store-"));
  const path = join(root, "hub-e2ee-clients.json");
  const writeRaw = (json: string): Promise<void> => writeFile(path, `${json}\n`, { mode: 0o600 });
  const write = (overrides: Record<string, unknown>): Promise<void> =>
    writeRaw(
      JSON.stringify({
        version: 1,
        revision: 1,
        pending: [],
        approved: [],
        revoked: [],
        pairingWindow: null,
        ...overrides,
      }),
    );
  return { path, write, writeRaw, store: await makeNodeClientAuthorizationStore({ path }) };
}

describe("node client authorization store", () => {
  it("round-trips a record in every class", async () => {
    const test = await harness();
    await test.write({
      pending: [entry({ pairingReservedAt: 1_500, observedRole: "operator" })],
      approved: [
        entry({
          clientIdentityFingerprint: fingerprint(2),
          approvedAt: 2_000,
          observedRole: "owner",
        }),
      ],
      revoked: [
        entry({ clientIdentityFingerprint: fingerprint(3), approvedAt: 2_000, revokedAt: 3_000 }),
      ],
    });
    const record = await test.store.read();
    expect(record.pending).toHaveLength(1);
    expect(record.pending[0]?.pairingReservedAt).toBe(1_500);
    expect(record.pending[0]?.observedRole).toBe("operator");
    expect(record.approved[0]?.observedRole).toBe("owner");
    expect(record.revoked[0]?.observedRole).toBeUndefined();
    expect(record.approved[0]?.approvedAt).toBe(2_000);
    expect(record.revoked[0]?.revokedAt).toBe(3_000);
  });

  it("preserves top-level keys it does not know", async () => {
    // The 2b lesson, restated for this record: a binary that reconstructs its
    // state from known keys alone deletes the rest on its next write, and a
    // downgrade is an ordinary operator action. Here that would clear the
    // owner's revocations.
    const test = await harness();
    await test.writeRaw(
      JSON.stringify({
        version: 1,
        revision: 1,
        pending: [],
        approved: [],
        revoked: [],
        pairingWindow: null,
        futureField: { kept: true },
      }).replace('"futureField"', '"__proto__":{"evil":true},"futureField"'),
    );
    await test.store.update((current) => ({
      ...current,
      revision: current.revision + 1,
      approved: [entry({ approvedAt: 2_000 }) as unknown as StoredClientAuthorizationEntry],
    }));
    const raw = JSON.parse(await readFile(test.path, "utf8")) as Record<string, unknown>;
    expect(raw["futureField"]).toEqual({ kept: true });
    expect(Object.hasOwn(raw, "evil")).toBe(false);
    expect((raw["approved"] as unknown[]).length).toBe(1);
  });

  it("preserves keys it does not know INSIDE a record and inside the window", async () => {
    // Forwarding unknown keys at the top level only moves the trap one nesting
    // level down: the field a newer binary adds is on the RECORD — a scope
    // qualifier on a revocation, a second authority dimension — and it is the
    // record whose loss is an authority change.
    const test = await harness();
    await test.writeRaw(
      JSON.stringify({
        version: 1,
        revision: 1,
        pending: [],
        approved: [entry({ approvedAt: 2_000, clientIdentityFingerprint: fingerprint(2) })],
        revoked: [
          {
            ...entry({ approvedAt: 2_000, revokedAt: 3_000 }),
            revocationScope: ["hub.example"],
          },
        ],
        pairingWindow: {
          clientIdentityFingerprint: fingerprint(4),
          openedAt: 5_000,
          windowPolicy: "strict",
        },
      }),
    );

    // Any write at all: the loss would happen on the next one this binary makes.
    await test.store.update((current) => ({ ...current, revision: current.revision + 1 }));

    const raw = JSON.parse(await readFile(test.path, "utf8")) as {
      revoked: Record<string, unknown>[];
      pairingWindow: Record<string, unknown>;
    };
    expect(raw.revoked[0]?.["revocationScope"]).toEqual(["hub.example"]);
    expect(raw.revoked[0]?.["revokedAt"]).toBe(3_000);
    expect(raw.pairingWindow["windowPolicy"]).toBe("strict");
    expect(raw.pairingWindow["openedAt"]).toBe(5_000);
    // And the carrier is a nesting level in memory only; it never reaches disk.
    expect(Object.hasOwn(raw.revoked[0] ?? {}, "forwardFields")).toBe(false);
    expect(Object.hasOwn(raw.pairingWindow, "forwardFields")).toBe(false);
  });

  it("never lets a stored forwardFields key shadow a field that decides authority", async () => {
    const test = await harness();
    await test.writeRaw(
      JSON.stringify({
        version: 1,
        revision: 1,
        pending: [],
        approved: [
          { ...entry({ approvedAt: 2_000 }), forwardFields: { maxRole: "owner", evil: true } },
        ],
        revoked: [],
        pairingWindow: null,
      }),
    );
    await test.store.update((current) => ({ ...current, revision: current.revision + 1 }));
    const raw = JSON.parse(await readFile(test.path, "utf8")) as {
      approved: Record<string, unknown>[];
    };
    // Dropped outright rather than carried: it is the carrier's own name, and
    // spreading it back out would let it overwrite `maxRole`.
    expect(raw.approved[0]?.["maxRole"]).toBe("viewer");
    expect(Object.hasOwn(raw.approved[0] ?? {}, "forwardFields")).toBe(false);
    expect(Object.hasOwn(raw.approved[0] ?? {}, "evil")).toBe(false);
  });

  it("refuses a key that appears in more than one class", async () => {
    const test = await harness();
    await test.write({
      pending: [entry()],
      approved: [entry({ approvedAt: 2_000 })],
    });
    await expect(test.store.read()).rejects.toMatchObject({
      code: "client_authorization_state_corrupt",
    });
  });

  it("makes the class fix the transition timestamps and the reservation", async () => {
    const test = await harness();
    for (const invalid of [
      { pending: [entry({ approvedAt: 2_000 })] },
      { pending: [entry({ revokedAt: 2_000 })] },
      { approved: [entry()] },
      { approved: [entry({ approvedAt: 2_000, revokedAt: 3_000 })] },
      { revoked: [entry()] },
      // A reservation parked on a record no eviction rule may reach.
      { approved: [entry({ approvedAt: 2_000, pairingReservedAt: 1_500 })] },
      { revoked: [entry({ revokedAt: 3_000, pairingReservedAt: 1_500 })] },
    ]) {
      await test.write(invalid);
      await expect(test.store.read()).rejects.toMatchObject({
        code: "client_authorization_state_corrupt",
      });
    }
  });

  it("enforces every §13.6 cap structurally, including the per-account partition", async () => {
    const test = await harness();
    const many = (count: number, make: (index: number) => Record<string, unknown>) =>
      Array.from({ length: count }, (_, index) => make(index));
    const distinct = (index: number, extra: Record<string, unknown> = {}) =>
      entry({
        clientIdentityFingerprint: Buffer.from(
          Uint8Array.from({ length: 32 }, (_, byte) => (byte === 0 ? index % 256 : index >> 8)),
        ).toString("base64url"),
        ...extra,
      });

    await test.write({
      pending: many(E2EE_PENDING_CLIENTS_MAX_GLOBAL + 1, (index) =>
        distinct(index, { accountId: `acct_${index}` }),
      ),
    });
    await expect(test.store.read()).rejects.toMatchObject({
      code: "client_authorization_state_corrupt",
    });

    // Under both the global cap and the array bound, but over the per-account
    // partition: the partition is a bound this record holds on its own.
    await test.write({
      pending: many(E2EE_PENDING_CLIENTS_MAX_PER_ACCOUNT + 1, (index) => distinct(index)),
    });
    await expect(test.store.read()).rejects.toMatchObject({
      code: "client_authorization_state_corrupt",
    });

    await test.write({
      approved: many(E2EE_APPROVED_CLIENTS_MAX + 1, (index) =>
        distinct(index, { approvedAt: 2_000 }),
      ),
    });
    await expect(test.store.read()).rejects.toMatchObject({
      code: "client_authorization_state_corrupt",
    });

    await test.write({
      revoked: many(E2EE_REVOKED_CLIENTS_RETAINED_MAX + 1, (index) =>
        distinct(index, { revokedAt: 3_000 }),
      ),
    });
    await expect(test.store.read()).rejects.toMatchObject({
      code: "client_authorization_state_corrupt",
    });
  });

  it("validates the fingerprint, the safety number, the capability set, and the label", async () => {
    const test = await harness();
    for (const invalid of [
      // Two encodings of one digest would let a file name one client twice.
      { clientIdentityFingerprint: `${fingerprint(1).slice(0, 42)}B` },
      { clientIdentityFingerprint: Buffer.from(new Uint8Array(31)).toString("base64url") },
      { safetyNumber: SAFETY_NUMBER.slice(0, -1) },
      { safetyNumber: SAFETY_NUMBER.replace(" ", "-") },
      { maxRole: "administrator" },
      // The observed role is display metadata, but only ever a role `maxRole` could hold.
      { observedRole: "administrator" },
      { observedRole: 3 as unknown as string },
      { capabilitySet: ["ryco.rpc", "ryco.rpc"] },
      { capabilitySet: ["not.a.capability"] },
      { displayLabel: "x".repeat(101) },
      { displayLabel: "escape\u001b[2Jsequence" },
      { hubOrigin: "https://relay.example/" },
      { accountId: "" },
    ]) {
      await test.write({ pending: [entry(invalid)] });
      await expect(test.store.read()).rejects.toMatchObject({
        code: "client_authorization_state_corrupt",
      });
    }
  });

  it("refuses an update that does not advance the revision", async () => {
    const test = await harness();
    await test.write({});
    await expect(test.store.update((current) => current)).rejects.toMatchObject({
      code: "client_authorization_state_operation_failed",
    });
  });

  it("creates an empty record on first read and clears it on reset", async () => {
    const test = await harness();
    expect((await test.store.read()).approved).toEqual([]);
    await test.store.update((current) => ({
      ...current,
      revision: current.revision + 1,
      approved: [entry({ approvedAt: 2_000 }) as unknown as StoredClientAuthorizationEntry],
    }));
    expect((await test.store.reset()).approved).toEqual([]);
    expect((await test.store.read()).approved).toEqual([]);
  });
});

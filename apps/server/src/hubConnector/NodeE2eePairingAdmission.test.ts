import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { RELAY_INITIAL_LIMITS } from "@ryco/contracts/relay";
import {
  E2EE_PENDING_CLIENTS_MAX_PER_ACCOUNT,
  E2EE_SAFETY_NUMBER_DIGITS,
} from "@ryco/shared/relayE2eeConstants";
import { E2eeClientHandshake } from "@ryco/shared/relayE2eeHandshake";
import { e2eeKeyFingerprint, formatE2eeKeyFingerprint } from "@ryco/shared/relayE2eeKeys";
import { deriveE2eeSafetyNumber } from "@ryco/shared/relayE2eeVerificationDisplay";
import {
  E2EE_SUITE_25519_CHACHAPOLY_SHA256,
  encodeE2eeHandshakeReject,
} from "@ryco/shared/relayE2eeWire";

import {
  makeNodeClientAuthorizationClient,
  type NodeClientAuthorizationClient,
} from "../hubIdentity/NodeClientAuthorizationClient.ts";
import {
  makeNodeClientAuthorizationStore,
  type NodeClientAuthorizationRecordFile,
  type StoredClientAuthorizationEntry,
} from "../hubIdentity/NodeClientAuthorizationStore.ts";
import type { NodeE2eeAdvertisement } from "../hubIdentity/NodeE2eeCapabilityStatement.ts";
import { makeNodeE2eeChannelAdvertiser } from "./NodeE2eeChannelAdvertiser.ts";
import {
  makeNodeE2eeChannelSession,
  makeNodeE2eeHandshakeRateLimiter,
  type NodeE2eeChannelAuthorization,
  type NodeE2eeChannelSession,
} from "./NodeE2eeChannelSession.ts";
import {
  ACCOUNT_ID,
  CAPABILITY,
  CLIENT_IDENTITY_PUBLIC,
  HUB_ORIGIN,
  NODE_AGREEMENT_SECRET,
  NOW,
  PERMISSIVE_POLICY,
  ROLE,
  clientChannel,
  establish,
  harness,
  nativeCredentials,
  permissiveRegistration,
  settle,
  statementClient,
  stripPrelude,
  type Harness,
} from "./testUtils/nodeE2eeChannelHarness.ts";

// §13.2's first-contact pairing ceremony ON THE RELAY PATH —
// docs/relay-e2ee-protocol.md §13.2 (the ceremony and its step order), §13.6
// (the record set, the caps, the owner-opened window, and the refusal counter),
// §11.2 (the uniform pre-key observable, and the rule that no pending-class
// mutation may sit on the response path), and §11.3's pre-key rows.
//
// The node here is the real one: the real `NodeClientAuthorizationStore` over a
// real file, the real `NodeClientAuthorizationClient` policy, and the real
// channel session behind a real `RelayChannelRegistry`. Nothing about the record
// set is simulated, because the claim under test is that an owner who opens a
// window sees a record the ceremony actually wrote.
//
// THE CLAIM IS AS MUCH NEGATIVE AS POSITIVE: the owner's side of the event gains
// a record, and the CLIENT'S side gains nothing at all. Every wire assertion
// below is therefore made against one literal — a single 64-byte
// `E2EEHandshakeReject` and one `channel_rejected` — and the two runs that
// differ only in whether a window was open are compared to each other directly.

const SEEDED_SAFETY_NUMBER = Array.from({ length: E2EE_SAFETY_NUMBER_DIGITS.groups }, (_, group) =>
  String(group % 10).repeat(E2EE_SAFETY_NUMBER_DIGITS.digitsPerGroup),
).join(E2EE_SAFETY_NUMBER_DIGITS.separator);

/** §7.1: the authenticated `ryco.client-key.v1` fingerprint of the harness client. */
const CLIENT_FINGERPRINT = e2eeKeyFingerprint("client-identity", CLIENT_IDENTITY_PUBLIC);
const CLIENT_FINGERPRINT_DISPLAY = formatE2eeKeyFingerprint(CLIENT_FINGERPRINT);
const CLIENT_FINGERPRINT_STORED = Buffer.from(CLIENT_FINGERPRINT).toString("base64url");

/** §11.2: the whole record, fixed completely, and the only thing a client sees. */
const REJECT_HEX = Buffer.from(encodeE2eeHandshakeReject()).toString("hex");

const CLIENT_KEY = {
  hubOrigin: HUB_ORIGIN,
  accountId: ACCOUNT_ID,
  clientIdentityFingerprint: CLIENT_FINGERPRINT,
} as const;

/**
 * A seeded fingerprint that cannot be the harness client's.
 *
 * It is a fingerprint-length value with 30 zero bytes, which no digest of a real
 * key is, so a seeded pending record can never accidentally BE the record the
 * ceremony is supposed to create.
 */
function seededFingerprint(seed: number): string {
  return Buffer.from(
    Uint8Array.from({ length: 32 }, (_, offset) => (offset === 0 ? 0xff : offset === 1 ? seed : 0)),
  ).toString("base64url");
}

function seededEntry(
  seed: number,
  overrides: Partial<StoredClientAuthorizationEntry> = {},
): StoredClientAuthorizationEntry {
  return {
    hubOrigin: HUB_ORIGIN,
    accountId: ACCOUNT_ID,
    clientIdentityFingerprint: seededFingerprint(seed),
    maxRole: "viewer",
    capabilitySet: [],
    // Ordered by seed, so "the oldest eligible pending record" is a value this
    // file names rather than one a test has to infer.
    createdAt: NOW - 10_000 + seed,
    safetyNumber: SEEDED_SAFETY_NUMBER,
    ...overrides,
  };
}

/** The per-account partition filled exactly to its §13.6 cap. */
const SATURATED_PENDING: readonly StoredClientAuthorizationEntry[] = Array.from(
  { length: E2EE_PENDING_CLIENTS_MAX_PER_ACCOUNT },
  (_, index) => seededEntry(index),
);

interface PairingNode {
  readonly client: NodeClientAuthorizationClient;
  readonly stored: () => Promise<NodeClientAuthorizationRecordFile>;
}

/** The real §13.6 record set, over a real file, on the clock the harness uses. */
async function pairingNode(
  seed: Partial<NodeClientAuthorizationRecordFile> = {},
): Promise<PairingNode> {
  const root = await mkdtemp(join(tmpdir(), "ryco-pairing-admission-"));
  const path = join(root, "hub-e2ee-clients.json");
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
  const store = await makeNodeClientAuthorizationStore({ path });
  const client = await makeNodeClientAuthorizationClient({ store, now: () => NOW });
  return {
    client,
    stored: async () =>
      JSON.parse(await readFile(path, "utf8")) as NodeClientAuthorizationRecordFile,
  };
}

type CommitBehavior = "real" | "throws" | "hangs";
/**
 * §13.2 step 3's IN-MEMORY half, made to fail.
 *
 * `evaluatePairingAdmission` can genuinely throw — `requireKey`,
 * `canonicalizeE2eeHubOrigin`, and `assertE2eeAccountId` all raise
 * `client_authorization_invalid`, and the §13.4 derivation beside it raises on
 * key material of unexpected length — so the containment around it is a real
 * path and not a defensive gesture.
 */
type EvaluateBehavior = "real" | "throws";

interface RelaySurface {
  readonly authorization: NodeE2eeChannelAuthorization;
  /** Let the deferred commit run, and wait for the durable write it starts. */
  readonly settled: () => Promise<void>;
  /**
   * What was ALREADY on the socket at the instant each commit was invoked.
   *
   * The point of the whole deferral: `orderedSession` below can only observe the
   * order of statements inside `runHandshake`, because binding `send` and
   * `close` directly strips the relay registry's own close deferral. This reads
   * the frames the real `RelayChannelRegistry` has flushed, so "after the reject
   * and the close" is asserted of the WIRE.
   */
  readonly commitWire: () => readonly string[];
}

/**
 * The relay path's view of the record set, instrumented onto one shared log.
 *
 * `commit` is what §13.2's ordering claim is asserted against: a commit that
 * throws and one that never settles must leave the wire — and the point at which
 * it is produced — exactly as a commit that succeeds leaves them.
 */
function relaySurface(
  client: NodeClientAuthorizationClient,
  log: string[],
  behavior: {
    readonly commit?: CommitBehavior;
    readonly evaluate?: EvaluateBehavior;
    /** The channel this surface serves, once the harness has built it. */
    readonly channel?: () => Harness | undefined;
  } = {},
): RelaySurface {
  const commit = behavior.commit ?? "real";
  const started: Promise<unknown>[] = [];
  const commitWire: string[] = [];
  return {
    authorization: {
      lookupClientAuthorization: (key) => client.lookupClientAuthorization(key),
      reReadAuthorization: (key) => client.reReadAuthorization(key),
      registerInFlightHandshake: (input) => client.registerInFlightHandshake(input),
      evaluatePairingAdmission: (input) => {
        if (behavior.evaluate === "throws") {
          log.push("evaluate:throw");
          throw new Error("evaluate refused");
        }
        const decision = client.evaluatePairingAdmission(input);
        log.push(`evaluate:${decision.kind}`);
        return decision;
      },
      commitPairingAdmission: (admission) => {
        const channel = behavior.channel?.();
        if (channel !== undefined) {
          commitWire.push(
            `payloads=${channel.dataPayloads().length},closes=${channel.closeReasons().length}`,
          );
        }
        log.push("commit");
        if (commit === "throws") throw new Error("commit refused");
        if (commit === "hangs") return new Promise<void>(() => undefined);
        const write = client.commitPairingAdmission(admission);
        started.push(write.catch(() => undefined));
        return write;
      },
    },
    settled: async () => {
      await settle();
      await Promise.allSettled(started);
      await settle();
    },
    commitWire: () => commitWire,
  };
}

/** One bounded §13.2 step 2 pairing hello, from the real client handshake. */
function pairingHello(advertisement: NodeE2eeAdvertisement): Uint8Array {
  const client = new E2eeClientHandshake({
    channel: clientChannel,
    advertised: advertisement.material,
    selectedSuite: E2EE_SUITE_25519_CHACHAPOLY_SHA256,
    offeredSuites: [E2EE_SUITE_25519_CHACHAPOLY_SHA256],
    credentials: nativeCredentials(),
    intendedCapability: CAPABILITY,
    intendedRole: ROLE,
  });
  const hello = client.createHello(NOW);
  if (hello.kind !== "hello") throw new Error(`hello: ${JSON.stringify(hello)}`);
  return hello.record;
}

interface Wire {
  /** How many data payloads reached the socket, the §5.4 carrier included. */
  readonly payloadCount: number;
  /** Every payload after the carrier: this channel's whole response to the hello. */
  readonly response: readonly string[];
  readonly closes: readonly (string | undefined)[];
  readonly toParser: number;
}

/**
 * Everything this channel put on the socket, as literals.
 *
 * The carrier is compared by PRESENCE and not by bytes, and only the carrier:
 * §11.2 fixes the record count as well as the record, so `payloadCount` is part
 * of the observable, but each harness signs its own §5.2 statement with an
 * Ed25519 identity generated per instance — so the carrier's bytes differ
 * between two runs for a reason that has nothing to do with pairing, and it is
 * emitted before the hello is read and cannot carry anything the record set
 * decided. Everything the node emits IN RESPONSE to the hello is compared byte
 * for byte.
 */
function wireOf(node: Harness): Wire {
  const payloads = node
    .dataPayloads()
    .map((payload) => Buffer.from(stripPrelude(payload)).toString("hex"));
  return {
    payloadCount: payloads.length,
    response: payloads.slice(1),
    closes: node.closeReasons(),
    toParser: node.deliveredToParser.length,
  };
}

interface PairingRun {
  readonly node: PairingNode;
  readonly channel: Harness;
  readonly advertisement: NodeE2eeAdvertisement;
  readonly log: readonly string[];
  readonly wire: Wire;
  /** See `RelaySurface.commitWire`: the socket as the commit found it. */
  readonly commitWire: readonly string[];
}

/** Open a window or not, saturate the partition or not, then pair exactly once. */
async function runPairing(input: {
  readonly seed?: Partial<NodeClientAuthorizationRecordFile>;
  readonly openWindow?: boolean;
  readonly commit?: CommitBehavior;
  /**
   * A local failure raised inside the prekey borrow, AFTER §8.6 step 6 has taken
   * the §13.2 step 3 decision: key custody refusing, an encoder failing, the
   * §4.5 ceiling. §11.2's table names no row for it and the wire is the same
   * generic reject.
   */
  readonly failLocally?: boolean;
}): Promise<PairingRun> {
  const node = await pairingNode(input.seed ?? {});
  if (input.openWindow === true) await node.client.openPairingWindow(CLIENT_FINGERPRINT);
  const log: string[] = [];
  let channel: Harness | undefined;
  const surface = relaySurface(node.client, log, {
    ...(input.commit === undefined ? {} : { commit: input.commit }),
    channel: () => channel,
  });
  channel = await harness({
    authorization: surface.authorization,
    ...(input.failLocally === true
      ? {
          afterPrekeyBorrow: async () => {
            throw new Error("key custody refused the borrow");
          },
        }
      : {}),
  });
  const advertisement = await channel.open();
  await channel.deliver(pairingHello(advertisement));
  await surface.settled();
  return {
    node,
    channel,
    advertisement,
    log,
    wire: wireOf(channel),
    commitWire: surface.commitWire(),
  };
}

interface OrderedSession {
  readonly advertisement: NodeE2eeAdvertisement;
  readonly session: NodeE2eeChannelSession;
}

/**
 * One real channel session with the relay registry's deferrals removed.
 *
 * `RelayChannelRegistry` queues every close it schedules as a microtask and puts
 * control frames on the socket only at a flush, so the socket's own ordering
 * cannot say whether the pending-class commit was started before or after the
 * close was asked for. Binding `send` and `close` directly is what makes §13.2
 * step 3's order — evaluate, reject, close, commit — an assertion rather than an
 * inference. Everything else is the real thing: the real advertiser, a really
 * signed §5.2 statement, and the real responder.
 */
async function orderedSession(
  authorization: NodeE2eeChannelAuthorization,
  log: string[],
): Promise<OrderedSession> {
  const statements = statementClient(() => PERMISSIVE_POLICY);
  const advertiser = makeNodeE2eeChannelAdvertiser({
    hubOrigin: HUB_ORIGIN,
    readAdvertisement: (hubOrigin) => statements.advertised(hubOrigin),
    policy: () => PERMISSIVE_POLICY,
    recordFallback: async () => undefined,
  });
  advertiser.connectionReady({ maxDataChunkBytes: RELAY_INITIAL_LIMITS.maxDataChunkBytes });
  const announcement = await advertiser.openChannel();
  const session = makeNodeE2eeChannelSession({
    channel: clientChannel,
    announcement,
    plaintextCeiling: 512 * 1_024,
    send: (bytes) => {
      log.push(`send:${Buffer.from(bytes).toString("hex")}`);
      return { accepted: true };
    },
    admit: () => ({ send: () => ({ accepted: true }), release: () => undefined }),
    close: (reason) => {
      log.push(`close:${reason ?? "none"}`);
    },
    policy: () => PERMISSIVE_POLICY,
    registerPolicyChannel: permissiveRegistration,
    authorization,
    withPrekeySecret: async (_prekeyId, use) => use(NODE_AGREEMENT_SECRET),
    rateLimiter: makeNodeE2eeHandshakeRateLimiter(),
    now: () => NOW,
    recordPeerLegacyFallback: () => undefined,
  });
  session.announce();
  // The §5.4 carrier is the announcement's own send and precedes the hello; the
  // ordering under test starts at the hello.
  log.length = 0;
  const result = await statements.advertised(HUB_ORIGIN);
  if (result.kind !== "available") throw new Error(result.reason);
  return { advertisement: result.advertisement, session };
}

describe("§13.2 pairing admission on the relay path", () => {
  it("gives the owner a pending record and the client the identical wire either way", async () => {
    // The four situations §13.6 partitions a first-seen key into: a window open
    // or closed, crossed with a pending partition at its cap or under it. Four
    // different owner outcomes and ONE observable — which is exactly §13.6's
    // "what the window is and is not observable as".
    const rows = [
      {
        name: "window open, partition saturated",
        seed: { pending: [...SATURATED_PENDING] },
        openWindow: true,
        pending: E2EE_PENDING_CLIENTS_MAX_PER_ACCOUNT,
        created: true,
        reserved: true,
        refused: 0,
      },
      {
        name: "window closed, partition saturated",
        seed: { pending: [...SATURATED_PENDING] },
        openWindow: false,
        pending: E2EE_PENDING_CLIENTS_MAX_PER_ACCOUNT,
        created: false,
        reserved: false,
        refused: 1,
      },
      {
        name: "window open, partition under cap",
        seed: {},
        openWindow: true,
        pending: 1,
        created: true,
        reserved: true,
        refused: 0,
      },
      {
        name: "window closed, partition under cap",
        seed: {},
        openWindow: false,
        pending: 1,
        created: true,
        reserved: false,
        refused: 0,
      },
    ] as const;

    const wires: Wire[] = [];
    for (const row of rows) {
      const run = await runPairing({ seed: row.seed, openWindow: row.openWindow });
      const listing = await run.node.client.list();
      const created = listing.records.find(
        (record) => record.fingerprintDisplay === CLIENT_FINGERPRINT_DISPLAY,
      );

      // The OWNER's side of the event.
      expect({
        name: row.name,
        pending: listing.records.filter((record) => record.status === "pending").length,
        created: created !== undefined,
        reserved: created?.pairingReserved ?? false,
        refused: listing.refusedPairingAttempts,
      }).toEqual({
        name: row.name,
        pending: row.pending,
        created: row.created,
        reserved: row.reserved,
        refused: row.refused,
      });

      // The CLIENT's side: the carrier, then one byte-identical reject, then
      // `channel_rejected`, and nothing at all delivered to the RPC parser.
      // §11.2's row for a record that is absent, pending, or revoked is P12.
      expect(run.wire.payloadCount).toBe(2);
      expect(run.wire.response).toEqual([REJECT_HEX]);
      expect(run.wire.closes).toEqual(["channel_rejected"]);
      expect(run.wire.toParser).toBe(0);
      expect(run.channel.rows()).toEqual(["P12"]);
      expect(run.channel.session().mode()).toBe("closed");
      wires.push(run.wire);
    }

    // The equality this suite exists for, restated directly so it is legible as
    // a claim: an open window and a closed one are the same bytes, in the same
    // count, with the same close. It CANNOT fail on its own — the four literals
    // above pin every field of `Wire`, and `expect` throws — so it is
    // documentation of the invariant and the literals are what enforce it.
    expect(wires[0]).toEqual(wires[1]);
    expect(wires[2]).toEqual(wires[3]);
    expect(wires[0]).toEqual(wires[2]);
  });

  it("records the §13.4 safety number derived from the two identity keys", async () => {
    const run = await runPairing({ openWindow: true });
    const listing = await run.node.client.list();
    expect(listing.records).toHaveLength(1);
    const record = listing.records[0];

    // Derived here from the halves the node and the client each hold, so a node
    // that fed the wrong keys, origin, or account id into §13.4 produces a
    // different string rather than merely a differently shaped one.
    expect(record?.safetyNumber).toBe(
      deriveE2eeSafetyNumber({
        nodeIdentityPublicKey: run.advertisement.nodeIdentityPublicKey,
        clientIdentityPublicKey: CLIENT_IDENTITY_PUBLIC,
        hubOrigin: HUB_ORIGIN,
        accountId: ACCOUNT_ID,
      }).display,
    );
    expect(record?.fingerprintDisplay).toBe(CLIENT_FINGERPRINT_DISPLAY);
    // §13.6: a pending record carries the LEAST authority the §8.3 vocabulary
    // can express, so a read of it can never be why a channel was admitted.
    expect({
      status: record?.status,
      maxRole: record?.maxRole,
      capabilitySet: record?.capabilitySet,
    }).toEqual({ status: "pending", maxRole: "viewer", capabilitySet: [] });

    // §13.6: the derived display string and NEVER either raw key.
    const stored = JSON.stringify(await run.node.stored());
    expect(stored).not.toContain(Buffer.from(CLIENT_IDENTITY_PUBLIC).toString("base64url"));
    expect(stored).not.toContain(
      Buffer.from(run.advertisement.nodeIdentityPublicKey).toString("base64url"),
    );
  });

  it("records the channel.open role the device introduced itself under, as display only", async () => {
    // §8.3 makes a native client's intended role equal `channel.open`'s, so an
    // approval below it refuses the device instead of limiting it. The owner can
    // only approve the usable ceiling if the node kept the role it saw — taken
    // from the node's OWN `channel.open`, which is what the step-6 check reads.
    const run = await runPairing({});
    const [record] = (await run.node.client.list()).records;
    expect(record?.observedRole).toBe(clientChannel.channelOpenEffectiveRole);
    // …and it is metadata, not a grant: the record is still pending at the
    // least authority, and §8.6 step 6 still refuses it.
    expect({ status: record?.status, maxRole: record?.maxRole }).toEqual({
      status: "pending",
      maxRole: "viewer",
    });
    expect(run.node.client.lookupClientAuthorization(CLIENT_KEY)?.status).toBe("pending");
  });

  it("creates the record AFTER the reject and the close, and never before", async () => {
    const node = await pairingNode();
    await node.client.openPairingWindow(CLIENT_FINGERPRINT);
    const log: string[] = [];
    const surface = relaySurface(node.client, log, {});
    const ordered = await orderedSession(surface.authorization, log);

    await ordered.session.intercept(pairingHello(ordered.advertisement));
    await surface.settled();

    expect(log).toEqual([
      // §13.2 step 3 / §11.2: the caps and the window reservation, in memory,
      // with nothing emitted yet.
      "evaluate:admit",
      // The byte-identical fixed-size reject.
      `send:${REJECT_HEX}`,
      // Then the close — and only then the durable pending-class mutation.
      "close:channel_rejected",
      "commit",
    ]);
    expect((await node.client.list()).records).toHaveLength(1);
  });

  it("has both frames on the SOCKET before the durable commit begins", async () => {
    // The statement order above is necessary and not sufficient. `RelayChannelRegistry`
    // queues the close it schedules as a microtask of its own, so a commit made
    // in `runHandshake`'s own turn — after the `close` CALL and before the frame
    // — would satisfy every assertion in the test above while putting the
    // pending-class fsync back on the response path ahead of the close. That is
    // exactly the latency oracle §11.2 forbids: the fsync dwarfs the X25519 and
    // Ed25519 work above it, so "this key is not on file" and "the owner has a
    // window open" would be measurable from the wire. This reads the frames the
    // REAL registry has flushed at the instant the commit is invoked.
    const admitted = await runPairing({ openWindow: true });
    expect(admitted.commitWire).toEqual(["payloads=2,closes=1"]);
    // And on the cap refusal, which owes no durable write at all: §11.2 makes
    // the two indistinguishable, so the point at which the commit is reached
    // may not distinguish them either.
    const refused = await runPairing({ seed: { pending: [...SATURATED_PENDING] } });
    expect(refused.log).toEqual(["evaluate:refused", "commit"]);
    expect(refused.commitWire).toEqual(admitted.commitWire);
  });

  it("puts the same bytes at the same point when the commit throws or hangs", async () => {
    const succeeded = await runPairing({ openWindow: true });
    // A commit that throws synchronously and one that never settles are the same
    // benign availability event (§13.2): the client re-pairs, and neither may
    // reach the wire, delay it, or take the process down with it. A run that
    // gated the reject on the commit would not reach these assertions at all —
    // `deliver` would never resolve.
    const threw = await runPairing({ openWindow: true, commit: "throws" });
    const hung = await runPairing({ openWindow: true, commit: "hangs" });

    expect(threw.wire).toEqual(succeeded.wire);
    expect(hung.wire).toEqual(succeeded.wire);
    expect(succeeded.log).toEqual(["evaluate:admit", "commit"]);
    expect(threw.log).toEqual(["evaluate:admit", "commit"]);
    expect(hung.log).toEqual(["evaluate:admit", "commit"]);

    // The owner's side is the only thing that differs: the record the failed
    // commits owed was never written.
    expect((await succeeded.node.stored()).pending).toHaveLength(1);
    expect((await threw.node.stored()).pending).toHaveLength(0);
    expect((await hung.node.stored()).pending).toHaveLength(0);
  });

  it("refuses a saturated partition with no window open, and counts the refusal", async () => {
    const run = await runPairing({ seed: { pending: [...SATURATED_PENDING] } });
    const listing = await run.node.client.list();

    // §13.6's default outside a window is refuse-newest: nothing created,
    // nothing refreshed, nothing evicted.
    expect(listing.records).toHaveLength(E2EE_PENDING_CLIENTS_MAX_PER_ACCOUNT);
    expect(listing.records.map((record) => record.fingerprintDisplay)).not.toContain(
      CLIENT_FINGERPRINT_DISPLAY,
    );
    expect((await run.node.stored()).pending).toEqual([...SATURATED_PENDING]);
    // §13.6's display duty: a bounded, owner-clearable count, and the saturation
    // flag beside it, so the owner never has to infer either from record counts.
    expect(listing.refusedPairingAttempts).toBe(1);
    expect(listing.saturatedAccounts).toEqual([{ hubOrigin: HUB_ORIGIN, accountId: ACCOUNT_ID }]);
    run.node.client.clearRefusedPairingAttempts();
    expect((await run.node.client.list()).refusedPairingAttempts).toBe(0);
  });

  it("never lets an unapproved pairing attempt evict approved or revoked state", async () => {
    const approved = seededEntry(100, {
      maxRole: ROLE,
      capabilitySet: [CAPABILITY],
      approvedAt: NOW - 5_000,
    });
    const revoked = seededEntry(101, { revokedAt: NOW - 4_000 });
    const seed = { pending: [...SATURATED_PENDING], approved: [approved], revoked: [revoked] };

    // The owner-opened window is the ONLY rule that evicts anything, and §13.6
    // confines its victim to the pending class of the partition whose cap was
    // exceeded — structurally, because `selectPendingEviction` is handed
    // `pending` and can name nothing else.
    const withWindow = await runPairing({ seed, openWindow: true });
    const admitted = await withWindow.node.stored();
    expect(admitted.approved).toEqual([approved]);
    expect(admitted.revoked).toEqual([revoked]);
    // One in, one out: the partition is back at its cap and the victim was the
    // OLDEST eligible pending record, which is seed 0.
    expect(admitted.pending).toHaveLength(E2EE_PENDING_CLIENTS_MAX_PER_ACCOUNT);
    expect(admitted.pending.map((entry) => entry.clientIdentityFingerprint)).not.toContain(
      seededFingerprint(0),
    );
    expect(admitted.pending.map((entry) => entry.clientIdentityFingerprint)).toContain(
      CLIENT_FINGERPRINT_STORED,
    );

    // Without a window the attempt reaches no record of any class at all.
    const refused = await runPairing({ seed });
    const untouched = await refused.node.stored();
    expect(untouched.approved).toEqual([approved]);
    expect(untouched.revoked).toEqual([revoked]);
    expect(untouched.pending).toEqual([...SATURATED_PENDING]);
  });

  it("does not make a revoked client pending again", async () => {
    const revoked = seededEntry(0, {
      clientIdentityFingerprint: CLIENT_FINGERPRINT_STORED,
      revokedAt: NOW - 4_000,
    });
    // The owner even has a window open, naming this very device: §13.6 grants it
    // the reservation and the reservation still creates nothing, because a key
    // with a record in ANY class is not first-seen and re-creating it would
    // resurrect exactly the decision the owner made.
    const run = await runPairing({ seed: { revoked: [revoked] }, openWindow: true });

    expect(run.log).toEqual(["evaluate:existing", "commit"]);
    const listing = await run.node.client.list();
    expect(listing.records).toHaveLength(1);
    expect(listing.records[0]?.status).toBe("revoked");
    expect((await run.node.stored()).pending).toEqual([]);
    expect(run.wire.response).toEqual([REJECT_HEX]);
    expect(run.channel.rows()).toEqual(["P12"]);
    // §13.6: the reservation is spent by the first attempt that matches the
    // discriminator whatever that attempt's outcome, so the CLI can tell "my
    // device has not reached the node" from "it did, and nothing came of it".
    //
    // BOTH HALVES, because the listing's `spent` is satisfied by the in-memory
    // latch alone — which `evaluatePairingAdmission` sets before any commit
    // runs. Only the durable stamp survives a restart, and without it the next
    // matching attempt is handed the reservation a second time.
    expect(listing.pairingWindow?.spent).toBe(true);
    expect((await run.node.stored()).pairingWindow?.spentAt).toBe(NOW);
  });

  it("spends the window on an APPROVED device's successful handshake too", async () => {
    // §13.6 spends the reservation on "the first attempt that matches the
    // discriminator, whatever that attempt's outcome" — and an accept is such an
    // outcome. Nothing about the success path is refused, so this is the only
    // §13.2 step 3 commit whose whole occasion is the window: without it the
    // durable window stays open for the rest of `E2EE_PAIRING_WINDOW`, and after
    // a restart — or from a CLI in another process, which does not see this
    // process's latch — the next matching attempt is granted the reservation
    // again. That reservation is the token that licenses evicting a pending
    // record.
    const node = await pairingNode({
      approved: [
        seededEntry(0, {
          clientIdentityFingerprint: CLIENT_FINGERPRINT_STORED,
          maxRole: ROLE,
          capabilitySet: [CAPABILITY],
          approvedAt: NOW - 5_000,
        }),
      ],
    });
    await node.client.openPairingWindow(CLIENT_FINGERPRINT);
    const log: string[] = [];
    const surface = relaySurface(node.client, log, {});
    const channel = await harness({ authorization: surface.authorization });

    await establish(channel, "native", await channel.open());
    await surface.settled();

    expect(channel.session().mode()).toBe("e2ee");
    expect(log).toEqual(["evaluate:existing", "commit"]);
    expect((await node.stored()).pairingWindow?.spentAt).toBe(NOW);
    // And the record set is otherwise untouched: an approved key is not
    // first-seen, so §13.2 creates nothing for it.
    expect((await node.stored()).pending).toEqual([]);
  });

  it("keeps a local failure's pending record, still after the reject and the close", async () => {
    // The §4.5 ceiling, an encoder refusing material this node holds, key
    // custody refusing the borrow: all land after §8.6 step 6 has already taken
    // the §13.2 step 3 decision, and §11.2's table names no row for any of them.
    // The decision is still owed to the owner — §13.2 makes the commit
    // best-effort, so dropping it costs the owner both the attempt and the
    // window spend, and their `ryco e2ee clients` listing shows neither.
    const run = await runPairing({ openWindow: true, failLocally: true });

    expect(run.log).toEqual(["evaluate:admit", "commit"]);
    expect(run.channel.rows()).toEqual(["local"]);
    // The wire is the same generic reject every other pre-key cause takes, and
    // the commit still starts only once both frames are on the socket.
    expect(run.wire.response).toEqual([REJECT_HEX]);
    expect(run.wire.closes).toEqual(["channel_rejected"]);
    expect(run.commitWire).toEqual(["payloads=2,closes=1"]);
    const stored = await run.node.stored();
    expect(stored.pending.map((entry) => entry.clientIdentityFingerprint)).toEqual([
      CLIENT_FINGERPRINT_STORED,
    ]);
    expect(stored.pairingWindow?.spentAt).toBe(NOW);
  });

  it("lets the §13.2 step 3 decision throw without touching either wire outcome", async () => {
    // §11.2's anti-oracle rule governs the WIRE. The pending record and the
    // operator listing are the owner's side of the same event and MUST NOT
    // alter it, so a bookkeeping failure may neither turn an admitted handshake
    // into a fatal one nor vary the reject an unapproved one already takes.
    const approvedNode = await pairingNode({
      approved: [
        seededEntry(0, {
          clientIdentityFingerprint: CLIENT_FINGERPRINT_STORED,
          maxRole: ROLE,
          capabilitySet: [CAPABILITY],
          approvedAt: NOW - 5_000,
        }),
      ],
    });
    const approvedLog: string[] = [];
    const approvedSurface = relaySurface(approvedNode.client, approvedLog, {
      evaluate: "throws",
    });
    const approvedChannel = await harness({ authorization: approvedSurface.authorization });
    await establish(approvedChannel, "native", await approvedChannel.open());
    await approvedSurface.settled();

    // The accept is unchanged, and no commit was reached — the throw cost the
    // decision, which is the whole of what it may cost.
    expect(approvedChannel.session().mode()).toBe("e2ee");
    expect(approvedLog).toEqual(["evaluate:throw"]);

    const unapprovedNode = await pairingNode();
    await unapprovedNode.client.openPairingWindow(CLIENT_FINGERPRINT);
    const unapprovedLog: string[] = [];
    const unapprovedSurface = relaySurface(unapprovedNode.client, unapprovedLog, {
      evaluate: "throws",
    });
    const unapprovedChannel = await harness({ authorization: unapprovedSurface.authorization });
    await unapprovedChannel.deliver(pairingHello(await unapprovedChannel.open()));
    await unapprovedSurface.settled();

    // Byte for byte the reject §11.2 row P12 already required, and the owner's
    // side simply gained nothing.
    expect(wireOf(unapprovedChannel)).toEqual({
      payloadCount: 2,
      response: [REJECT_HEX],
      closes: ["channel_rejected"],
      toParser: 0,
    });
    expect(unapprovedChannel.rows()).toEqual(["P12"]);
    expect(unapprovedLog).toEqual(["evaluate:throw"]);
    expect((await unapprovedNode.stored()).pending).toEqual([]);
  });

  it("lets an approval take effect on a fresh handshake and never on the paired channel", async () => {
    const node = await pairingNode();
    await node.client.openPairingWindow(CLIENT_FINGERPRINT);
    const log: string[] = [];
    const surface = relaySurface(node.client, log, {});

    const paired = await harness({ authorization: surface.authorization });
    await paired.deliver(pairingHello(await paired.open()));
    await surface.settled();
    expect((await node.client.list()).records[0]?.status).toBe("pending");

    // §13.2 step 5, on the record the ceremony wrote.
    await node.client.approve({
      key: CLIENT_KEY,
      maxRole: ROLE,
      capabilitySet: [CAPABILITY],
    });
    expect((await node.client.list()).records[0]?.status).toBe("approved");

    // §13.2 step 6: approval never retroactively authorizes the pairing channel.
    // It closed at the reject and it stays closed, carrying no payload either
    // way, and the approval added no byte to its wire.
    expect(paired.session().mode()).toBe("closed");
    expect(paired.deliveredToParser).toHaveLength(0);
    const pairedWire = wireOf(paired);
    expect(pairedWire.payloadCount).toBe(2);
    expect(pairedWire.response).toEqual([REJECT_HEX]);
    expect(pairedWire.closes).toEqual(["channel_rejected"]);

    // A FRESH ticket, channel, and handshake is what sees it.
    const fresh = await harness({ authorization: surface.authorization });
    await establish(fresh, "native", await fresh.open());
    expect(fresh.session().mode()).toBe("e2ee");
  });
});

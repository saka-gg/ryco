import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";

import { EnvironmentId, ORCHESTRATION_WS_METHODS, WsRpcGroup } from "@ryco/contracts";
import { type HubSessionFrame } from "@ryco/contracts/hub-session";
import {
  RELAY_INITIAL_LIMITS,
  RELAY_PROTOCOL_MINOR,
  type RelayChannelId,
  type RelayFrame,
} from "@ryco/contracts/relay";
import { decodeHubSessionFrame, encodeHubSessionFrame } from "@ryco/shared/hubSessionCodec";
import { decodeRelayFrame, encodeRelayFrame } from "@ryco/shared/relayCodec";
import { E2EE_PREKEY_LIFETIME } from "@ryco/shared/relayE2eeConstants";
import { deriveE2eeAgreementPublicKey } from "@ryco/shared/relayE2eeKeys";
import { encodeNodeE2eePrekeyTranscript } from "@ryco/shared/relayE2eeTranscripts";
import { Effect, Exit, Scope, Stream } from "effect";
import { vi } from "vite-plus/test";

import { makeNodeE2eeCapabilityStatementClient } from "../../hubIdentity/NodeE2eeCapabilityStatement.ts";
import type { NodeE2eePrekeyCertificate } from "../../hubIdentity/NodeE2eePrekeyClient.ts";
import { makeRpcByteSession } from "../../ws/RpcByteSession.ts";
import { ORCHESTRATION_SHELL_SNAPSHOT_PAGE_MAX_BYTES } from "../../ws/context/constants.ts";
import { pageShellSnapshot } from "../../ws/context/shellSnapshotPages.ts";
import { RelayResponseCompressor } from "../../ws/relayResponseCompression.ts";
import { makeNodeE2eeChannelAdvertiser } from "../NodeE2eeChannelAdvertiser.ts";
import {
  makeNodeE2eeChannelSession,
  makeNodeE2eeHandshakeRateLimiter,
} from "../NodeE2eeChannelSession.ts";
import {
  makeNodeE2eeRelayChannelSession,
  nodeE2eeChannelPlaintextCeiling,
  nodeE2eeRpcInterceptor,
  nodeE2eeRpcSink,
} from "../NodeE2eeRelayChannel.ts";
import { RelayChannelRegistry } from "../RelayChannelRegistry.ts";
import { RelaySendQueue } from "../RelaySendQueue.ts";
import {
  APPROVED,
  PERMISSIVE_POLICY,
  SPKI_PREFIX,
  authorizationFor,
  permissiveRegistration,
} from "./nodeE2eeChannelHarness.ts";

// An in-process model of a hosted browser talking to several nodes through a
// Hub, built to count what opening a node costs: Hub frames, bytes, and the
// relay round trips before the browser has accepted the node's shell.
//
// WHAT IS REAL
// - The browser side is the production web client: the hosted store and
//   controller, the account-session socket, the relay engine, the E2EE NX
//   initiator and the RPC client. It is loaded from the web sources by URL, so
//   the server package needs no dependency on the web app.
// - Each node is a production node stack: a relay channel registry over a send
//   queue, the E2EE advertiser and channel session (the carrier statement, the
//   NX responder and the record layer), and an RPC byte session over the real
//   RPC group with the shell and thread-window streams served from seeded data.
//   Every node has its own identity, prekey and shell.
//
// WHAT IS FAKED
// - The Hub only routes: it answers `openNode` the way the real one does (relay
//   `ready`, then `channel.open` to both ends), forwards every relay frame
//   verbatim by channel, and ends a node channel when its stream ends. It never
//   reads, rewrites or originates application bytes.
// - Time is virtual. Every frame crossing a hop (browser to Hub, Hub to node,
//   and back) is delivered `hopDelayMs` later on a discrete-event clock, and the
//   clock only moves once the process has gone quiet, so a node open costs the
//   same virtual time on every run. Only `Date` is replaced; real timers run
//   untouched, so a reconnect backoff costs real time and no virtual time.
// - Quiet means a few macrotasks with no frame scheduled, which work that
//   finishes after an unpredictable amount of real time would outlast: a
//   compression or inflation on the libuv threadpool lands whenever the machine
//   gets to it. Both ends therefore use synchronous stand-ins that produce the
//   same bytes (the node's deflate, the browser's `DecompressionStream`), so
//   nothing on the open path runs on real time.
//
// Only one harness can be live at a time: it replaces process-wide state (the
// clock, the browser globals and the web client's module singletons).
//
// A relay round trip between the browser and a node therefore takes four hops,
// which is where `relayRoundTrips = elapsed / (4 * hopDelayMs)` comes from.

const HUB_ORIGIN = "https://hub.example.test";
const ACCOUNT_ID = `acct_${"a".repeat(22)}`;
const SESSION_ID = `sess_${"s".repeat(22)}`;
const RELAY_VERSION = { protocolMajor: 1, protocolMinor: RELAY_PROTOCOL_MINOR } as const;
const HUB_MAX_CHANNELS = 8;
const CLOCK_EPOCH_MS = Date.UTC(2026, 6, 20);
const SESSION_LIFETIME_MS = 60 * 60 * 1_000;
/** Macrotasks with no new frame in flight before the process counts as quiet. */
const QUIET_TICKS = 3;
const DEFAULT_REAL_TIME_BUDGET_MS = 15_000;
const THREAD_WINDOW_LIMITS = { messages: 50, proposedPlans: 10, activities: 50, checkpoints: 10 };
const TIMESTAMP = "2026-07-18T00:00:00.000Z";

export interface HostedMultiNodeHarnessOptions {
  /** How many nodes the Hub knows, each with its own identity and shell. */
  readonly nodes: number;
  /** One-way delay of every hop; a browser-to-node round trip crosses four. */
  readonly hopDelayMs?: number;
  /** Threads in each node's shell. */
  readonly threadsPerNode?: number;
  /**
   * The channel handshake. Only the NX handshake the web client runs against a
   * node is wired, so anything else is rejected; a channel that falls back to
   * plaintext fails the open.
   */
  readonly e2ee?: "nx";
  /** Byte budget of one shell message; defaults to the node's production budget. */
  readonly shellPageMaxBytes?: number;
  /**
   * How a node reads its shell for each subscription; the seeded shell as it is by default. A
   * test can put a shell memo, with a build it counts, in front of the seeded shell.
   */
  readonly readShell?: (
    nodeIndex: number,
    seeded: HostedNodeShellSnapshot,
  ) => Effect.Effect<HostedNodeShellSnapshot>;
}

export interface HubTraffic {
  readonly frames: number;
  readonly bytes: number;
}

/** The Hub's view of one relay channel, with the virtual time of each milestone. */
export interface ChannelTrace {
  readonly nodeIndex: number;
  readonly nodeId: string;
  readonly channelId: string;
  readonly streamId: number;
  /** The browser sent `openNode`; every other timestamp is when the browser got its frame. */
  readonly openNodeSentAt: number;
  readonly relayReadyAt: number | null;
  readonly channelOpenAt: number | null;
  readonly channelAcceptAt: number | null;
  /** The first relay `data` frame the node sent: the E2EE capability carrier. */
  readonly firstDataAt: number | null;
  readonly shellAcceptedAt: number | null;
  readonly firstThreadWindowItemAt: number | null;
  readonly closedAt: number | null;
  /** Messages the node split this channel's shell into; each past the first costs a round trip. */
  readonly shellPages: number;
  // The four per-channel counters below count relay frames, and their bytes are
  // the encoded relay frame. The global `browserToHub` and `hubToBrowser`
  // counters count the Hub session frame around each relay frame (and the
  // session frames that carry none), so they run higher than the channels'
  // sum; the global `hubToNode` and `nodeToHub` counters count relay frames, so
  // the channels' counters are part of them.
  /** Relay frames the browser sent the Hub on this channel. */
  readonly fromBrowser: HubTraffic;
  /** Relay frames the Hub carried to the node on this channel. */
  readonly toNode: HubTraffic;
  /** Relay frames the node sent the Hub on this channel. */
  readonly fromNode: HubTraffic;
  /** Relay frames the Hub carried to the browser on this channel. */
  readonly toBrowser: HubTraffic;
}

type Writable<T> = { -readonly [K in keyof T]: T[K] };

type TraceTraffic = "fromBrowser" | "toNode" | "fromNode" | "toBrowser";

/** A trace while it is still being filled in. */
interface TraceState extends Writable<Omit<ChannelTrace, TraceTraffic>> {
  fromBrowser: Writable<HubTraffic>;
  toNode: Writable<HubTraffic>;
  fromNode: Writable<HubTraffic>;
  toBrowser: Writable<HubTraffic>;
}

const exposeTrace = (trace: TraceState): ChannelTrace => ({
  ...trace,
  fromBrowser: { ...trace.fromBrowser },
  toNode: { ...trace.toNode },
  fromNode: { ...trace.fromNode },
  toBrowser: { ...trace.toBrowser },
});

export interface HostedMultiNodeCounters {
  /** Hub session frames the browser sent, bytes included: `openNode`, `data`, `close`, `ping`. */
  readonly browserToHub: HubTraffic;
  /** Hub session frames the Hub sent the browser, bytes included. */
  readonly hubToBrowser: HubTraffic;
  /** Relay frames the Hub forwarded to nodes. */
  readonly hubToNode: HubTraffic;
  /** Relay frames nodes sent the Hub. */
  readonly nodeToHub: HubTraffic;
  /** All four directions. */
  readonly total: HubTraffic;
  readonly openNodeFrames: number;
  /** Relay `channel.open` frames the Hub delivered to nodes. */
  readonly channelsOpened: number;
  /** Relay tickets requested over HTTP; zero while the Hub authenticates channels itself. */
  readonly ticketRequests: number;
  /** Account-session sockets the browser opened to the Hub. */
  readonly accountSocketsOpened: number;
  /** Failures a node's registry reported while handling Hub frames. */
  readonly nodeErrors: readonly string[];
  readonly channels: readonly ChannelTrace[];
}

export interface HostedNodeOpenResult {
  readonly nodeIndex: number;
  readonly nodeId: string;
  /** What the node channel actually negotiated, observed on the node. */
  readonly e2ee: "nx" | "legacy";
  readonly hopDelayMs: number;
  /** Hub frames and bytes from the start of the call until the node was open. */
  readonly frames: number;
  readonly bytes: number;
  /** Everything the call put on the wire, by direction. */
  readonly traffic: Pick<
    HostedMultiNodeCounters,
    | "browserToHub"
    | "hubToBrowser"
    | "hubToNode"
    | "nodeToHub"
    | "openNodeFrames"
    | "channelsOpened"
  >;
  /** Messages the shell travelled in. */
  readonly shellPages: number;
  /** Virtual milliseconds from `openNode` sent to the shell accepted. */
  readonly shellAcceptedMs: number;
  /** `shellAcceptedMs / (4 * hopDelayMs)`; `null` without a hop delay. */
  readonly relayRoundTrips: number | null;
  /** Virtual milliseconds from `openNode` sent to each milestone. */
  readonly milestonesMs: {
    readonly relayReady: number;
    readonly channelAccept: number;
    readonly firstData: number;
    readonly shellAccepted: number;
    readonly firstThreadWindowItem: number;
  };
  /** The shell the browser accepted: proves it came from this node. */
  readonly shell: { readonly projectIds: readonly string[]; readonly threadCount: number };
  readonly trace: ChannelTrace;
}

/** One frame as the Hub saw it, in the order it was sent. */
export interface WireFrame {
  /** Virtual time the sender transmitted it. */
  readonly at: number;
  readonly direction: "browser-to-hub" | "hub-to-browser" | "hub-to-node" | "node-to-hub";
  /** The relay frame type for relay traffic, else the Hub session frame type. */
  readonly type: string;
  readonly bytes: number;
  readonly channelId: string | null;
}

export interface HostedMultiNodeHarness {
  readonly hopDelayMs: number;
  readonly nodeIds: readonly string[];
  /** Open a node from nothing: no session may be active. */
  readonly openNode: (nodeIndex: number) => Promise<HostedNodeOpenResult>;
  /**
   * Switch the selection to a node. The harness drives a plain web transport
   * that holds one selection, and closes the active session itself before it
   * opens the target from scratch; the result counts the teardown as well. This
   * is a channel-level model: the web runtime's own node selection (and any
   * warm set it keeps) is not loaded, so it says nothing about what that
   * runtime would do on a switch.
   */
  readonly switchTo: (nodeIndex: number) => Promise<HostedNodeOpenResult>;
  /**
   * The Hub ends the active node channel once while the account socket stays
   * up, and the client recovers. The result describes the replacement channel
   * and counts everything from the drop.
   */
  readonly dropChannel: () => Promise<HostedNodeOpenResult>;
  readonly counters: () => HostedMultiNodeCounters;
  /** Every frame since the last `reset`, for diagnosing a count that moved. */
  readonly wire: () => readonly WireFrame[];
  /**
   * Start a new measurement window: counters return to zero, closed traces are
   * forgotten, and the per-channel counters of the channels still open restart.
   */
  readonly reset: () => void;
  /** Virtual milliseconds since the harness was created. */
  readonly now: () => number;
  readonly dispose: () => Promise<void>;
}

/** One line per open, for test output. */
export function formatHostedNodeOpen(result: HostedNodeOpenResult): string {
  const roundTrips = result.relayRoundTrips === null ? "n/a" : String(result.relayRoundTrips);
  return [
    `node ${result.nodeIndex}`,
    `e2ee=${result.e2ee}`,
    `hop=${result.hopDelayMs}ms`,
    `hubFrames=${result.frames}`,
    `hubBytes=${result.bytes}`,
    `pages=${result.shellPages}`,
    `relayRoundTrips=${roundTrips}`,
    `shellAccepted=${result.shellAcceptedMs}ms`,
  ].join(" ");
}

// ---------------------------------------------------------------------------
// Virtual clock
// ---------------------------------------------------------------------------

interface ScheduledEvent {
  readonly at: number;
  readonly order: number;
  readonly run: () => void;
}

const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A discrete-event clock. Frames are scheduled with a delay and run in time
 * order; time only advances when nothing is left to do at the current instant,
 * which `drive` decides by waiting for the process to go quiet.
 */
class VirtualClock {
  #now = 0;
  #order = 0;
  #scheduled = 0;
  readonly #pending: ScheduledEvent[] = [];
  readonly #onAdvance: (now: number) => void;

  constructor(onAdvance: (now: number) => void) {
    this.#onAdvance = onAdvance;
  }

  get now(): number {
    return this.#now;
  }

  schedule(delayMs: number, run: () => void): void {
    const event = { at: this.#now + delayMs, order: this.#order++, run };
    let index = this.#pending.length;
    while (index > 0) {
      const previous = this.#pending[index - 1]!;
      if (previous.at < event.at || (previous.at === event.at && previous.order < event.order)) {
        break;
      }
      index -= 1;
    }
    this.#pending.splice(index, 0, event);
    this.#scheduled += 1;
  }

  /** Let every promise chain and zero-delay timer that is ready run to its end. */
  async #settle(): Promise<void> {
    let quiet = 0;
    while (quiet < QUIET_TICKS) {
      const before = this.#scheduled;
      await macrotask();
      quiet = this.#scheduled === before ? quiet + 1 : 0;
    }
  }

  /**
   * Run the simulation until `done`. With frames in flight the clock jumps to
   * the next one; with none, the process is waiting on a real timer (a
   * reconnect backoff), so real time passes and virtual time stands still.
   */
  async drive(
    done: () => boolean,
    describe: () => string,
    realTimeBudgetMs = DEFAULT_REAL_TIME_BUDGET_MS,
  ): Promise<void> {
    const startedAt = performance.now();
    while (!done()) {
      await this.#settle();
      if (done()) return;
      const next = this.#pending[0];
      if (next === undefined) {
        if (performance.now() - startedAt > realTimeBudgetMs) {
          throw new Error(
            `Hosted harness stalled at ${this.#now}ms with no frame in flight. ${describe()}`,
          );
        }
        continue;
      }
      if (next.at > this.#now) {
        this.#now = next.at;
        this.#onAdvance(this.#now);
      }
      while (this.#pending[0] !== undefined && this.#pending[0].at <= this.#now) {
        this.#pending.shift()!.run();
      }
    }
  }

  /** Let every frame in flight land, and whatever those frames cause, until none is left. */
  async quiesce(describe: () => string): Promise<void> {
    await this.#settle();
    await this.drive(() => this.#pending.length === 0, describe);
  }
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

function toBytes(value: string | ArrayBufferLike | Blob | ArrayBufferView): Uint8Array {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return Uint8Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  throw new Error("Unexpected Blob write in the hosted multi-node harness.");
}

function encodeRelay(frame: RelayFrame): Uint8Array {
  const encoded = encodeRelayFrame(frame);
  if (!encoded.ok) throw new Error("Test relay frame could not be encoded.");
  return encoded.value;
}

function encodeOuter(frame: HubSessionFrame): Uint8Array {
  const encoded = encodeHubSessionFrame(frame);
  if (!encoded.ok) throw new Error("Test Hub session frame could not be encoded.");
  return Uint8Array.from(encoded.value);
}

const emptyTraffic = (): { frames: number; bytes: number } => ({ frames: 0, bytes: 0 });

function count(traffic: { frames: number; bytes: number }, bytes: number): void {
  traffic.frames += 1;
  traffic.bytes += bytes;
}

/** Fixed-width identifier tails that satisfy the contracts' id patterns. */
const idSuffix = (index: number): string => index.toString(36).padStart(22, "a");
const nodeIdFor = (index: number): string => `node_${idSuffix(index)}`;

// ---------------------------------------------------------------------------
// Seeded node data
// ---------------------------------------------------------------------------

function shellThread(projectId: string, nodeIndex: number, index: number) {
  return {
    id: `thread-${nodeIndex}-${index}`,
    projectId,
    title: `Node ${nodeIndex} thread ${index}`,
    modelSelection: { instanceId: "codex", model: "gpt-5-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: `feature/node-${nodeIndex}-${index}`,
    worktreePath: null,
    latestTurn: null,
    goal: null,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

/** The shell a node serves: one project and its threads. */
export type HostedNodeShellSnapshot = ReturnType<typeof nodeShellSnapshot>;

function nodeShellSnapshot(nodeIndex: number, threadCount: number) {
  const projectId = `project-node-${nodeIndex}`;
  return {
    snapshotSequence: 0,
    projects: [
      {
        id: projectId,
        title: `Node ${nodeIndex} project`,
        workspaceRoot: `/workspace/node-${nodeIndex}`,
        defaultModelSelection: null,
        scripts: [],
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
    ],
    worktrees: [],
    threads: Array.from({ length: threadCount }, (_, index) =>
      shellThread(projectId, nodeIndex, index),
    ),
    updatedAt: TIMESTAMP,
  };
}

const EMPTY_HISTORY_PAGE = { oldestCursor: null, newestCursor: null, hasMoreBefore: false };

function nodeThreadWindowSnapshot(nodeIndex: number) {
  const snapshot = nodeShellSnapshot(nodeIndex, 1);
  return {
    kind: "snapshot" as const,
    snapshot: {
      snapshotSequence: 0,
      thread: {
        ...snapshot.threads[0]!,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
      },
      history: {
        messages: EMPTY_HISTORY_PAGE,
        proposedPlans: EMPTY_HISTORY_PAGE,
        activities: EMPTY_HISTORY_PAGE,
        checkpoints: EMPTY_HISTORY_PAGE,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

interface NodeChannelState {
  readonly mode: () => "negotiating" | "e2ee" | "legacy" | "closed";
}

interface FakeNode {
  readonly index: number;
  readonly id: string;
  readonly channels: Map<string, NodeChannelState>;
  readonly errors: string[];
  /** Hand the node one relay frame, in arrival order, as a connection would. */
  readonly deliver: (frame: RelayFrame) => void;
  readonly close: () => Promise<void>;
}

/**
 * The §5.2 statement source of one node. The shared E2EE test harness builds
 * its statement from module-level constants, so every node there would be the
 * same node; here each one has its own identity, prekey and agreement key.
 */
function makeNodeStatements(index: number, now: () => number) {
  const suffix = idSuffix(index);
  const nodeId = nodeIdFor(index);
  const identityKeyId = `nkey_${suffix}`;
  const prekeyId = `epk_${suffix}`;
  const continuityId = `nct_${suffix}`;
  const agreementSecret = Uint8Array.from(
    createHash("sha256").update(`hosted-multi-node-agreement-${index}`).digest(),
  );
  const agreementPublicKey = deriveE2eeAgreementPublicKey(agreementSecret);
  const { privateKey } = generateKeyPairSync("ed25519");
  const der = Buffer.from(privateKey.export({ format: "der", type: "pkcs8" }));
  const identityPublicKey = Uint8Array.from(
    createPublicKey(privateKey)
      .export({ format: "der", type: "spki" })
      .subarray(SPKI_PREFIX.byteLength),
  );
  const signBytes = (message: Uint8Array): Uint8Array =>
    Uint8Array.from(
      sign(null, message, createPrivateKey({ key: der, format: "der", type: "pkcs8" })),
    );
  const createdAt = now() - 60_000;
  const expiresAt = createdAt + E2EE_PREKEY_LIFETIME;
  const prekey: NodeE2eePrekeyCertificate = {
    hubOrigin: HUB_ORIGIN,
    nodeId,
    identityKeyId,
    prekeyId,
    agreementPublicKey,
    createdAt,
    expiresAt,
    crossSignature: signBytes(
      encodeNodeE2eePrekeyTranscript({
        hubOrigin: HUB_ORIGIN,
        nodeId,
        identityKeyId,
        prekeyId,
        identityPublicKey,
        agreementPublicKey,
        createdAt,
        expiresAt,
      }),
    ),
  };
  const statements = makeNodeE2eeCapabilityStatementClient({
    identity: async () => ({
      nodeId,
      identityKeyId,
      identityPublicKey,
      sign: async (envelope) => signBytes(envelope),
    }),
    prekey: async () => prekey,
    continuity: async () => ({ continuityId, chain: [] }),
    policy: () => PERMISSIVE_POLICY,
    generation: () => 3,
    now,
  });
  return {
    nodeId,
    statements,
    withPrekeySecret: async <A>(
      requestedPrekeyId: string,
      use: (secretKey: Uint8Array) => Promise<A> | A,
    ): Promise<A> => {
      if (requestedPrekeyId !== prekeyId) throw new Error("Unknown prekey requested.");
      return use(agreementSecret);
    },
  };
}

interface FakeNodeOptions {
  readonly index: number;
  readonly threadsPerNode: number;
  readonly shellPageMaxBytes: number;
  /** The Hub link: where the node's outbound relay bytes go. */
  readonly sendToHub: (node: FakeNode, bytes: Uint8Array) => void;
  /** Called once per channel with the number of messages its shell travelled in. */
  readonly onShellServed: (channelId: string, pages: number) => void;
  readonly readShell: HostedMultiNodeHarnessOptions["readShell"];
  readonly now: () => number;
}

/**
 * One node as the connector builds it: a registry over a send queue, with each
 * channel an E2EE session and an RPC byte session bound to it the way the
 * connector binds them.
 */
function createFakeNode(options: FakeNodeOptions): FakeNode {
  const { index } = options;
  const source = makeNodeStatements(index, options.now);
  const channels = new Map<string, NodeChannelState>();
  const errors: string[] = [];
  const scopes: Scope.Closeable[] = [];
  const shell = nodeShellSnapshot(index, options.threadsPerNode);
  const readShell = (): Effect.Effect<HostedNodeShellSnapshot> =>
    options.readShell?.(index, shell) ?? Effect.succeed(shell);
  const threadWindow = nodeThreadWindowSnapshot(index);
  const ceiling = nodeE2eeChannelPlaintextCeiling(RELAY_INITIAL_LIMITS);
  const rateLimiter = makeNodeE2eeHandshakeRateLimiter();
  const advertiser = makeNodeE2eeChannelAdvertiser({
    hubOrigin: HUB_ORIGIN,
    readAdvertisement: (hubOrigin) => source.statements.advertised(hubOrigin),
    policy: () => PERMISSIVE_POLICY,
    recordFallback: async () => undefined,
  });
  // The same bytes the node's compressor produces, without the threadpool hop
  // that would make the order of events depend on real time.
  const compressor = new RelayResponseCompressor({
    maxMessageBytes: ceiling,
    deflate: async (message) => new Uint8Array(deflateRawSync(message, { level: 1 })),
  });

  const sendQueue = new RelaySendQueue(
    { bufferedAmount: 0, send: (bytes) => options.sendToHub(node, Uint8Array.from(bytes)) },
    RELAY_INITIAL_LIMITS,
  );
  const registry = new RelayChannelRegistry({
    limits: RELAY_INITIAL_LIMITS,
    protocol: RELAY_VERSION,
    sendQueue,
    onOutboundReady: () => sendQueue.flush(),
    factory: {
      connectionReady: ({ limits }) =>
        advertiser.connectionReady({ maxDataChunkBytes: limits.maxDataChunkBytes }),
      open: async ({
        channelId,
        capability,
        effectiveRole,
        protocolMajor,
        protocolMinor,
        send,
        admit,
        close,
      }) => {
        const announcement = await advertiser.openChannel();
        const e2ee = makeNodeE2eeChannelSession({
          channel: {
            hubOrigin: HUB_ORIGIN,
            channelId,
            relayProtocolMajor: protocolMajor,
            relayProtocolMinor: protocolMinor,
            channelOpenCapability: capability,
            channelOpenEffectiveRole: effectiveRole,
          },
          announcement,
          plaintextCeiling: ceiling,
          send,
          admit,
          close,
          policy: () => PERMISSIVE_POLICY,
          registerPolicyChannel: permissiveRegistration,
          authorization: authorizationFor(APPROVED),
          withPrekeySecret: source.withPrekeySecret,
          rateLimiter,
          now: options.now,
          recordPeerLegacyFallback: () => undefined,
        });
        channels.set(channelId, { mode: () => e2ee.mode() });
        const handlers = WsRpcGroup.toLayer(
          Effect.succeed(
            WsRpcGroup.of({
              [ORCHESTRATION_WS_METHODS.subscribeShell]: (input: {
                readonly snapshotDelivery?: "paged";
              }) =>
                Stream.unwrap(
                  Effect.map(readShell(), (snapshot): Stream.Stream<unknown> => {
                    if (input.snapshotDelivery !== "paged") {
                      options.onShellServed(channelId, 1);
                      return Stream.concat(
                        Stream.succeed({ kind: "snapshot" as const, snapshot }),
                        Stream.never,
                      );
                    }
                    const messages = pageShellSnapshot(
                      snapshot as never,
                      options.shellPageMaxBytes,
                    );
                    options.onShellServed(channelId, messages.length);
                    return Stream.concat(Stream.fromArrays(...messages), Stream.never);
                  }),
                ),
              [ORCHESTRATION_WS_METHODS.subscribeThreadWindow]: () =>
                Stream.concat(Stream.succeed(threadWindow), Stream.never),
            } as never),
          ),
        );
        const scope = await Effect.runPromise(Scope.make("sequential"));
        scopes.push(scope);
        try {
          const session = await Effect.runPromise(
            makeRpcByteSession(WsRpcGroup, handlers, nodeE2eeRpcSink(e2ee), {
              queueCapacity: 64,
              interceptor: nodeE2eeRpcInterceptor(e2ee),
              onOutputFailure: () => e2ee.abandon(),
              compressor,
            }).pipe(Effect.provideService(Scope.Scope, scope)),
          );
          return makeNodeE2eeRelayChannelSession({
            e2ee,
            rpc: {
              receive: (bytes) => Effect.runPromise(session.receive(bytes)),
              queuedBytes: () => Effect.runPromise(session.queuedBytes),
              supportsChunkedMessages: session.supportsChunkedMessages,
              incompleteReassembly: session.incompleteReassembly,
            },
            release: () => Effect.runPromise(Scope.close(scope, Exit.void)),
          });
        } catch (error: unknown) {
          e2ee.dispose();
          await Effect.runPromise(Scope.close(scope, Exit.void));
          throw error;
        }
      },
    },
  });

  // A connection hands its registry one frame at a time.
  let inbound: Promise<void> = Promise.resolve();
  const node: FakeNode = {
    index,
    id: source.nodeId,
    channels,
    errors,
    deliver: (frame) => {
      inbound = inbound
        .then(() => registry.handle(frame))
        .catch((error: unknown) => {
          errors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
        });
    },
    close: async () => {
      await inbound;
      await registry.closeAll();
      for (const scope of scopes) await Effect.runPromise(Scope.close(scope, Exit.void));
    },
  };
  return node;
}

// ---------------------------------------------------------------------------
// The browser's side of the account socket, and the Hub behind it
// ---------------------------------------------------------------------------

class FakeBrowserSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeBrowserSocket.CONNECTING;
  bufferedAmount = 0;
  binaryType = "blob";
  readonly offeredVersion2: boolean;
  readonly #hub: VirtualHub;

  constructor(hub: VirtualHub, protocols?: string | string[]) {
    super();
    this.#hub = hub;
    this.offeredVersion2 = [protocols ?? []].flat().includes("ryco.hub-session.v2");
    hub.attach(this);
  }

  open(): void {
    this.readyState = FakeBrowserSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  send(value: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    this.#hub.receiveFromBrowser(this, toBytes(value));
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === FakeBrowserSocket.CLOSED) return;
    this.readyState = FakeBrowserSocket.CLOSED;
    this.#hub.detach(this);
    this.dispatchEvent(new CloseEvent("close", { code, reason, wasClean: code === 1000 }));
  }

  deliver(bytes: Uint8Array): void {
    if (this.readyState !== FakeBrowserSocket.OPEN) return;
    const owned = Uint8Array.from(bytes);
    this.dispatchEvent(new MessageEvent("message", { data: owned.buffer }));
  }
}

interface HubStream {
  readonly id: number;
  readonly socket: FakeBrowserSocket;
  readonly node: FakeNode;
  readonly channelId: RelayChannelId;
  readonly trace: TraceState;
  /** The browser has not closed the stream and the Hub has not ended it. */
  live: boolean;
  /** The node's channel has not been closed or rejected by either side. */
  nodeChannelLive: boolean;
}

interface MutableCounters {
  browserToHub: { frames: number; bytes: number };
  hubToBrowser: { frames: number; bytes: number };
  hubToNode: { frames: number; bytes: number };
  nodeToHub: { frames: number; bytes: number };
  openNodeFrames: number;
  channelsOpened: number;
  ticketRequests: number;
  accountSocketsOpened: number;
}

const freshCounters = (): MutableCounters => ({
  browserToHub: emptyTraffic(),
  hubToBrowser: emptyTraffic(),
  hubToNode: emptyTraffic(),
  nodeToHub: emptyTraffic(),
  openNodeFrames: 0,
  channelsOpened: 0,
  ticketRequests: 0,
  accountSocketsOpened: 0,
});

/**
 * The Hub reduced to what it does on the relay path. Application bytes pass
 * through untouched; every hop costs `hopDelayMs` of virtual time.
 */
class VirtualHub {
  readonly traces: TraceState[] = [];
  counters = freshCounters();
  wire: WireFrame[] = [];
  /** Milestones the browser reached that no single channel could be credited with. */
  readonly attributionFailures: string[] = [];
  readonly #streams = new Map<number, HubStream>();
  readonly #byChannel = new Map<string, HubStream>();
  /** Every trace in the measurement window, by channel; outlives the stream. */
  readonly #traceByChannel = new Map<string, TraceState>();
  #nextChannel = 0;
  nodes: readonly FakeNode[] = [];
  readonly #clock: VirtualClock;
  readonly #hopDelayMs: number;

  constructor(clock: VirtualClock, hopDelayMs: number) {
    this.#clock = clock;
    this.#hopDelayMs = hopDelayMs;
  }

  /** A browser socket was constructed: the Hub accepts it and says `ready` (version 2 only). */
  attach(socket: FakeBrowserSocket): void {
    if (!socket.offeredVersion2) {
      throw new Error("The hosted multi-node harness speaks Hub session version 2 only.");
    }
    this.counters.accountSocketsOpened += 1;
    // Setting the account socket up is not part of any measured window.
    this.#clock.schedule(0, () => {
      socket.open();
      this.#sendOuter(socket, {
        type: "ready",
        protocolVersion: 2,
        maxChannels: HUB_MAX_CHANNELS,
        accountId: ACCOUNT_ID,
        sessionId: SESSION_ID,
      });
    });
  }

  detach(socket: FakeBrowserSocket): void {
    for (const stream of this.#streams.values()) {
      if (stream.socket === socket) this.#endStream(stream);
    }
  }

  receiveFromBrowser(socket: FakeBrowserSocket, bytes: Uint8Array): void {
    const decoded = decodeHubSessionFrame(bytes, { protocolVersion: 2 });
    if (!decoded.ok) throw new Error("The browser emitted an invalid Hub session frame.");
    const frame = decoded.value;
    count(this.counters.browserToHub, bytes.byteLength);
    switch (frame.type) {
      case "openNode": {
        this.counters.openNodeFrames += 1;
        const node = this.nodes.find((candidate) => candidate.id === frame.nodeId);
        if (node === undefined) throw new Error(`The Hub knows no node ${frame.nodeId}.`);
        const channelId =
          `ch_${(this.#nextChannel++).toString(36).padStart(22, "c")}` as RelayChannelId;
        const trace: TraceState = {
          nodeIndex: node.index,
          nodeId: node.id,
          channelId,
          streamId: frame.streamId,
          openNodeSentAt: this.#clock.now,
          relayReadyAt: null,
          channelOpenAt: null,
          channelAcceptAt: null,
          firstDataAt: null,
          shellAcceptedAt: null,
          firstThreadWindowItemAt: null,
          closedAt: null,
          shellPages: 0,
          fromBrowser: emptyTraffic(),
          toNode: emptyTraffic(),
          fromNode: emptyTraffic(),
          toBrowser: emptyTraffic(),
        };
        this.traces.push(trace);
        this.#traceByChannel.set(channelId, trace);
        this.#record("browser-to-hub", "openNode", bytes.byteLength, channelId);
        this.#clock.schedule(this.#hopDelayMs, () =>
          this.#authenticateStream({
            id: frame.streamId,
            socket,
            node,
            channelId,
            trace,
            live: true,
            nodeChannelLive: true,
          }),
        );
        return;
      }
      case "data": {
        const relay = decodeRelayFrame(frame.payload);
        if (!relay.ok) throw new Error("The browser emitted an invalid relay frame.");
        const sending = this.#streams.get(frame.streamId);
        if (sending !== undefined) count(sending.trace.fromBrowser, frame.payload.byteLength);
        this.#record(
          "browser-to-hub",
          relay.value.type,
          bytes.byteLength,
          sending?.channelId ?? null,
        );
        this.#clock.schedule(this.#hopDelayMs, () => {
          const stream = this.#streams.get(frame.streamId);
          if (stream?.live) this.#toNode(stream, relay.value, frame.payload.byteLength);
        });
        return;
      }
      case "close":
        this.#record(
          "browser-to-hub",
          "close",
          bytes.byteLength,
          this.#streams.get(frame.streamId)?.channelId ?? null,
        );
        this.#clock.schedule(this.#hopDelayMs, () => {
          const stream = this.#streams.get(frame.streamId);
          if (stream !== undefined) this.#endStream(stream);
        });
        return;
      case "ping":
        this.#record("browser-to-hub", "ping", bytes.byteLength, null);
        this.#clock.schedule(this.#hopDelayMs, () =>
          this.#sendOuter(socket, { type: "pong", nonce: frame.nonce }),
        );
        return;
      default:
        throw new Error(`The browser sent an unexpected Hub session frame: ${frame.type}.`);
    }
  }

  /** A node's connection handed the Hub relay bytes. */
  receiveFromNode(node: FakeNode, bytes: Uint8Array): void {
    count(this.counters.nodeToHub, bytes.byteLength);
    const decoded = decodeRelayFrame(bytes);
    if (!decoded.ok) throw new Error("A node emitted an invalid relay frame.");
    const frame = decoded.value;
    this.#record(
      "node-to-hub",
      frame.type,
      bytes.byteLength,
      "channelId" in frame ? frame.channelId : null,
    );
    if (!("channelId" in frame)) return;
    const sending = this.#traceByChannel.get(frame.channelId);
    if (sending !== undefined) count(sending.fromNode, bytes.byteLength);
    this.#clock.schedule(this.#hopDelayMs, () => {
      const stream = this.#byChannel.get(frame.channelId);
      if (stream === undefined || stream.node !== node || !stream.live) return;
      if (frame.type === "channel.close" || frame.type === "channel.reject") {
        stream.nodeChannelLive = false;
      }
      this.#toBrowser(stream, frame, bytes);
    });
  }

  /** The Hub ends one stream: the browser sees a close, the node a `channel.close`. */
  dropStream(streamId: number, code: number, reason: string): void {
    const stream = this.#streams.get(streamId);
    if (stream === undefined) throw new Error(`The Hub has no stream ${streamId}.`);
    this.#sendOuter(stream.socket, { type: "close", streamId, code, reason });
    this.#endStream(stream);
  }

  liveStreamFor(nodeIndex: number): HubStream | undefined {
    return [...this.#streams.values()].findLast(
      (stream) => stream.live && stream.node.index === nodeIndex,
    );
  }

  /**
   * The channel the browser's shell and thread window of a node come over: the
   * node's one open channel whose handshake has completed. A client that holds
   * one selection has no other, so a second candidate is recorded as a failure
   * instead of being credited to whichever channel is newest.
   */
  deliveringTrace(nodeIndex: number): TraceState | undefined {
    const candidates = this.traces.filter(
      (trace) =>
        trace.nodeIndex === nodeIndex && trace.closedAt === null && trace.channelAcceptAt !== null,
    );
    if (candidates.length > 1) {
      this.attributionFailures.push(
        `Node ${nodeIndex} has ${candidates.length} accepted channels open at once.`,
      );
      return undefined;
    }
    return candidates[0];
  }

  /** Start a new measurement window: counters return to zero, closed traces are forgotten. */
  reset(): void {
    this.counters = freshCounters();
    this.wire = [];
    const live = this.traces.filter((trace) => trace.closedAt === null);
    this.traces.length = 0;
    this.#traceByChannel.clear();
    for (const trace of live) {
      trace.fromBrowser = emptyTraffic();
      trace.toNode = emptyTraffic();
      trace.fromNode = emptyTraffic();
      trace.toBrowser = emptyTraffic();
      this.traces.push(trace);
      this.#traceByChannel.set(trace.channelId, trace);
    }
  }

  /** What the Hub does once it has consumed the stream's ticket itself. */
  #authenticateStream(stream: HubStream): void {
    this.#streams.set(stream.id, stream);
    this.#byChannel.set(stream.channelId, stream);
    const open: RelayFrame = {
      type: "channel.open",
      ...RELAY_VERSION,
      channelId: stream.channelId,
      capability: "ryco.rpc",
      effectiveRole: "operator",
    };
    this.#toBrowser(stream, { type: "ready", ...RELAY_VERSION, limits: RELAY_INITIAL_LIMITS });
    this.#toBrowser(stream, open);
    this.#toNode(stream, open);
  }

  /** The stream is over: the node's channel is closed unless it already is. */
  #endStream(stream: HubStream): void {
    if (this.#streams.get(stream.id) !== stream) return;
    this.#streams.delete(stream.id);
    this.#byChannel.delete(stream.channelId);
    stream.live = false;
    stream.trace.closedAt ??= this.#clock.now;
    if (stream.nodeChannelLive) {
      stream.nodeChannelLive = false;
      this.#toNode(stream, {
        type: "channel.close",
        ...RELAY_VERSION,
        channelId: stream.channelId,
      });
    }
  }

  #toNode(stream: HubStream, frame: RelayFrame, knownBytes?: number): void {
    const bytes = knownBytes ?? encodeRelay(frame).byteLength;
    count(this.counters.hubToNode, bytes);
    count(stream.trace.toNode, bytes);
    this.#record("hub-to-node", frame.type, bytes, stream.channelId);
    if (frame.type === "channel.open") this.counters.channelsOpened += 1;
    if (frame.type === "channel.close") stream.nodeChannelLive = false;
    this.#clock.schedule(this.#hopDelayMs, () => stream.node.deliver(frame));
  }

  #toBrowser(stream: HubStream, frame: RelayFrame, encoded?: Uint8Array): void {
    const payload = encoded ?? encodeRelay(frame);
    count(stream.trace.toBrowser, payload.byteLength);
    const outer = encodeOuter({ type: "data", streamId: stream.id, payload });
    count(this.counters.hubToBrowser, outer.byteLength);
    this.#record("hub-to-browser", frame.type, outer.byteLength, stream.channelId);
    this.#clock.schedule(this.#hopDelayMs, () => {
      stream.socket.deliver(outer);
      const trace = stream.trace;
      const now = this.#clock.now;
      switch (frame.type) {
        case "ready":
          trace.relayReadyAt ??= now;
          break;
        case "channel.open":
          trace.channelOpenAt ??= now;
          break;
        case "channel.accept":
          trace.channelAcceptAt ??= now;
          break;
        case "data":
          trace.firstDataAt ??= now;
          break;
        default:
          break;
      }
    });
  }

  #sendOuter(socket: FakeBrowserSocket, frame: HubSessionFrame): void {
    const outer = encodeOuter(frame);
    count(this.counters.hubToBrowser, outer.byteLength);
    this.#record("hub-to-browser", frame.type, outer.byteLength, null);
    this.#clock.schedule(this.#hopDelayMs, () => socket.deliver(outer));
  }

  #record(
    direction: WireFrame["direction"],
    type: string,
    bytes: number,
    channelId: string | null,
  ): void {
    this.wire.push({ at: this.#clock.now, direction, type, bytes, channelId });
  }
}

// ---------------------------------------------------------------------------
// The web client under test
// ---------------------------------------------------------------------------

interface HostedWebModules {
  readonly createWsRpcClient: (transport: unknown) => {
    readonly orchestration: {
      readonly subscribeShell: (listener: (item: unknown) => void) => () => void;
      readonly subscribeThreadWindow?: (
        input: {
          readonly threadId: string;
          readonly limits: typeof THREAD_WINDOW_LIMITS;
        },
        listener: (item: unknown) => void,
      ) => () => void;
    };
    readonly dispose: () => Promise<void>;
  };
  readonly WsTransport: new (url: () => Promise<string>, lifecycleHandlers: unknown) => unknown;
  readonly encodeBase64Url: (value: Uint8Array) => string;
  readonly hostedHubApi: {
    issueRelayTicket: (nodeId: string) => Promise<unknown>;
  };
  readonly hostedHubController: {
    readonly resetForTests: () => void;
    readonly notifyDirectoryInvalidated: () => void;
  };
  /** The app's readiness mark, which drops a snapshot from a superseded generation. */
  readonly markHostedSessionReady: (environmentId: EnvironmentId, generation: number) => void;
  readonly watchWebHostedHubSession: () => () => void;
  readonly isWebHubSessionOnline: () => boolean;
  readonly useHostedHubStore: {
    readonly setState: (state: Record<string, unknown>) => void;
    readonly getState: () => Record<string, unknown>;
  };
  readonly getHostedRelayAttemptFactory: () => {
    readonly nextUrl: () => Promise<string>;
    readonly lifecycleHandlers: () => unknown;
  };
  readonly resetHostedRelayAttemptFactory: () => void;
  readonly loadWebRelayE2ee: () => Promise<{ readonly warmE2eePrimitives: () => void }>;
}

/** The web sources are loaded by URL so the server package does not depend on the web app. */
async function loadHostedWebModules(): Promise<HostedWebModules> {
  const load = async <T>(relativePath: string): Promise<T> =>
    (await import(
      /* @vite-ignore */ new URL(`../../../../web/src/${relativePath}`, import.meta.url).href
    )) as T;
  const [client, transport, base64url, api, state, hostedTransport, hubSession, e2eeAttempt] =
    await Promise.all([
      load<Pick<HostedWebModules, "createWsRpcClient">>("rpc/wsRpcClient.ts"),
      load<Pick<HostedWebModules, "WsTransport">>("rpc/wsTransport.ts"),
      load<Pick<HostedWebModules, "encodeBase64Url">>("hostedHub/base64url.ts"),
      load<Pick<HostedWebModules, "hostedHubApi">>("hostedHub/api.ts"),
      load<
        Pick<
          HostedWebModules,
          "hostedHubController" | "markHostedSessionReady" | "useHostedHubStore"
        >
      >("hostedHub/state.ts"),
      load<
        Pick<HostedWebModules, "getHostedRelayAttemptFactory" | "resetHostedRelayAttemptFactory">
      >("hostedHub/transport.ts"),
      load<Pick<HostedWebModules, "watchWebHostedHubSession" | "isWebHubSessionOnline">>(
        "hostedHub/hubSession.ts",
      ),
      load<Pick<HostedWebModules, "loadWebRelayE2ee">>("hostedHub/e2eeAttempt.ts"),
    ]);
  return {
    ...client,
    ...transport,
    ...base64url,
    ...api,
    ...state,
    ...hostedTransport,
    ...hubSession,
    ...e2eeAttempt,
  };
}

/**
 * `DecompressionStream("deflate-raw")` that inflates when its input ends, on
 * the calling thread. The platform's stream inflates on the libuv threadpool,
 * and how long that takes is not something the virtual clock can wait for; the
 * bytes it yields are the same.
 */
class SynchronousDecompressionStream extends TransformStream<Uint8Array, Uint8Array> {
  constructor(format: string) {
    if (format !== "deflate-raw") {
      throw new TypeError(
        `The hosted multi-node harness only inflates deflate-raw, not ${format}.`,
      );
    }
    const body: Uint8Array[] = [];
    super({
      transform: (chunk) => {
        body.push(Uint8Array.from(chunk));
      },
      flush: (controller) => {
        controller.enqueue(Uint8Array.from(inflateRawSync(Buffer.concat(body))));
      },
    });
  }
}

/** Replace a global until the returned function puts the original back. */
function overrideGlobal(name: string, value: unknown): () => void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  return () => {
    if (previous === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, previous);
  };
}

/** Give the web client a browser to run in; the returned function takes it away. */
function installBrowserGlobals(hub: VirtualHub): () => void {
  const restores = [
    overrideGlobal("window", { location: { origin: HUB_ORIGIN } }),
    // The web E2EE runtime only negotiates in a secure context.
    overrideGlobal("isSecureContext", true),
    overrideGlobal(
      "WebSocket",
      class extends FakeBrowserSocket {
        constructor(_url: string, protocols?: string | string[]) {
          super(hub, protocols);
        }
      },
    ),
    overrideGlobal("DecompressionStream", SynchronousDecompressionStream),
  ];
  return () => {
    for (const restore of restores.toReversed()) restore();
  };
}

function selectedNodeRecord(index: number) {
  const suffix = idSuffix(index);
  return {
    id: nodeIdFor(index),
    environmentId: EnvironmentId.make(`env_${suffix}`),
    label: `Public test node ${index}`,
    platformOs: "linux",
    platformArch: "x64",
    clientVersion: "0.1.8",
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    revokedAt: null,
    revocationReasonCode: null,
    grant: { id: `grant_${suffix}`, role: "operator" },
    effectiveRole: "operator",
    presence: { online: true, lastHeartbeatAt: 1 },
  };
}

interface ClientSession {
  readonly nodeIndex: number;
  readonly client: { readonly dispose: () => Promise<void> };
  readonly unsubscribe: () => void;
  /** The first shell the browser accepted, per channel. */
  readonly shells: Map<string, { projectIds: string[]; threadCount: number }>;
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

/**
 * The harness replaces process-wide state (the clock, the browser globals and
 * the web client's module singletons), so a second one alive at the same time
 * would undo the first one's setup when it was disposed.
 */
let harnessLive = false;

export async function createHostedMultiNodeHarness(
  options: HostedMultiNodeHarnessOptions,
): Promise<HostedMultiNodeHarness> {
  const hopDelayMs = options.hopDelayMs ?? 0;
  const threadsPerNode = options.threadsPerNode ?? 50;
  const shellPageMaxBytes =
    options.shellPageMaxBytes ?? ORCHESTRATION_SHELL_SNAPSHOT_PAGE_MAX_BYTES;
  const e2ee: string = options.e2ee ?? "nx";
  if (e2ee !== "nx") {
    throw new Error(`The hosted multi-node harness only wires the NX handshake, not ${e2ee}.`);
  }
  if (!Number.isInteger(options.nodes) || options.nodes < 1) {
    throw new Error("The hosted multi-node harness needs at least one node.");
  }
  if (harnessLive) {
    throw new Error(
      "A hosted multi-node harness is already live; dispose it before creating another.",
    );
  }
  harnessLive = true;

  // Undone in reverse order by `dispose`, and by a setup that fails half way.
  const cleanups: Array<() => void | Promise<void>> = [];
  const runCleanups = async (): Promise<void> => {
    const failures: unknown[] = [];
    try {
      for (const cleanup of cleanups.splice(0).toReversed()) {
        try {
          await cleanup();
        } catch (error: unknown) {
          failures.push(error);
        }
      }
    } finally {
      harnessLive = false;
    }
    if (failures.length > 0) throw failures[0];
  };

  try {
    vi.useFakeTimers({ toFake: ["Date"] });
    cleanups.push(() => {
      vi.useRealTimers();
    });
    vi.setSystemTime(CLOCK_EPOCH_MS);
    const clock = new VirtualClock((now) => vi.setSystemTime(CLOCK_EPOCH_MS + now));

    const hub = new VirtualHub(clock, hopDelayMs);
    const nodes = Array.from({ length: options.nodes }, (_, index) =>
      createFakeNode({
        index,
        threadsPerNode,
        shellPageMaxBytes,
        now: () => Date.now(),
        readShell: options.readShell,
        sendToHub: (node, bytes) => hub.receiveFromNode(node, bytes),
        onShellServed: (channelId, pages) => {
          const trace = hub.traces.find((candidate) => candidate.channelId === channelId);
          if (trace !== undefined) trace.shellPages = pages;
        },
      }),
    );
    hub.nodes = nodes;
    cleanups.push(async () => {
      await Promise.all(nodes.map((node) => node.close()));
    });

    cleanups.push(installBrowserGlobals(hub));
    const web = await loadHostedWebModules();
    // The handshake code is a separate chunk in the product, loaded after
    // sign-in and ahead of the first channel; load it here so a measured open
    // does not wait on module loading.
    (await web.loadWebRelayE2ee()).warmE2eePrimitives();

    const issueRelayTicket = vi
      .spyOn(web.hostedHubApi, "issueRelayTicket")
      .mockImplementation(async () => {
        hub.counters.ticketRequests += 1;
        return {
          ticket: web.encodeBase64Url(new Uint8Array(32).fill(7)),
          expiresAt: Date.now() + SESSION_LIFETIME_MS,
        };
      });
    cleanups.push(() => issueRelayTicket.mockRestore());
    // The account socket's `ready` asks for a directory refresh, which is HTTP.
    const directoryInvalidated = vi
      .spyOn(web.hostedHubController, "notifyDirectoryInvalidated")
      .mockImplementation(() => undefined);
    cleanups.push(() => directoryInvalidated.mockRestore());

    let generation = 1;
    cleanups.push(() => {
      web.resetHostedRelayAttemptFactory();
      web.hostedHubController.resetForTests();
    });
    web.useHostedHubStore.setState({
      accountStatus: "authenticated",
      account: {
        id: ACCOUNT_ID,
        displayName: "Test",
        role: "owner",
        createdAt: 1,
        disabledAt: null,
      },
      session: {
        id: SESSION_ID,
        accountId: ACCOUNT_ID,
        createdAt: 1,
        expiresAt: Date.now() + SESSION_LIFETIME_MS,
        lastSeenAt: 1,
        revokedAt: null,
        revocationReasonCode: null,
      },
      directoryStatus: "ready",
      generation,
    });
    cleanups.push(web.watchWebHostedHubSession());

    let active: ClientSession | null = null;
    let disposed = false;

    const describeState = (): string =>
      JSON.stringify({
        now: clock.now,
        transport: web.useHostedHubStore.getState().transportStatus,
        session: web.useHostedHubStore.getState().sessionStatus,
        traces: hub.traces.map((trace) => ({
          node: trace.nodeIndex,
          ready: trace.relayReadyAt,
          accept: trace.channelAcceptAt,
          data: trace.firstDataAt,
          shell: trace.shellAcceptedAt,
          window: trace.firstThreadWindowItemAt,
          closed: trace.closedAt,
        })),
        nodeErrors: nodes.flatMap((node) => node.errors),
        attributionFailures: hub.attributionFailures,
      });

    // Bringing the account socket up is not part of any measured window.
    await clock.drive(() => web.isWebHubSessionOnline(), describeState);
    hub.reset();

    const snapshotCounters = (): HostedMultiNodeCounters => {
      const c = hub.counters;
      const copy = (traffic: HubTraffic): HubTraffic => ({
        frames: traffic.frames,
        bytes: traffic.bytes,
      });
      const directions = [c.browserToHub, c.hubToBrowser, c.hubToNode, c.nodeToHub];
      return {
        browserToHub: copy(c.browserToHub),
        hubToBrowser: copy(c.hubToBrowser),
        hubToNode: copy(c.hubToNode),
        nodeToHub: copy(c.nodeToHub),
        total: {
          frames: directions.reduce((sum, traffic) => sum + traffic.frames, 0),
          bytes: directions.reduce((sum, traffic) => sum + traffic.bytes, 0),
        },
        openNodeFrames: c.openNodeFrames,
        channelsOpened: c.channelsOpened,
        ticketRequests: c.ticketRequests,
        accountSocketsOpened: c.accountSocketsOpened,
        nodeErrors: nodes.flatMap((node) => node.errors),
        channels: hub.traces.map(exposeTrace),
      };
    };

    const difference = (after: HubTraffic, before: HubTraffic): HubTraffic => ({
      frames: after.frames - before.frames,
      bytes: after.bytes - before.bytes,
    });

    const startSession = (nodeIndex: number): ClientSession => {
      const node = selectedNodeRecord(nodeIndex);
      generation += 1;
      // What the app captures when it creates a connection: items this session
      // delivers after a newer one has started are stale and publish nothing.
      const sessionGeneration = generation;
      const isCurrent = (): boolean => generation === sessionGeneration;
      web.useHostedHubStore.setState({
        selectedNode: node,
        selectionStatus: "online",
        effectiveRole: "operator",
        transportStatus: "idle",
        sessionStatus: "synchronizing",
        sessionEstablished: false,
        sessionRecoveredAfterUnknown: false,
        errorMessage: null,
        generation,
      });
      const attemptFactory = web.getHostedRelayAttemptFactory();
      const transport = new web.WsTransport(
        () => attemptFactory.nextUrl(),
        attemptFactory.lifecycleHandlers(),
      );
      const client = web.createWsRpcClient(transport);
      const shells = new Map<string, { projectIds: string[]; threadCount: number }>();
      const unsubscribeShell = client.orchestration.subscribeShell((item) => {
        const accepted = item as {
          readonly kind?: string;
          readonly snapshot?: {
            readonly projects: readonly { readonly id: string }[];
            readonly threads: readonly unknown[];
          };
        };
        if (!isCurrent()) return;
        if (accepted.kind !== "snapshot" || accepted.snapshot === undefined) return;
        const trace = hub.deliveringTrace(nodeIndex);
        if (trace === undefined) return;
        trace.shellAcceptedAt ??= clock.now;
        shells.set(trace.channelId, {
          projectIds: accepted.snapshot.projects.map((project) => project.id),
          threadCount: accepted.snapshot.threads.length,
        });
        // The app marks the session ready when it accepts the shell snapshot.
        web.markHostedSessionReady(node.environmentId, sessionGeneration);
      });
      // Opening a thread subscribes to its window beside the shell.
      const unsubscribeWindow = client.orchestration.subscribeThreadWindow?.(
        { threadId: `thread-${nodeIndex}-0`, limits: THREAD_WINDOW_LIMITS },
        (item) => {
          if (!isCurrent()) return;
          if ((item as { readonly kind?: string }).kind !== "snapshot") return;
          const trace = hub.deliveringTrace(nodeIndex);
          if (trace !== undefined) trace.firstThreadWindowItemAt ??= clock.now;
        },
      );
      return {
        nodeIndex,
        client,
        unsubscribe: () => {
          unsubscribeShell();
          unsubscribeWindow?.();
        },
        shells,
      };
    };

    const endSession = async (session: ClientSession): Promise<void> => {
      session.unsubscribe();
      const disposal = session.client.dispose();
      let finished = false;
      const settled = disposal.then(
        () => {
          finished = true;
        },
        () => {
          finished = true;
        },
      );
      await clock.drive(() => finished, describeState);
      await settled;
      await disposal;
      web.resetHostedRelayAttemptFactory();
    };

    /**
     * Run until the first channel `find` returns has the shell and the first
     * thread window, then until the frames that set off have landed too: the
     * acknowledgements are part of what an open costs.
     */
    const awaitOpen = async (find: () => TraceState | undefined): Promise<TraceState> => {
      await clock.drive(() => {
        const trace = find();
        return (
          trace !== undefined &&
          trace.shellAcceptedAt !== null &&
          trace.firstThreadWindowItemAt !== null
        );
      }, describeState);
      await clock.quiesce(describeState);
      return find()!;
    };

    const resultFor = (
      session: ClientSession,
      trace: TraceState,
      before: HostedMultiNodeCounters,
    ): HostedNodeOpenResult => {
      if (hub.attributionFailures.length > 0) {
        throw new Error(
          `A milestone could not be credited to one channel: ${hub.attributionFailures.join(" ")}`,
        );
      }
      const after = snapshotCounters();
      const node = nodes[session.nodeIndex]!;
      const mode = node.channels.get(trace.channelId)?.mode();
      if (mode !== "e2ee") {
        throw new Error(
          `Node ${session.nodeIndex} did not complete the NX handshake (mode ${String(mode)}). ${describeState()}`,
        );
      }
      const shell = session.shells.get(trace.channelId);
      if (shell === undefined) throw new Error("The browser accepted no shell for this channel.");
      const since = (at: number | null): number => {
        if (at === null)
          throw new Error(`A milestone of node ${session.nodeIndex} never happened.`);
        return at - trace.openNodeSentAt;
      };
      const shellAcceptedMs = since(trace.shellAcceptedAt);
      return {
        nodeIndex: session.nodeIndex,
        nodeId: node.id,
        e2ee: "nx",
        hopDelayMs,
        frames: after.total.frames - before.total.frames,
        bytes: after.total.bytes - before.total.bytes,
        traffic: {
          browserToHub: difference(after.browserToHub, before.browserToHub),
          hubToBrowser: difference(after.hubToBrowser, before.hubToBrowser),
          hubToNode: difference(after.hubToNode, before.hubToNode),
          nodeToHub: difference(after.nodeToHub, before.nodeToHub),
          openNodeFrames: after.openNodeFrames - before.openNodeFrames,
          channelsOpened: after.channelsOpened - before.channelsOpened,
        },
        shellPages: trace.shellPages,
        shellAcceptedMs,
        relayRoundTrips: hopDelayMs > 0 ? shellAcceptedMs / (4 * hopDelayMs) : null,
        milestonesMs: {
          relayReady: since(trace.relayReadyAt),
          channelAccept: since(trace.channelAcceptAt),
          firstData: since(trace.firstDataAt),
          shellAccepted: shellAcceptedMs,
          firstThreadWindowItem: since(trace.firstThreadWindowItemAt),
        },
        shell,
        trace: exposeTrace(trace),
      };
    };

    const openFrom = async (
      nodeIndex: number,
      before: HostedMultiNodeCounters,
    ): Promise<HostedNodeOpenResult> => {
      if (disposed) throw new Error("The hosted multi-node harness is disposed.");
      if (!Number.isInteger(nodeIndex) || nodeIndex < 0 || nodeIndex >= nodes.length) {
        throw new Error(`No node ${nodeIndex}.`);
      }
      const firstTrace = hub.traces.length;
      const session = startSession(nodeIndex);
      active = session;
      const trace = await awaitOpen(() =>
        hub.traces.slice(firstTrace).find((candidate) => candidate.nodeIndex === nodeIndex),
      );
      return resultFor(session, trace, before);
    };

    return {
      hopDelayMs,
      nodeIds: nodes.map((node) => node.id),
      openNode: async (nodeIndex) => {
        if (active !== null) {
          throw new Error("A node session is already open; use switchTo to change nodes.");
        }
        return openFrom(nodeIndex, snapshotCounters());
      },
      switchTo: async (nodeIndex) => {
        const before = snapshotCounters();
        const previous = active;
        active = null;
        if (previous !== null) await endSession(previous);
        return openFrom(nodeIndex, before);
      },
      dropChannel: async () => {
        const session = active;
        if (session === null) throw new Error("No node session is open.");
        const before = snapshotCounters();
        const stream = hub.liveStreamFor(session.nodeIndex);
        if (stream === undefined) throw new Error("The active node has no live channel.");
        const firstTrace = hub.traces.length;
        hub.dropStream(stream.id, 1011, "relay channel dropped");
        const trace = await awaitOpen(() =>
          hub.traces
            .slice(firstTrace)
            .find((candidate) => candidate.nodeIndex === session.nodeIndex),
        );
        return resultFor(session, trace, before);
      },
      counters: snapshotCounters,
      wire: () => [...hub.wire],
      reset: () => hub.reset(),
      now: () => clock.now,
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        const session = active;
        active = null;
        try {
          if (session !== null) await endSession(session);
        } finally {
          await runCleanups();
        }
      },
    };
  } catch (error: unknown) {
    await runCleanups().catch(() => undefined);
    throw error;
  }
}

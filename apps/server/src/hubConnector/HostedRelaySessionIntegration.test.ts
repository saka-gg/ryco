import {
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  RELAY_INITIAL_LIMITS,
  type RelayChannelId,
  type RelayFrame,
  WsRpcGroup,
} from "@ryco/contracts";
import { type HubSessionFrame } from "@ryco/contracts/hub-session";
import { decodeHubSessionFrame, encodeHubSessionFrame } from "@ryco/shared/hubSessionCodec";
import { decodeRelayFrame, encodeRelayFrame } from "@ryco/shared/relayCodec";
import {
  RelayMessageAssembler,
  stripRelayChunkCapabilityPrelude,
} from "@ryco/shared/relayMessageChunks";
import {
  hasRelayCompressionAdvertisement,
  isCompressedRelayPayload,
} from "@ryco/shared/relayPayloadCompression";
import { Effect, Exit, Scope, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { makeRpcByteSession } from "../ws/RpcByteSession.ts";
import { pageShellSnapshot } from "../ws/context/shellSnapshotPages.ts";
import { RelayResponseCompressor } from "../ws/relayResponseCompression.ts";
import { RelayChannelRegistry } from "./RelayChannelRegistry.ts";
import { RelaySendQueue } from "./RelaySendQueue.ts";

interface HostedWebTestModules {
  readonly createWsRpcClient: (transport: unknown) => {
    readonly orchestration: {
      readonly subscribeShell: (listener: (item: unknown) => void) => () => void;
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
  readonly watchWebHostedHubSession: () => () => void;
  readonly useHostedHubStore: {
    readonly setState: (state: Record<string, unknown>) => void;
    readonly getState: () => Record<string, unknown>;
  };
  readonly getHostedRelayAttemptFactory: () => {
    readonly nextUrl: () => Promise<string>;
    readonly lifecycleHandlers: () => unknown;
  };
  readonly resetHostedRelayAttemptFactory: () => void;
}

async function loadHostedWebTestModules(): Promise<HostedWebTestModules> {
  const load = async <T>(relativePath: string): Promise<T> =>
    (await import(
      /* @vite-ignore */ new URL(`../../../web/src/${relativePath}`, import.meta.url).href
    )) as T;
  const [client, transport, base64url, api, state, hostedTransport, hubSession] = await Promise.all(
    [
      load<{ createWsRpcClient: HostedWebTestModules["createWsRpcClient"] }>("rpc/wsRpcClient.ts"),
      load<{ WsTransport: HostedWebTestModules["WsTransport"] }>("rpc/wsTransport.ts"),
      load<{ encodeBase64Url: HostedWebTestModules["encodeBase64Url"] }>("hostedHub/base64url.ts"),
      load<{ hostedHubApi: HostedWebTestModules["hostedHubApi"] }>("hostedHub/api.ts"),
      load<Pick<HostedWebTestModules, "hostedHubController" | "useHostedHubStore">>(
        "hostedHub/state.ts",
      ),
      load<
        Pick<
          HostedWebTestModules,
          "getHostedRelayAttemptFactory" | "resetHostedRelayAttemptFactory"
        >
      >("hostedHub/transport.ts"),
      load<Pick<HostedWebTestModules, "watchWebHostedHubSession">>("hostedHub/hubSession.ts"),
    ],
  );
  return {
    ...client,
    ...transport,
    ...base64url,
    ...api,
    ...state,
    ...hostedTransport,
    ...hubSession,
  };
}

const {
  createWsRpcClient,
  WsTransport,
  encodeBase64Url,
  hostedHubApi,
  hostedHubController,
  useHostedHubStore,
  getHostedRelayAttemptFactory,
  resetHostedRelayAttemptFactory,
  watchWebHostedHubSession,
} = await loadHostedWebTestModules();

const VERSION = { protocolMajor: 1, protocolMinor: 2 } as const;
const CHANNEL_ID = `ch_${"c".repeat(22)}` as RelayChannelId;
const testGlobals = globalThis as unknown as {
  window?: unknown;
  WebSocket?: unknown;
};
const originalWindow = testGlobals.window;
const originalWebSocket = testGlobals.WebSocket;
const physicalSockets: PhysicalRelaySocket[] = [];
let stopWatchingSession: (() => void) | undefined;

function toBytes(value: string | ArrayBufferLike | Blob | ArrayBufferView): Uint8Array {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return Uint8Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  throw new Error("Unexpected Blob write in hosted relay integration test.");
}

class PhysicalRelaySocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = PhysicalRelaySocket.CONNECTING;
  bufferedAmount = 0;
  binaryType = "blob";
  readonly receivedFromClient: RelayFrame[] = [];
  readonly receivedOuterFrames: HubSessionFrame[] = [];
  readonly activeStreams = new Set<number>();
  private streamId: number | null = null;
  private readonly registry: RelayChannelRegistry;

  constructor(registry: RelayChannelRegistry) {
    super();
    this.registry = registry;
    physicalSockets.push(this);
  }

  open(): void {
    this.readyState = PhysicalRelaySocket.OPEN;
    this.dispatchEvent(new Event("open"));
    this.deliverOuter({ type: "ready", protocolVersion: 1, maxChannels: 8 });
  }

  send(value: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    const outer = decodeHubSessionFrame(toBytes(value));
    if (!outer.ok) throw new Error("Hosted client emitted an invalid Hub session envelope.");
    this.receivedOuterFrames.push(outer.value);
    if (outer.value.type === "open") {
      this.streamId = outer.value.streamId;
      this.activeStreams.add(outer.value.streamId);
      return;
    }
    if (outer.value.type === "close") {
      this.activeStreams.delete(outer.value.streamId);
      return;
    }
    if (outer.value.type === "ping") {
      this.deliverOuter({ type: "pong", nonce: outer.value.nonce });
      return;
    }
    if (outer.value.type !== "data" || !this.activeStreams.has(outer.value.streamId)) {
      throw new Error("Hosted client used an unopened Hub session stream.");
    }
    const decoded = decodeRelayFrame(outer.value.payload);
    if (!decoded.ok) throw new Error("Hosted client emitted an invalid relay frame.");
    const frame = decoded.value;
    this.receivedFromClient.push(frame);
    if (frame.type === "auth") {
      this.deliver({ type: "ready", ...VERSION, limits: RELAY_INITIAL_LIMITS });
      const openFrame: RelayFrame = {
        type: "channel.open",
        ...VERSION,
        channelId: CHANNEL_ID,
        capability: "ryco.rpc",
        effectiveRole: "operator",
      };
      this.deliver(openFrame);
      void this.registry.handle(openFrame);
      return;
    }
    void this.registry.handle(frame);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === PhysicalRelaySocket.CLOSED) return;
    this.readyState = PhysicalRelaySocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close", { code, reason, wasClean: code === 1000 }));
  }

  deliver(frame: RelayFrame): void {
    const encoded = encodeRelayFrame(frame);
    if (!encoded.ok) throw new Error("Test relay frame could not be encoded.");
    this.deliverBytes(encoded.value);
  }

  deliverBytes(bytes: Uint8Array): void {
    if (this.streamId === null) throw new Error("No logical relay channel is open.");
    this.deliverOuter({ type: "data", streamId: this.streamId, payload: bytes });
  }

  deliverOuter(frame: HubSessionFrame): void {
    const encoded = encodeHubSessionFrame(frame);
    if (!encoded.ok) throw new Error("Test Hub session envelope could not be encoded.");
    const owned = Uint8Array.from(encoded.value);
    this.dispatchEvent(new MessageEvent("message", { data: owned.buffer }));
  }
}

beforeEach(() => {
  physicalSockets.length = 0;
  Object.defineProperty(testGlobals, "window", {
    configurable: true,
    value: { location: { origin: "http://localhost:3020" } },
  });
  testGlobals.WebSocket = PhysicalRelaySocket;
});

afterEach(() => {
  stopWatchingSession?.();
  stopWatchingSession = undefined;
  resetHostedRelayAttemptFactory();
  hostedHubController.resetForTests();
  Object.defineProperty(testGlobals, "window", { configurable: true, value: originalWindow });
  testGlobals.WebSocket = originalWebSocket;
  vi.restoreAllMocks();
});

interface HostedShellSession {
  readonly received: unknown[];
  readonly unsubscribe: () => void;
  readonly client: { readonly dispose: () => Promise<void> };
  readonly registry: RelayChannelRegistry;
  readonly sessionScopes: Scope.Closeable[];
  /** Every node-to-client data payload, reassembled into whole messages. */
  readonly nodeMessages: Uint8Array[];
}

/**
 * The real hosted web client stack — WsTransport, the hosted relay socket and
 * engine — subscribed to the shell of a real node byte session behind a real
 * channel registry, with the Hub reduced to a frame forwarder.
 */
async function openHostedShellSession(options: {
  readonly subscribeShell: (input: {
    readonly snapshotDelivery?: "paged";
  }) => Stream.Stream<unknown>;
  readonly compressResponses?: boolean;
}): Promise<HostedShellSession> {
  const handlerLayer = WsRpcGroup.toLayer(
    Effect.succeed(
      WsRpcGroup.of({
        [ORCHESTRATION_WS_METHODS.subscribeShell]: options.subscribeShell,
      } as never),
    ),
  );
  const sessionScopes: Scope.Closeable[] = [];
  const nodeMessages: Uint8Array[] = [];
  const nodeAssembler = new RelayMessageAssembler();
  const relaySocket = {
    bufferedAmount: 0,
    send: (bytes: Uint8Array) => {
      const decoded = decodeRelayFrame(bytes);
      if (decoded.ok && decoded.value.type === "data") {
        const assembled = nodeAssembler.push(Uint8Array.from(decoded.value.payload));
        if (assembled.kind === "done") nodeMessages.push(assembled.message);
      }
      physicalSockets.at(-1)?.deliverBytes(bytes);
    },
  };
  const sendQueue = new RelaySendQueue(relaySocket, RELAY_INITIAL_LIMITS);
  const registry = new RelayChannelRegistry({
    limits: RELAY_INITIAL_LIMITS,
    protocol: VERSION,
    sendQueue,
    onOutboundReady: () => sendQueue.flush(),
    factory: {
      open: async ({ send }) => {
        const scope = await Effect.runPromise(Scope.make("sequential"));
        sessionScopes.push(scope);
        const session = await Effect.runPromise(
          makeRpcByteSession(
            WsRpcGroup,
            handlerLayer,
            (bytes) =>
              Effect.sync(() => {
                if (!send(bytes).accepted) throw new Error("Test relay output queue is full.");
              }),
            {
              queueCapacity: 8,
              ...(options.compressResponses ? { compressor: new RelayResponseCompressor() } : {}),
            },
          ).pipe(Effect.provideService(Scope.Scope, scope)),
        );
        return {
          receive: (bytes: Uint8Array) => Effect.runPromise(session.receive(bytes)),
          queuedBytes: () => Effect.runPromise(session.queuedBytes),
          supportsChunkedMessages: session.supportsChunkedMessages,
          close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
        };
      },
    },
  });
  testGlobals.WebSocket = class extends PhysicalRelaySocket {
    constructor() {
      super(registry);
      queueMicrotask(() => this.open());
    }
  };
  const selectedNode = {
    id: "node_aaaaaaaaaaaaaaaaaaaaaa",
    environmentId: EnvironmentId.make("env_aaaaaaaaaaaaaaaaaaaaaa"),
    label: "Public test node",
    platformOs: "linux",
    platformArch: "x64",
    clientVersion: "0.1.8",
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    revokedAt: null,
    revocationReasonCode: null,
    grant: { id: "grant_aaaaaaaaaaaaaaaaaaaaaa", role: "operator" },
    effectiveRole: "operator",
    presence: { online: true, lastHeartbeatAt: 1 },
  };
  // The outer socket is account-owned before any node ticket is consumed.
  vi.spyOn(hostedHubController, "notifyDirectoryInvalidated").mockImplementation(() => undefined);
  useHostedHubStore.setState({
    accountStatus: "authenticated",
    account: {
      id: "account-public-test",
      displayName: "Test",
      role: "owner",
      createdAt: 1,
      disabledAt: null,
    },
    session: {
      id: "session-public-test",
      accountId: "account-public-test",
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
      lastSeenAt: 1,
      revokedAt: null,
      revocationReasonCode: null,
    },
    directoryStatus: "ready",
    selectedNode,
    selectionStatus: "online",
    effectiveRole: "operator",
    generation: 1,
  });
  stopWatchingSession = watchWebHostedHubSession();
  vi.spyOn(hostedHubApi, "issueRelayTicket").mockResolvedValue({
    ticket: encodeBase64Url(new Uint8Array(32).fill(7)),
    expiresAt: Date.now() + 60_000,
  });
  const attemptFactory = getHostedRelayAttemptFactory();
  const transport = new WsTransport(
    () => attemptFactory.nextUrl(),
    attemptFactory.lifecycleHandlers(),
  );
  const client = createWsRpcClient(transport);
  const received: unknown[] = [];
  const unsubscribe = client.orchestration.subscribeShell((item) => received.push(item));
  return { received, unsubscribe, client, registry, sessionScopes, nodeMessages };
}

async function closeHostedShellSession(session: HostedShellSession): Promise<void> {
  session.unsubscribe();
  await session.client.dispose();
  stopWatchingSession?.();
  stopWatchingSession = undefined;
  await session.registry.closeAll();
  for (const scope of session.sessionScopes) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}

/** A project whose script carries a credential, as users' scripts do. */
const SECRET_SCRIPT_COMMAND =
  "DATABASE_URL=postgres://relay:hunter2@db.internal/app bun run migrate";

/** The shell as the subscriber asked for it: paged when it asked, one item otherwise. */
function shellItems(
  snapshot: ReturnType<typeof largeShellSnapshot>,
  input: { readonly snapshotDelivery?: "paged" },
): Stream.Stream<unknown> {
  return input.snapshotDelivery === "paged"
    ? Stream.fromArrays(...pageShellSnapshot(snapshot.snapshot as never, 256 * 1_024))
    : Stream.succeed(snapshot);
}

function largeShellSnapshot(threadCount: number) {
  return {
    kind: "snapshot" as const,
    snapshot: {
      snapshotSequence: 0,
      projects: [
        {
          id: "project-public-test",
          title: "Public test project",
          workspaceRoot: "/tmp/public-test",
          defaultModelSelection: null,
          scripts: [
            {
              id: "migrate",
              name: "Migrate",
              command: SECRET_SCRIPT_COMMAND,
              icon: "play" as const,
              runOnWorktreeCreate: false,
            },
          ],
          createdAt: "2026-07-18T00:00:00.000Z",
          updatedAt: "2026-07-18T00:00:00.000Z",
        },
      ],
      worktrees: [],
      threads: Array.from({ length: threadCount }, (_, index) => ({
        id: `thread-${index}`,
        projectId: "project-public-test",
        title: `Investigate relay case ${index % 37}`,
        modelSelection: { instanceId: "codex", model: "gpt-5-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: `feature/relay-${index}`,
        worktreePath: null,
        latestTurn: null,
        goal: null,
        createdAt: "2026-07-18T00:00:00.000Z",
        updatedAt: "2026-07-18T00:00:00.000Z",
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        session: null,
        latestUserMessageAt: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
      })),
      updatedAt: "2026-07-18T00:00:00.000Z",
    },
  };
}

describe("hosted relay session integration", () => {
  it("streams the initial shell snapshot, acknowledges it, and receives a later event", async () => {
    const snapshot = {
      kind: "snapshot" as const,
      snapshot: {
        snapshotSequence: 0,
        projects: [],
        worktrees: [],
        threads: [],
        updatedAt: "2026-07-18T00:00:00.000Z",
      },
    };
    const laterEvent = {
      kind: "project-removed" as const,
      sequence: 1,
      projectId: ProjectId.make("project-public-test"),
    };
    const session = await openHostedShellSession({
      subscribeShell: () =>
        Stream.concat(
          Stream.succeed(snapshot),
          Stream.concat(
            Stream.fromEffect(Effect.sleep(10).pipe(Effect.as(laterEvent))),
            Stream.never,
          ),
        ),
    });

    await vi.waitFor(() => expect(session.received).toEqual([snapshot, laterEvent]));

    expect(useHostedHubStore.getState()).toMatchObject({
      transportStatus: "online",
      sessionStatus: "synchronizing",
      effectiveRole: "operator",
    });
    const activePhysicalSocket = physicalSockets.at(-1);
    if (!activePhysicalSocket) throw new Error("Expected the physical relay socket to open.");
    expect(
      activePhysicalSocket.receivedFromClient.filter(
        (frame) => frame.type === "data" && frame.channelId === CHANNEL_ID,
      ).length,
    ).toBeGreaterThanOrEqual(2);
    session.unsubscribe();
    await session.client.dispose();
    await vi.waitFor(() => expect(activePhysicalSocket.activeStreams.size).toBe(0));
    expect(physicalSockets).toHaveLength(1);
    expect(activePhysicalSocket.readyState).toBe(PhysicalRelaySocket.OPEN);
    expect(
      activePhysicalSocket.receivedOuterFrames.filter((frame) => frame.type === "open"),
    ).toHaveLength(1);
    expect(activePhysicalSocket.receivedOuterFrames.some((frame) => frame.type === "close")).toBe(
      true,
    );
    stopWatchingSession?.();
    stopWatchingSession = undefined;
    expect(activePhysicalSocket.readyState).toBe(PhysicalRelaySocket.CLOSED);
    await closeHostedShellSession(session);
  });

  it("carries a large paged shell snapshot compressed end to end and delivers it intact", async () => {
    const snapshot = largeShellSnapshot(2_000);
    const session = await openHostedShellSession({
      subscribeShell: (input) => Stream.concat(shellItems(snapshot, input), Stream.never),
      compressResponses: true,
    });

    await vi.waitFor(() => expect(session.received).toHaveLength(1), { timeout: 5_000 });
    const delivered = session.received[0] as typeof snapshot;
    expect(delivered.kind).toBe("snapshot");
    expect(delivered.snapshot.threads.map((thread) => thread.id)).toEqual(
      snapshot.snapshot.threads.map((thread) => thread.id),
    );
    expect(delivered.snapshot.projects[0]?.scripts[0]?.command).toBe(SECRET_SCRIPT_COMMAND);

    // The browser client advertised, so the node compressed every thread page.
    // Each page is an acknowledged chunk, so getting past the first proves the
    // split first message (its `snapshot-begin` alone, then its compressed
    // threads) was acknowledged exactly once.
    const plainBytes = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
    const compressed = session.nodeMessages.filter(isCompressedRelayPayload);
    expect(compressed.length).toBeGreaterThan(2);
    const wire = compressed.reduce((sum, frame) => sum + frame.byteLength, 0);
    expect(wire).toBeLessThan(plainBytes / 5);
    // Project data travelled uncompressed, in a message of its own.
    const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
    const withProjects = session.nodeMessages.filter((bytes) => text(bytes).includes("hunter2"));
    expect(withProjects).toHaveLength(1);
    expect(isCompressedRelayPayload(withProjects[0]!)).toBe(false);
    expect(text(withProjects[0]!)).not.toContain('"snapshot-threads"');
    const physical = physicalSockets.at(-1)!;
    const advertised = physical.receivedFromClient.filter(
      (frame) =>
        frame.type === "data" &&
        hasRelayCompressionAdvertisement(stripRelayChunkCapabilityPrelude(frame.payload).message),
    );
    expect(advertised.length).toBeGreaterThan(0);
    await closeHostedShellSession(session);
  });

  it("sends plain bytes to a client that cannot inflate, from the same compressing node", async () => {
    // An old client: it never advertises, so the node must not compress for it.
    const original = globalThis.DecompressionStream;
    Object.defineProperty(globalThis, "DecompressionStream", {
      configurable: true,
      writable: true,
      value: undefined,
    });
    try {
      const snapshot = largeShellSnapshot(500);
      const session = await openHostedShellSession({
        subscribeShell: (input) => Stream.concat(shellItems(snapshot, input), Stream.never),
        compressResponses: true,
      });
      await vi.waitFor(() => expect(session.received).toHaveLength(1), { timeout: 5_000 });
      expect(session.nodeMessages.some(isCompressedRelayPayload)).toBe(false);
      const physical = physicalSockets.at(-1)!;
      expect(
        physical.receivedFromClient.some(
          (frame) =>
            frame.type === "data" &&
            hasRelayCompressionAdvertisement(
              stripRelayChunkCapabilityPrelude(frame.payload).message,
            ),
        ),
      ).toBe(false);
      await closeHostedShellSession(session);
    } finally {
      Object.defineProperty(globalThis, "DecompressionStream", {
        configurable: true,
        writable: true,
        value: original,
      });
    }
  });
});

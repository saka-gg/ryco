/**
 * Cross-node project copy through the Hub relay, in one process: the client reaches node A and
 * node B only through relay channels, and the copy runs as the app runs it.
 *
 * WHAT IS REAL
 * - Each node is built as `server.ts` builds it (`ProjectCopyServicesDeferredLive` over its own
 *   state directory, database and orchestration engine), and serves the copy RPCs with the
 *   production handlers (`makeProjectCopyHandlers`) for the principal the hub connector gives a
 *   relay channel (`relayChannelPrincipal`), through the relay connector's own stack: a channel
 *   registry over a send queue, and an RPC byte session over `WsNodeRpcGroup`.
 * - The client is the production one: `WsTransport` and `createWsRpcClient` (the copy calls
 *   load as they do in the app), the planner (`planProjectCopyOptions`,
 *   `buildProjectCopyRunPlan`) and the coordinator (`startProjectCopy`) with its chunk pipeline.
 * - Every RPC message crosses as relay `data` frames, encoded and decoded with the relay codec,
 *   laid out by the shared chunk layer (`prepareRelayMessage`, `RelayMessageAssembler`) the
 *   client's relay engine uses on a plaintext channel, with the node's flow control honoured.
 *
 * WHAT IS MODELLED
 * - The Hub only forwards frames between the client and each node's registry.
 * - E2EE: what the node reads from a channel is its mode (`e2ee` or `legacy`), through the same
 *   `relayChannelPrincipal` seam the hub connector uses. The NX handshake and the record layer are
 *   not run here (the hosted multi-node harness runs them, but serves only the shell RPCs from
 *   seeded data and holds one node at a time; see its header). Bytes cross in the clear in both
 *   modes; the node's decision is what is under test.
 *
 * Opt in: RYCO_RELAY_COPY_TEST=1 (two nodes and real git; about ten seconds).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, assert, describe, it } from "@effect/vitest";
import { CommandId, EnvironmentId, ProjectId } from "@ryco/contracts";
import {
  buildProjectCopyRunPlan,
  judgeCopyDestination,
  PROJECT_COPY_IMPORT_LOOKUP_TIMEOUT_MS,
  planProjectCopyOptions,
  relayTooLargeMessage,
  startProjectCopy,
  type ProjectCopyIo,
  type ProjectCopyNodeApi,
  type ProjectCopyPlanningInput,
  type ProjectCopyTransport,
} from "@ryco/client-runtime/projectCopy";
import { createWsRpcClient, WsTransport, type WsRpcClient } from "@ryco/client-runtime/rpc";
import { PROJECT_COPY_WS_METHODS } from "@ryco/contracts/project-copy-methods";
import {
  PROJECT_COPY_CHUNK_BYTES,
  PROJECT_COPY_RELAY_MAX_ARTIFACT_BYTES,
  ProjectTransferId,
  type ProjectExportInspection,
} from "@ryco/contracts/project-copy";
import { WsNodeRpcGroup } from "@ryco/contracts/project-copy-rpc";
import {
  RELAY_INITIAL_LIMITS,
  RELAY_MAX_RPC_MESSAGE_BYTES,
  RELAY_PROTOCOL_MINOR,
  type RelayChannelId,
  type RelayFrame,
} from "@ryco/contracts/relay";
import { decodeRelayFrame, encodeRelayFrame } from "@ryco/shared/relayCodec";
import { prepareRelayMessage, RelayMessageAssembler } from "@ryco/shared/relayMessageChunks";
import { Effect, Exit, Layer, Option, Scope } from "effect";

import { authorizeRpcPrincipal } from "../auth/wsAuthorization.ts";
import { relayChannelPrincipal } from "../hubConnector/relayChannelAuthority.ts";
import { RelayChannelRegistry } from "../hubConnector/RelayChannelRegistry.ts";
import { RelaySendQueue } from "../hubConnector/RelaySendQueue.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { WsRpcContext } from "../ws/context.ts";
import { makeProjectCopyHandlers } from "../ws/projectCopyRpc.ts";
import { rpcAccessFor } from "../ws/RpcAccessPolicy.ts";
import { makeRpcByteSession } from "../ws/RpcByteSession.ts";
import { ProjectCopyServicesDeferredLive } from "./Layers/ProjectCopyServicesDeferred.ts";
import { commitFiles, git, initRepository, tempRoots } from "./projectCopyGit.fixtures.ts";
import { startProjectCopyNode } from "./projectCopyNodes.fixtures.ts";
import { GitNetwork } from "./Services/GitNetwork.ts";
import { NodePaths } from "./Services/NodePaths.ts";
import { ProjectExport } from "./Services/ProjectExport.ts";
import { ProjectImports } from "./Services/ProjectImports.ts";
import { ProjectTransfers } from "./Services/ProjectTransfers.ts";

const roots = tempRoots();
afterEach(() => roots.cleanup());

const RELAY_VERSION = { protocolMajor: 1, protocolMinor: RELAY_PROTOCOL_MINOR } as const;
const LIMITS = RELAY_INITIAL_LIMITS;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const A = EnvironmentId.make("node-a");
const B = EnvironmentId.make("node-b");
const LABELS: Record<string, string> = { [A]: "Node A", [B]: "Node B" };

type ChannelMode = "e2ee" | "legacy";

const startNode = (name: string) =>
  startProjectCopyNode(roots, name, ProjectCopyServicesDeferredLive);
type TestNode = Effect.Success<ReturnType<typeof startNode>>;

// ── The wire ──────────────────────────────────────────────────────────

/** One RPC message as it crossed a relay channel. */
interface WireMessage {
  readonly direction: "to-node" | "to-client";
  /** The RPC method of the request it is, or answers. */
  readonly tag: string | undefined;
  readonly bytes: number;
  /** Relay `data` frames it took. */
  readonly frames: number;
  readonly json: {
    readonly _tag: string;
    readonly id?: string;
    readonly requestId?: string;
    readonly tag?: string;
    readonly payload?: unknown;
    readonly exit?: { readonly _tag: string; readonly value?: unknown };
  };
}

const parseMessage = (bytes: Uint8Array): WireMessage["json"] =>
  JSON.parse(decoder.decode(bytes)) as WireMessage["json"];

const roundTripFrame = (frame: RelayFrame): RelayFrame => {
  const encoded = encodeRelayFrame(frame);
  if (!encoded.ok) throw new Error(`relay frame did not encode: ${encoded.error.code}`);
  const decoded = decodeRelayFrame(encoded.value);
  if (!decoded.ok) throw new Error(`relay frame did not decode: ${decoded.error.code}`);
  return decoded.value;
};

/**
 * The client's end of one relay channel, shaped like the hosted relay socket the app hands the
 * RPC transport: messages go out as relay `data` frames, and frames coming back are reassembled
 * into messages. The Hub in between only forwards.
 */
class RelayChannelSocket extends EventTarget {
  readyState = 0;
  binaryType = "arraybuffer";
  readonly #assembler = new RelayMessageAssembler();
  readonly #toNode: (frame: RelayFrame) => void;
  readonly #wire: WireMessage[];
  readonly #requestTags: Map<string, string>;
  readonly #channelId: RelayChannelId;
  #sequence = 0;
  #paused = false;
  #held: RelayFrame[] = [];
  #inboundFrames = 0;

  constructor(options: {
    readonly channelId: RelayChannelId;
    readonly toNode: (frame: RelayFrame) => void;
    readonly wire: WireMessage[];
    readonly requestTags: Map<string, string>;
  }) {
    super();
    this.#channelId = options.channelId;
    this.#toNode = options.toNode;
    this.#wire = options.wire;
    this.#requestTags = options.requestTags;
  }

  get bufferedAmount(): number {
    return 0;
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (this.readyState !== 1) throw new Error("Relay channel is not open.");
    const message =
      typeof data === "string"
        ? encoder.encode(data)
        : ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data);
    const prepared = prepareRelayMessage(message, {
      maxChunkBytes: LIMITS.maxDataChunkBytes,
      maxMessageBytes: Math.min(
        RELAY_MAX_RPC_MESSAGE_BYTES,
        LIMITS.maxQueuedBytes - LIMITS.maxControlFrameBytes,
      ),
      peerSupportsChunking: this.#assembler.peerSupportsChunking,
    });
    if (prepared.kind === "error") throw new Error(`relay refused the message: ${prepared.reason}`);
    const json = parseMessage(message);
    if (json._tag === "Request" && json.id !== undefined && json.tag !== undefined) {
      this.#requestTags.set(json.id, json.tag);
    }
    this.#wire.push({
      direction: "to-node",
      tag: json.tag,
      bytes: message.byteLength,
      frames: prepared.payloads.length,
      json,
    });
    for (const payload of prepared.payloads) {
      const frame = roundTripFrame({
        type: "data",
        ...RELAY_VERSION,
        channelId: this.#channelId,
        sequence: this.#sequence++ as never,
        payload: Uint8Array.from(payload),
      });
      if (this.#paused) this.#held.push(frame);
      else this.#toNode(frame);
    }
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event("close"), { code, reason }));
  }

  /** A frame the Hub forwarded from the node. */
  fromNode(frame: RelayFrame): void {
    switch (frame.type) {
      case "channel.accept":
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
        return;
      case "flow.pause":
        this.#paused = true;
        return;
      case "flow.resume": {
        this.#paused = false;
        const held = this.#held;
        this.#held = [];
        for (const entry of held) this.#toNode(entry);
        return;
      }
      case "channel.close":
        this.close(1000, frame.reason ?? "");
        return;
      case "data": {
        this.#inboundFrames += 1;
        const assembled = this.#assembler.push(frame.payload);
        if (assembled.kind === "error") throw new Error(`reassembly failed: ${assembled.reason}`);
        if (assembled.kind === "pending") return;
        const json = parseMessage(assembled.message);
        const requestId = json.requestId;
        this.#wire.push({
          direction: "to-client",
          tag: requestId === undefined ? undefined : this.#requestTags.get(requestId),
          bytes: assembled.message.byteLength,
          frames: this.#inboundFrames,
          json,
        });
        this.#inboundFrames = 0;
        this.dispatchEvent(new MessageEvent("message", { data: assembled.message }));
        return;
      }
      default:
        return;
    }
  }
}

/** A client's relay channel to one node, with the node's side of it. */
interface RelayLink {
  readonly client: WsRpcClient;
  readonly wire: WireMessage[];
  readonly close: () => Promise<void>;
}

/** The node's copy services, as the server's RPC context reads them. */
const projectCopyServicesOf = (node: TestNode) =>
  Effect.runPromise(
    node.run(
      Effect.all({
        nodePaths: Effect.serviceOption(NodePaths),
        gitNetwork: Effect.serviceOption(GitNetwork),
        projectExport: Effect.serviceOption(ProjectExport),
        projectTransfers: Effect.serviceOption(ProjectTransfers),
        projectImports: Effect.serviceOption(ProjectImports),
      }),
    ),
  );

/**
 * Opens a relay channel from the client to `node`, as an owner, in `mode`: the node accepts it
 * through its registry, and the client's transport reaches the node only through it.
 */
const openRelayLink = async (node: TestNode, mode: ChannelMode): Promise<RelayLink> => {
  const channelId = `ch_${randomUUID().replaceAll("-", "").slice(0, 22)}` as RelayChannelId;
  const projectCopy = await projectCopyServicesOf(node);
  const wire: WireMessage[] = [];
  const requestTags = new Map<string, string>();
  const scopes: Scope.Closeable[] = [];
  let socket: RelayChannelSocket | null = null;

  // Node → Hub → client, one frame after another.
  let toClient: Promise<void> = Promise.resolve();
  const sendQueue = new RelaySendQueue(
    {
      bufferedAmount: 0,
      send: (bytes) => {
        const decoded = decodeRelayFrame(Uint8Array.from(bytes));
        if (!decoded.ok) throw new Error(`node sent an undecodable frame: ${decoded.error.code}`);
        toClient = toClient.then(() => socket?.fromNode(decoded.value));
      },
    },
    LIMITS,
  );
  const registry = new RelayChannelRegistry({
    limits: LIMITS,
    protocol: RELAY_VERSION,
    sendQueue,
    onOutboundReady: () => sendQueue.flush(),
    factory: {
      open: async ({ channelId: opened, effectiveRole, send }) => {
        // What the hub connector builds per channel: the principal reads the channel's mode.
        const principal = relayChannelPrincipal(
          effectiveRole,
          opened,
          { mode: () => mode },
          () => ({ trustSource: "none" }),
        );
        const guard = <A, E, R>(method: string, effect: Effect.Effect<A, E, R>) =>
          authorizeRpcPrincipal(principal, rpcAccessFor(method), method).pipe(
            Effect.flatMap(() => effect),
          );
        const handlers = makeProjectCopyHandlers({
          principal,
          connection: principal.connection,
          projectCopy,
          ownerEffect: guard,
          ownerStreamEffect: guard,
          readNodeTailscaleAddresses: Effect.succeed(undefined),
        } as unknown as WsRpcContext);
        const scope = await Effect.runPromise(Scope.make("sequential"));
        scopes.push(scope);
        const session = await Effect.runPromise(
          makeRpcByteSession(
            WsNodeRpcGroup,
            WsNodeRpcGroup.toLayer(Effect.succeed(WsNodeRpcGroup.of(handlers as never))),
            (bytes) =>
              Effect.sync(() => {
                if (!send(bytes).accepted) throw new Error("relay output refused");
              }),
            { queueCapacity: 64 },
          ).pipe(Effect.provideService(Scope.Scope, scope)),
        );
        return {
          receive: (bytes) => Effect.runPromise(session.receive(bytes)),
          queuedBytes: () => Effect.runPromise(session.queuedBytes),
          supportsChunkedMessages: session.supportsChunkedMessages,
          close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
        };
      },
    },
  });

  // Client → Hub → node, one frame after another.
  let toNode: Promise<void> = Promise.resolve();
  const deliverToNode = (frame: RelayFrame) => {
    toNode = toNode.then(() => registry.handle(frame));
  };

  const transport = new WsTransport(
    `wss://hub.example.test/relay/${channelId}`,
    {
      observability: {
        tracingLayer: Layer.empty,
        performanceEnabled: () => false,
        recordPerformance: () => undefined,
      },
      socket: {
        webSocketConstructor: () => {
          throw new Error("The relay link provides its own socket.");
        },
      },
    },
    {
      preserveSocketPath: true,
      retryTransientErrors: false,
      webSocketConstructor: () => {
        socket = new RelayChannelSocket({ channelId, toNode: deliverToNode, wire, requestTags });
        // The Hub opens the channel on the node; its `channel.accept` opens the client's end.
        deliverToNode(
          roundTripFrame({
            type: "channel.open",
            ...RELAY_VERSION,
            channelId,
            capability: "ryco.rpc",
            effectiveRole: "owner",
          }),
        );
        return socket as unknown as WebSocket;
      },
    },
  );
  const client = createWsRpcClient(transport);
  return {
    client,
    wire,
    close: async () => {
      await client.dispose();
      await toNode;
      await registry.closeAll();
      for (const scope of scopes) await Effect.runPromise(Scope.close(scope, Exit.void));
    },
  };
};

/**
 * Retry delays pass at once; a lookup's timeout waits for its signal, so an answer that is on its
 * way is never cut short.
 */
const sleep = async (ms: number, signal: AbortSignal): Promise<void> => {
  if (ms !== PROJECT_COPY_IMPORT_LOOKUP_TIMEOUT_MS || signal.aborted) return;
  await new Promise<void>((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
};

/** The app's copy I/O, every node relayed. */
const relayedIo = (links: ReadonlyMap<EnvironmentId, RelayLink>): ProjectCopyIo => {
  const apiOf = (environmentId: EnvironmentId): ProjectCopyNodeApi => {
    const link = links.get(environmentId);
    if (link === undefined) throw new Error(`No relay link to ${environmentId}.`);
    return link.client as unknown as ProjectCopyNodeApi;
  };
  return {
    acquireNode: async ({ environmentId }) => ({
      environmentId,
      transport: "relay",
      release: () => undefined,
    }),
    withLease: (environmentId, call) => call(apiOf(environmentId)),
    withNode: (environmentId, call) => call(apiOf(environmentId), new AbortController().signal),
    now: () => Date.now(),
    uuid: () => randomUUID(),
    sleep,
  };
};

// ── Fixture ───────────────────────────────────────────────────────────

/** Incompressible, so the repository bundle spans several relay-sized chunks. */
const BLOB = randomBytes(3 * PROJECT_COPY_CHUNK_BYTES + 12_345);
const SECRET = "SECRET=on-a\n";

/** Registers `workspaceRoot` as a project on `node`. */
const registerProject = (node: TestNode, workspaceRoot: string, title: string) =>
  node.run(
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const projectId = ProjectId.make(`source-${randomUUID()}`);
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make(`create-${projectId}`),
        projectId,
        title,
        workspaceRoot,
        projectMetadataDir: ".ryco",
        createWorkspaceRootIfMissing: false,
        createdAt: new Date().toISOString(),
      });
      return projectId;
    }),
  );

/** A's checkout without a remote: committed files, uncommitted changes and an ignored `.env`. */
const makeSourceCheckout = () => {
  const source = initRepository(path.join(roots.make("ryco-xnode-relay-a-"), "app"));
  commitFiles(
    source,
    { "README.md": "# App\n", ".gitignore": ".env\n", "assets/blob.bin": BLOB },
    "first",
  );
  writeFileSync(path.join(source, "README.md"), "# App\n\nEdited on A.\n");
  writeFileSync(path.join(source, "notes.txt"), "untracked\n");
  writeFileSync(path.join(source, ".env"), SECRET);
  return source;
};

/** A fresh `Code` folder on B. */
const codeFolderOnB = () => {
  const code = path.join(roots.make("ryco-xnode-relay-b-"), "Code");
  mkdirSync(code);
  return code;
};

const planningFor = (input: {
  readonly inspection: ProjectExportInspection;
  readonly transport: ProjectCopyTransport;
  readonly destination: ProjectCopyPlanningInput["target"]["destination"];
}): ProjectCopyPlanningInput => ({
  source: {
    kind: "inspected",
    environmentId: A,
    label: LABELS[A]!,
    platformOs: null,
    transport: input.transport,
    checkoutPath: null,
    inspection: input.inspection,
  },
  target: {
    label: LABELS[B]!,
    platformOs: null,
    projectCopySupport: "yes",
    transport: input.transport,
    remoteAccess: null,
    destination: input.destination,
  },
});

/** Raw bytes of the base64 chunks a method carried, in either direction. */
const chunkBytesOf = (wire: ReadonlyArray<WireMessage>, method: string): number[] =>
  wire.flatMap((message) => {
    if (message.tag !== method) return [];
    const data =
      message.direction === "to-node"
        ? (message.json.payload as { readonly dataBase64?: string } | undefined)?.dataBase64
        : (message.json.exit?.value as { readonly dataBase64?: string } | undefined)?.dataBase64;
    return data === undefined ? [] : [Buffer.from(data, "base64").byteLength];
  });

/** What a node announced as the largest chunk over this connection. */
const announcedChunkBytes = (wire: ReadonlyArray<WireMessage>, method: string): number[] =>
  wire.flatMap((message) => {
    if (message.direction !== "to-client" || message.tag !== method) return [];
    const value = message.json.exit?.value as { readonly maxChunkBytes?: number } | undefined;
    return value?.maxChunkBytes === undefined ? [] : [value.maxChunkBytes];
  });

const IGNORED_FILES_LEFT_OUT = (label: string) =>
  `The ignored files were not copied: they are only sent over an encrypted connection, and the one to ${label} is not.`;

// ── Tests ─────────────────────────────────────────────────────────────

const CASES: ReadonlyArray<{
  readonly a: ChannelMode;
  readonly b: ChannelMode;
  readonly envArrives: boolean;
  /** The node whose channel kept the ignored files out, named in the warning. */
  readonly withheldBy: EnvironmentId | null;
}> = [
  { a: "e2ee", b: "e2ee", envArrives: true, withheldBy: null },
  { a: "legacy", b: "legacy", envArrives: false, withheldBy: A },
  { a: "e2ee", b: "legacy", envArrives: false, withheldBy: B },
];

describe.runIf(process.env.RYCO_RELAY_COPY_TEST === "1")(
  "project copy through the Hub relay",
  () => {
    for (const testCase of CASES) {
      it.live(
        `sends the files from A (${testCase.a}) to B (${testCase.b}) in relay-sized chunks`,
        () =>
          Effect.gen(function* () {
            const a = yield* startNode("relay-a");
            const b = yield* startNode("relay-b");
            const source = makeSourceCheckout();
            const projectId = yield* registerProject(a, source, "App");
            const linkA = yield* Effect.promise(() => openRelayLink(a, testCase.a));
            const linkB = yield* Effect.promise(() => openRelayLink(b, testCase.b));
            yield* Effect.addFinalizer(() =>
              Effect.promise(() => Promise.all([linkA.close(), linkB.close()])),
            );

            // The dialog: inspect A, preview the destination on B, plan, run.
            const inspection = yield* Effect.promise(() =>
              linkA.client.projects.exportInspect({ projectId }),
            );
            assert.include(
              inspection.workingTree.ignoredCandidates.map((candidate) => candidate.path),
              ".env",
            );
            const destinationPath = path.join(codeFolderOnB(), "app");
            const preview = yield* Effect.promise(() =>
              linkB.client.projects.previewDestination({ path: destinationPath }),
            );
            const planning = planningFor({
              inspection,
              transport: "relay",
              destination: judgeCopyDestination({ preview, sourceCanonicalKey: null }),
            });
            const options = planProjectCopyOptions(planning, {
              mode: "send-files",
              bringChanges: true,
              ignoredPaths: [".env"],
            });
            assert.isTrue(options.relayed);
            assert.isNull(options.blockedReason);
            assert.isTrue(options.modes.sendFiles.available);
            assert.deepEqual(options.choices.ignoredPaths, [".env"]);
            const built = buildProjectCopyRunPlan({
              planning,
              options,
              target: { environmentId: B, pathSeparator: "/" },
              setup: null,
              followUpThread: null,
              origin: { kind: "user", sourceLabel: LABELS[A]!, proposalId: null },
            });
            assert.isTrue(built.ok, built.ok ? undefined : built.reason);
            if (!built.ok) return;

            const run = startProjectCopy({
              io: relayedIo(
                new Map([
                  [A, linkA],
                  [B, linkB],
                ]),
              ),
              plan: built.plan,
            });
            const outcome = yield* Effect.promise(() => run.done);
            assert.equal(outcome.progress.phase, "done", JSON.stringify(outcome.progress.error));
            assert.isNotNull(outcome.project);
            if (outcome.project === null) return;

            // (a) Chunks stay at 160 KiB both ways, and every chunk message fits one relay frame.
            const wire = [...linkA.wire, ...linkB.wire];
            assert.deepEqual(
              [...new Set(announcedChunkBytes(linkA.wire, PROJECT_COPY_WS_METHODS.exportStart))],
              [PROJECT_COPY_CHUNK_BYTES],
            );
            assert.deepEqual(
              [...new Set(announcedChunkBytes(linkB.wire, PROJECT_COPY_WS_METHODS.transferBegin))],
              [PROJECT_COPY_CHUNK_BYTES],
            );
            // A's chunks come back in its answers; B's go out in the requests.
            for (const [method, direction] of [
              [PROJECT_COPY_WS_METHODS.exportReadChunk, "to-client"],
              [PROJECT_COPY_WS_METHODS.transferAppend, "to-node"],
            ] as const) {
              const chunks = chunkBytesOf(wire, method);
              assert.isAtLeast(chunks.length, 4, method);
              assert.equal(Math.max(...chunks), PROJECT_COPY_CHUNK_BYTES, method);
              const messages = wire.filter(
                (message) => message.tag === method && message.direction === direction,
              );
              assert.isTrue(
                messages.every((message) => message.frames === 1),
                `${method}: a chunk message took more than one relay frame`,
              );
              assert.isAtMost(
                Math.max(...messages.map((message) => message.bytes)),
                LIMITS.maxDataChunkBytes,
              );
            }

            // (c) The .env travels only when both legs are encrypted end to end.
            const expectedWarnings =
              testCase.withheldBy === null
                ? []
                : [IGNORED_FILES_LEFT_OUT(LABELS[testCase.withheldBy]!)];
            assert.deepEqual(outcome.project.warnings, expectedWarnings);

            // (d) B has the checkout and the project.
            const destination = outcome.project.workspaceRoot;
            assert.equal(destination, destinationPath);
            if (destination === null) return;
            assert.equal(git(destination, "rev-parse", "HEAD"), git(source, "rev-parse", "HEAD"));
            for (const relative of ["README.md", "notes.txt", "assets/blob.bin", ".gitignore"]) {
              assert.deepEqual(
                readFileSync(path.join(destination, relative)),
                readFileSync(path.join(source, relative)),
                relative,
              );
            }
            assert.equal(existsSync(path.join(destination, ".env")), testCase.envArrives);
            if (testCase.envArrives) {
              assert.equal(readFileSync(path.join(destination, ".env"), "utf8"), SECRET);
            }
            const copied = outcome.project.projectId;
            yield* b.run(
              Effect.gen(function* () {
                const project = yield* (yield* ProjectionSnapshotQuery).getProjectShellById(copied);
                assert.isTrue(Option.isSome(project));
                if (Option.isNone(project)) return;
                assert.equal(project.value.title, "App");
                assert.equal(project.value.workspaceRoot, destinationPath);
              }),
            );

            // Over the relay, B refuses a chunk past 160 KiB, whatever the client asks.
            const transferId = ProjectTransferId.make(randomUUID());
            yield* Effect.promise(() =>
              linkB.client.projects.transferBegin({
                transferId,
                purpose: "repository-bundle",
                byteLength: 2 * PROJECT_COPY_CHUNK_BYTES,
                sha256: "0".repeat(64),
              }),
            );
            const oversized = yield* Effect.promise(() =>
              linkB.client.projects
                .transferAppend({
                  transferId,
                  offset: 0,
                  dataBase64: Buffer.alloc(PROJECT_COPY_CHUNK_BYTES + 1).toString("base64"),
                })
                .then(
                  () => null,
                  (error: unknown) =>
                    error as { readonly code?: string; readonly message?: string },
                ),
            );
            assert.equal(oversized?.code, "invalid");
            assert.include(oversized?.message ?? "", String(PROJECT_COPY_CHUNK_BYTES));
            yield* Effect.promise(() => linkB.client.projects.transferAbort({ transferId }));
          }).pipe(Effect.scoped),
        { timeout: 120_000 },
      );
    }

    it.live(
      "a repository over the relay cap can't be sent through the Hub, and the planner says why",
      () =>
        Effect.gen(function* () {
          const a = yield* startNode("relay-cap-a");
          const b = yield* startNode("relay-cap-b");
          const source = initRepository(path.join(roots.make("ryco-xnode-relay-cap-"), "big"));
          commitFiles(
            source,
            { "big.bin": randomBytes(PROJECT_COPY_RELAY_MAX_ARTIFACT_BYTES + 1024 * 1024) },
            "big",
          );
          git(source, "remote", "add", "origin", "git@fakehost:o/big.git");
          const projectId = yield* registerProject(a, source, "Big");
          const linkA = yield* Effect.promise(() => openRelayLink(a, "e2ee"));
          const linkB = yield* Effect.promise(() => openRelayLink(b, "e2ee"));
          yield* Effect.addFinalizer(() =>
            Effect.promise(() => Promise.all([linkA.close(), linkB.close()])),
          );

          const inspection = yield* Effect.promise(() =>
            linkA.client.projects.exportInspect({ projectId }),
          );
          const bundle = inspection.estimates.find((entry) => entry.kind === "repository-bundle");
          assert.isDefined(bundle);
          assert.isAbove(bundle!.estimatedBytes, PROJECT_COPY_RELAY_MAX_ARTIFACT_BYTES);
          const destinationPath = path.join(codeFolderOnB(), "big");
          const destination = judgeCopyDestination({
            preview: yield* Effect.promise(() =>
              linkB.client.projects.previewDestination({ path: destinationPath }),
            ),
            sourceCanonicalKey: null,
          });

          // (b) Relayed: Send files is off, with the reason the dialog shows; cloning stays.
          const relayed = planProjectCopyOptions(
            planningFor({ inspection, transport: "relay", destination }),
            { mode: "send-files" },
          );
          assert.isTrue(relayed.relayed);
          assert.isFalse(relayed.modes.sendFiles.available);
          assert.equal(
            relayed.modes.sendFiles.reason,
            relayTooLargeMessage(bundle!.estimatedBytes),
          );
          assert.match(
            relayed.modes.sendFiles.reason ?? "",
            /^Too large to send through the Hub \(\d+ MB\)\. Push the branch, or connect both devices directly\.$/,
          );
          assert.equal(relayed.choices.mode, "clone");
          assert.isNull(relayed.blockedReason);

          // Directly connected, the same repository may be sent.
          const direct = planProjectCopyOptions(
            planningFor({ inspection, transport: "direct", destination }),
            { mode: "send-files" },
          );
          assert.isTrue(direct.modes.sendFiles.available);
          assert.equal(direct.choices.mode, "send-files");

          // A plan made while both were direct, run once they are relayed: the coordinator stops
          // before a byte goes through the Hub.
          const built = buildProjectCopyRunPlan({
            planning: planningFor({ inspection, transport: "direct", destination }),
            options: direct,
            target: { environmentId: B, pathSeparator: "/" },
            setup: null,
            followUpThread: null,
            origin: { kind: "user", sourceLabel: LABELS[A]!, proposalId: null },
          });
          assert.isTrue(built.ok);
          if (!built.ok) return;
          const outcome = yield* Effect.promise(
            () =>
              startProjectCopy({
                io: relayedIo(
                  new Map([
                    [A, linkA],
                    [B, linkB],
                  ]),
                ),
                plan: built.plan,
              }).done,
          );
          assert.equal(outcome.progress.phase, "failed");
          assert.equal(outcome.progress.error?.code, "too-large");
          assert.match(outcome.progress.error?.message ?? "", /^Too large to send through the Hub/);
          assert.deepEqual(chunkBytesOf(linkB.wire, PROJECT_COPY_WS_METHODS.transferAppend), []);
          assert.isFalse(existsSync(destinationPath));
        }).pipe(Effect.scoped),
      { timeout: 120_000 },
    );
  },
);

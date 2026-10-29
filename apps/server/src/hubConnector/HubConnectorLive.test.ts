import { dirname, join } from "node:path";

import { EnvironmentId } from "@ryco/contracts";
import type { RelayChannelId, RelayChannelOpenFrame, RelayLimits } from "@ryco/contracts/relay";
import { decodeRelayFrame } from "@ryco/shared/relayCodec";
import { Effect, Layer, Option, Tracer } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { HUB_CONNECTED_EXTERNAL_TOPOLOGY } from "../agentControl/externalTopology.ts";
import { AgentControlExternalTopologyService } from "../agentControl/Services/AgentControlExternalTopology.ts";
import {
  DEFAULT_HUB_CONNECTOR_CONFIG,
  DEFAULT_NODE_E2EE_POLICY_CONFIG,
  ServerConfig,
  type ServerConfigShape,
} from "../config.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import type { HubIdentityProcessLockResult } from "../hubIdentity/HubIdentityProcessLock.ts";
import type { ProjectionStubbedShellSnapshot } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { HubIdentityInUseError } from "./HubConnector.ts";
import {
  HubConnectorService,
  type HubConnectorServiceShape,
  instrumentRelayChannelOpens,
  makeHubConnectorLive,
  relayChannelShellWarmUp,
} from "./HubConnectorLive.ts";
import type { HubIdentityRuntimeShape } from "./HubIdentityRuntime.ts";
import {
  RelayChannelRegistry,
  type RelayChannelSessionFactory,
  type RelayRpcChannelSession,
} from "./RelayChannelRegistry.ts";
import { RelaySendQueue } from "./RelaySendQueue.ts";

const HUB_ORIGIN = "https://relay.example";
const STATE_PATH = "/nonexistent/ryco-hub-connector-live/userdata/hub-identity.json";

const key = { hubOrigin: HUB_ORIGIN, accountId: "acct_owner", fingerprint: "SHA256:fixture" };

/**
 * A runtime that records every member it is asked to run, by path, and runs
 * none of them — so a member that a refused operation reached shows up as a
 * call. Not enrolled, so a connector that does get the identity has nothing to
 * connect to.
 */
function recordingRuntime(calls: string[]): HubIdentityRuntimeShape {
  const member = (path: string): unknown =>
    new Proxy(
      async () => {
        calls.push(path);
      },
      {
        get: (_target, property) =>
          typeof property === "string" && property !== "then"
            ? member(`${path}.${property}`)
            : undefined,
      },
    );
  return new Proxy({} as HubIdentityRuntimeShape, {
    get: (_target, property) => {
      if (typeof property !== "string" || property === "then") return undefined;
      if (property === "readState") {
        return async () => {
          calls.push("readState");
          return {
            version: 1,
            revision: 1,
            environmentId: `env_${"E".repeat(22)}`,
            protectedStoreBackend: null,
            pendingEnrollment: null,
            activeNode: null,
            stagedRotation: null,
            pendingTeardown: null,
          };
        };
      }
      return member(property);
    },
  });
}

/**
 * Build `HubConnectorLive` as it is wired, with only the lock file and key
 * custody replaced, and run `body` against the service it provides. Every
 * call either makes is recorded in `calls`, in order.
 */
async function withHubConnectorLive(
  lockAnswers: () => HubIdentityProcessLockResult,
  body: (service: HubConnectorServiceShape, calls: string[]) => Promise<void>,
): Promise<string[]> {
  const calls: string[] = [];
  const layer = makeHubConnectorLive({
    makeProcessLock: (path) => {
      calls.push(`lock at ${path}`);
      return {
        acquire: async () => {
          const answer = lockAnswers();
          calls.push(`lock.acquire: ${answer}`);
          return answer;
        },
        release: async () => {
          calls.push("lock.release");
        },
      };
    },
    makeIdentityRuntime: async (options) => {
      calls.push(`build runtime${options.deferStartup === true ? " with startup deferred" : ""}`);
      return recordingRuntime(calls);
    },
  }).pipe(
    Layer.provide(
      Layer.succeed(ServerConfig, {
        hubIdentityStatePath: STATE_PATH,
        secretsDir: "/nonexistent/ryco-hub-connector-live/secrets",
        hubConnector: { ...DEFAULT_HUB_CONNECTOR_CONFIG, enabled: true, origin: HUB_ORIGIN },
        hubE2eePolicy: DEFAULT_NODE_E2EE_POLICY_CONFIG,
      } as ServerConfigShape),
    ),
    Layer.provide(
      Layer.mock(ServerEnvironment)({
        getDescriptor: Effect.succeed({
          environmentId: EnvironmentId.make("environment-test"),
          label: "Test node",
          platform: { os: "darwin" as const, arch: "arm64" as const },
          serverVersion: "0.0.0-test",
          capabilities: {
            repositoryIdentity: false,
            threadSettlement: false,
            threadPriorityRanking: false,
          },
        }),
      }),
    ),
    Layer.provide(
      Layer.mock(AgentControlExternalTopologyService)({
        current: () => HUB_CONNECTED_EXTERNAL_TOPOLOGY,
        yieldToHub: Effect.void,
      }),
    ),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* HubConnectorService;
      yield* Effect.promise(() => body(service, calls));
    }).pipe(Effect.provide(layer)),
  );
  return calls;
}

/**
 * Each surface that writes what the identity's owner relies on, as the service
 * exposes it; `NodeE2eeOperator.test.ts` holds every E2EE command to the gate.
 */
const ownerOperations = (service: HubConnectorServiceShape) => ({
  "nativeNodeClaim.prepare": () => service.nativeNodeClaim.prepare(HUB_ORIGIN),
  "nativeNodeClaim.sign": () =>
    service.nativeNodeClaim.sign({} as Parameters<typeof service.nativeNodeClaim.sign>[0]),
  "nativeNodeClaim.commit": () =>
    service.nativeNodeClaim.commit({} as Parameters<typeof service.nativeNodeClaim.commit>[0]),
  "localIntroduction.descriptor": () => service.localIntroduction.descriptor(),
  "localIntroduction.complete": () =>
    service.localIntroduction.complete(
      {} as Parameters<typeof service.localIntroduction.complete>[0],
    ),
  "e2ee.approveClient": () =>
    service.e2ee.approveClient({ ...key, maxRole: "operator", capabilitySet: ["ryco.rpc"] }),
  "e2ee.revokeClient": () => service.e2ee.revokeClient(key),
  "e2ee.applyPolicy": () => service.e2ee.applyPolicy({ requireE2EE: true }),
  "e2ee.rotatePrekey": () => service.e2ee.rotatePrekey(),
  "e2ee.breakContinuityChain": () => service.e2ee.breakContinuityChain(),
});

describe("HubConnectorLive", () => {
  it("keeps a backend that lost the identity lock off the owner's work until it takes the lock over", async () => {
    let otherCopyRunning = true;
    const calls = await withHubConnectorLive(
      () => (otherCopyRunning ? "held" : "acquired"),
      async (service, calls) => {
        // One lock beside the identity, so every backend sharing the identity
        // contends for the same file — and taken before the runtime is built,
        // whose startup work belongs to the identity's owner.
        expect(calls.slice(0, 3)).toEqual([
          `lock at ${join(dirname(STATE_PATH), "hub-connector.lock")}`,
          "lock.acquire: held",
          "build runtime with startup deferred",
        ]);

        for (const [name, operation] of Object.entries(ownerOperations(service))) {
          await expect(operation(), name).rejects.toBeInstanceOf(HubIdentityInUseError);
        }
        // The continuity read can repair the chain, so it stays off the identity
        // as well — but it answers, so the owner's Security panel still loads
        // every read beside it and says which copy holds the identity.
        await expect(service.e2ee.readContinuity()).resolves.toMatchObject({
          status: "identity_in_use",
        });
        // Nothing the refused operations would have run reached the runtime,
        // and neither did the deferred startup work.
        expect(calls.filter((call) => !call.startsWith("lock"))).toEqual([
          "build runtime with startup deferred",
        ]);

        // The other copy exited: the next owner operation takes the identity
        // over and runs the deferred startup work before its own.
        otherCopyRunning = false;
        calls.length = 0;
        await service.nativeNodeClaim.prepare(HUB_ORIGIN);
        expect(calls.slice(0, 3)).toEqual([
          "lock.acquire: acquired",
          "completeStartup",
          "nativeNodeClaim.prepare",
        ]);
      },
    );
    expect(calls.at(-1)).toBe("lock.release");
  });

  it("asks an unusable lock once more before deciding whether startup waits for it", async () => {
    const answers: HubIdentityProcessLockResult[] = ["unavailable", "held"];
    await withHubConnectorLive(
      () => answers.shift() ?? "held",
      async (service, calls) => {
        expect(calls.slice(1, 4)).toEqual([
          "lock.acquire: unavailable",
          "lock.acquire: held",
          "build runtime with startup deferred",
        ]);
        await expect(service.e2ee.applyPolicy({ requireE2EE: true })).rejects.toBeInstanceOf(
          HubIdentityInUseError,
        );
      },
    );
  });

  it("lets the lock's owner run its startup at once and its owner operations without asking again", async () => {
    await withHubConnectorLive(
      () => "acquired",
      async (service, calls) => {
        expect(calls.slice(1, 3)).toEqual(["lock.acquire: acquired", "build runtime"]);
        await service.nativeNodeClaim.prepare(HUB_ORIGIN);
        expect(calls.filter((call) => call.startsWith("lock.acquire"))).toHaveLength(1);
        expect(calls).toContain("nativeNodeClaim.prepare");
      },
    );
  });
});

const channelId = `ch_${"A".repeat(22)}` as RelayChannelId;
const secondChannelId = `ch_${"B".repeat(22)}` as RelayChannelId;
const relayVersion = { protocolMajor: 1, protocolMinor: 2 } as const;
const relayLimits: RelayLimits = {
  maxControlFrameBytes: 1_024,
  maxDataChunkBytes: 1_024,
  maxQueuedBytes: 4_096,
  maxChannels: 2,
  heartbeatIntervalMs: 20_000,
  deadConnectionTimeoutMs: 45_000,
  authenticationDeadlineMs: 5_000,
};
const channelOpen: RelayChannelOpenFrame = {
  type: "channel.open",
  ...relayVersion,
  channelId,
  capability: "ryco.rpc",
  effectiveRole: "operator",
};

const macrotask = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * A relay connection's registry over the connector's channel opens: each
 * session announces itself with one data frame once accepted, as the E2EE
 * carrier does. `wire` lists the frame types the socket received, in order.
 */
function relayConnection(options: {
  readonly warm?: Effect.Effect<unknown, unknown> | undefined;
  readonly open?: () => Promise<void>;
  readonly run?: <A>(effect: Effect.Effect<A>) => Promise<A>;
}) {
  const wire: string[] = [];
  const runs: Promise<unknown>[] = [];
  let fatal = 0;
  const sessions: RelayChannelSessionFactory = {
    open: async ({ send }) => {
      await options.open?.();
      return {
        receive: async () => true,
        queuedBytes: async () => 0,
        supportsChunkedMessages: () => false,
        close: async () => undefined,
        onAccepted: () => {
          send(new Uint8Array([1]));
        },
      } satisfies RelayRpcChannelSession;
    },
  };
  const run = <A>(effect: Effect.Effect<A>): Promise<A> => {
    const result = options.run === undefined ? Effect.runPromise(effect) : options.run(effect);
    runs.push(result);
    return result;
  };
  const factory = instrumentRelayChannelOpens(sessions, { run, warm: options.warm });
  const sendQueue = new RelaySendQueue(
    {
      bufferedAmount: 0,
      send: (bytes) => {
        const frame = decodeRelayFrame(Uint8Array.from(bytes));
        wire.push(frame.ok ? frame.value.type : "undecodable");
      },
    },
    relayLimits,
  );
  const registry = new RelayChannelRegistry({
    limits: relayLimits,
    protocol: relayVersion,
    sendQueue,
    factory,
    onOutboundReady: () => sendQueue.flush(),
    onFatal: () => {
      fatal += 1;
    },
  });
  return {
    factory,
    registry,
    wire,
    fatal: () => fatal,
    /** Every effect the connector ran settled, none rejected. */
    settled: () => Promise.all(runs),
  };
}

describe("relay channel opens", () => {
  it("warm the shell once the channel's accept and carrier are on the wire", async () => {
    const wireWhenWarmed: string[][] = [];
    let finishOpen!: () => void;
    const opening = new Promise<void>((resolve) => {
      finishOpen = resolve;
    });
    const connection = relayConnection({
      open: () => opening,
      warm: Effect.sync(() => {
        wireWhenWarmed.push([...connection.wire]);
      }),
    });

    const handled = connection.registry.handle(channelOpen);
    await macrotask();
    // Nothing is warmed while the channel's session is still being prepared.
    expect(wireWhenWarmed).toEqual([]);
    finishOpen();
    await handled;
    await macrotask();
    await connection.settled();

    expect(wireWhenWarmed).toEqual([["channel.accept", "data"]]);
    expect(connection.wire).toEqual(["channel.accept", "data"]);
  });

  it("warm the node's stubbed shell, once per channel open", async () => {
    let reads = 0;
    const query = {
      getStubbedShellSnapshot: () =>
        Effect.sync(() => {
          reads += 1;
          return {} as ProjectionStubbedShellSnapshot;
        }),
    };
    const connection = relayConnection({ warm: relayChannelShellWarmUp(Option.some(query)) });

    await connection.registry.handle(channelOpen);
    await connection.registry.handle({ ...channelOpen, channelId: secondChannelId });
    await macrotask();
    await connection.settled();

    expect(reads).toBe(2);
    expect(connection.wire).toEqual(["channel.accept", "data", "channel.accept", "data"]);
    // Without a shell query that builds the stubbed form, nothing is warmed.
    expect(relayChannelShellWarmUp(Option.none())).toBeUndefined();
    expect(relayChannelShellWarmUp(Option.some({}))).toBeUndefined();
  });

  it("open the channel when the warm-up fails", async () => {
    for (const warm of [
      Effect.fail(new Error("database is locked")),
      Effect.die(new Error("shell build defect")),
    ]) {
      let attempts = 0;
      const connection = relayConnection({
        warm: Effect.suspend(() => {
          attempts += 1;
          return warm;
        }),
      });
      await connection.registry.handle(channelOpen);
      await macrotask();
      await connection.settled();

      expect(attempts).toBe(1);
      expect(connection.wire).toEqual(["channel.accept", "data"]);
      expect(connection.fatal()).toBe(0);
    }
  });

  it("rethrow a failed open unchanged and warm nothing", async () => {
    const failure = new Error("advertisement unavailable");
    let warmed = 0;
    const connection = relayConnection({
      open: () => Promise.reject(failure),
      warm: Effect.sync(() => {
        warmed += 1;
      }),
    });

    await expect(
      connection.factory.open({} as Parameters<RelayChannelSessionFactory["open"]>[0]),
    ).rejects.toBe(failure);
    await connection.registry.handle(channelOpen);
    await macrotask();
    await connection.settled();

    expect(connection.wire).toEqual(["channel.reject"]);
    expect(warmed).toBe(0);
  });

  it("are timed as root spans that carry their duration and nothing else", async () => {
    const spans: Tracer.NativeSpan[] = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const connection = relayConnection({
      // Inside another span, as a connection's own work may be.
      run: (effect) =>
        Effect.runPromise(
          effect.pipe(Effect.withSpan("relay.connection"), Effect.withTracer(tracer)),
        ),
    });
    await connection.registry.handle(channelOpen);
    await connection.settled();

    const opens = spans.filter((span) => span.name === "relay.channel.open");
    expect(opens).toHaveLength(1);
    const [open] = opens;
    expect(Option.isNone(open!.parent)).toBe(true);
    expect([...open!.attributes.keys()]).toEqual(["relay.channel.open.durationMs"]);
    expect(open!.attributes.get("relay.channel.open.durationMs")).toBeTypeOf("number");
    expect(open!.status._tag).toBe("Ended");
  });
});

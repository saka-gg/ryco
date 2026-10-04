import { dirname, join } from "node:path";

import { EnvironmentId } from "@ryco/contracts";
import { Effect, Layer } from "effect";
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
import { HubIdentityInUseError } from "./HubConnector.ts";
import {
  HubConnectorService,
  type HubConnectorServiceShape,
  makeHubConnectorLive,
} from "./HubConnectorLive.ts";
import type { HubIdentityRuntimeShape } from "./HubIdentityRuntime.ts";

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

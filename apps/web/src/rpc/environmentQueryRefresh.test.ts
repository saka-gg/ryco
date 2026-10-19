import { EnvironmentId } from "@ryco/contracts";
import {
  createHostedEnvironmentSessions,
  hostedBrowserRevalidated,
  type HostedBrowserStatus,
  type HostedHubNode,
} from "@ryco/client-runtime/authorization";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createEnvironmentQueryRefreshCoordinator,
  isHostedEnvironmentQueryRefreshReady,
  isHostedRecordQueryRefreshReady,
  type HostedEnvironmentQueryRefreshState,
  type HostedRecordQueryRefreshState,
} from "./environmentQueryRefresh";

const environmentId = EnvironmentId.make("environment-query-refresh-test");

function makeHarness() {
  const fence = vi.fn();
  const refresh = vi.fn(async () => undefined);
  return {
    fence,
    refresh,
    coordinator: createEnvironmentQueryRefreshCoordinator({ fence, refresh }),
  };
}

describe("environment query refresh coordination", () => {
  it("refreshes a direct environment only after its current shell is ready", async () => {
    const harness = makeHarness();
    const generation = harness.coordinator.begin(environmentId);

    expect(harness.fence).toHaveBeenCalledWith(environmentId);
    expect(harness.refresh).not.toHaveBeenCalled();

    await expect(harness.coordinator.ready(environmentId, generation)).resolves.toBe(true);
    expect(harness.refresh).toHaveBeenCalledTimes(1);
  });

  it("keeps a hosted refresh gated until lifecycle ownership is ready", async () => {
    const harness = makeHarness();
    const generation = harness.coordinator.begin(environmentId);
    const readiness: HostedEnvironmentQueryRefreshState = {
      generation,
      selectedNode: { environmentId },
      directoryStatus: "ready",
      selectionStatus: "online",
      transportStatus: "online",
      sessionStatus: "replaying",
      sessionEstablished: false,
      browserStatus: "current",
    };

    await expect(
      harness.coordinator.ready(environmentId, generation, () =>
        isHostedEnvironmentQueryRefreshReady(readiness, environmentId, generation),
      ),
    ).resolves.toBe(false);
    expect(harness.refresh).not.toHaveBeenCalled();

    const readyState = {
      ...readiness,
      sessionStatus: "ready",
      sessionEstablished: true,
    } as const;
    await expect(
      harness.coordinator.ready(environmentId, generation, () =>
        isHostedEnvironmentQueryRefreshReady(readyState, environmentId, generation),
      ),
    ).resolves.toBe(true);
    expect(harness.refresh).toHaveBeenCalledTimes(1);
  });

  it("requires the current hosted generation, directory, relay, session, and browser snapshot", () => {
    const ready: HostedEnvironmentQueryRefreshState = {
      generation: 4,
      selectedNode: { environmentId },
      directoryStatus: "ready",
      selectionStatus: "online",
      transportStatus: "online",
      sessionStatus: "ready",
      sessionEstablished: true,
      browserStatus: "current",
    };

    expect(isHostedEnvironmentQueryRefreshReady(ready, environmentId, 4)).toBe(true);
    expect(
      isHostedEnvironmentQueryRefreshReady({ ...ready, generation: 5 }, environmentId, 4),
    ).toBe(false);
    expect(
      isHostedEnvironmentQueryRefreshReady(
        { ...ready, directoryStatus: "stale" },
        environmentId,
        4,
      ),
    ).toBe(false);
    expect(
      isHostedEnvironmentQueryRefreshReady(
        { ...ready, transportStatus: "reconnecting" },
        environmentId,
        4,
      ),
    ).toBe(false);
    expect(
      isHostedEnvironmentQueryRefreshReady(
        { ...ready, sessionEstablished: false },
        environmentId,
        4,
      ),
    ).toBe(false);
    expect(
      isHostedEnvironmentQueryRefreshReady({ ...ready, browserStatus: "stale" }, environmentId, 4),
    ).toBe(false);
  });

  it("fences stale generations and deduplicates repeated readiness", async () => {
    let resolveRefresh: (() => void) | undefined;
    const fence = vi.fn();
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const coordinator = createEnvironmentQueryRefreshCoordinator({ fence, refresh });
    const staleGeneration = coordinator.begin(environmentId);
    const currentGeneration = coordinator.begin(environmentId);

    await expect(coordinator.ready(environmentId, staleGeneration)).resolves.toBe(false);
    const first = coordinator.ready(environmentId, currentGeneration);
    const duplicate = coordinator.ready(environmentId, currentGeneration);
    expect(refresh).toHaveBeenCalledTimes(1);

    resolveRefresh?.();
    await expect(first).resolves.toBe(true);
    await expect(duplicate).resolves.toBe(true);
    await expect(coordinator.ready(environmentId, currentGeneration)).resolves.toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

function hostedNode(id: string): HostedHubNode {
  return {
    id: `node_${id.padEnd(22, "a")}`,
    environmentId: EnvironmentId.make(`env_${id.padEnd(22, "a")}`),
    label: `Node ${id}`,
    platformOs: "linux",
    platformArch: "x64",
    clientVersion: "1",
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    revokedAt: null,
    revocationReasonCode: null,
    grant: { id: `grant_${id.padEnd(22, "a")}`, role: "operator" },
    effectiveRole: "operator",
    presence: { online: true, lastHeartbeatAt: 1 },
  };
}

describe("retained environment session query refresh", () => {
  const record = {
    environmentId,
    generation: 7,
    transportStatus: "online",
    sessionStatus: "ready",
    sessionEstablished: true,
  } as const;
  const shared = { directoryStatus: "ready", browserStatus: "current" } as const;

  it("requires the record's own generation, live relay, accepted snapshot and a revalidated browser", () => {
    const ready: HostedRecordQueryRefreshState = { record, shared };
    expect(isHostedRecordQueryRefreshReady(ready, environmentId, 7)).toBe(true);
    // The selection plays no part: a browser still synchronizing the selected
    // node has revalidated everything every other record needs.
    expect(
      isHostedRecordQueryRefreshReady(
        { record, shared: { ...shared, browserStatus: "synchronizing" } },
        environmentId,
        7,
      ),
    ).toBe(true);
    const refused: ReadonlyArray<HostedRecordQueryRefreshState> = [
      { record: undefined, shared },
      { record: null, shared },
      { record: { ...record, generation: 8 }, shared },
      { record: { ...record, environmentId: EnvironmentId.make("other-environment") }, shared },
      { record: { ...record, transportStatus: "reconnecting" }, shared },
      { record: { ...record, sessionStatus: "replaying" }, shared },
      { record: { ...record, sessionStatus: "delivery-unknown" }, shared },
      { record: { ...record, sessionEstablished: false }, shared },
      { record, shared: { ...shared, directoryStatus: "stale" } },
      { record, shared: { ...shared, browserStatus: "checking-access" } },
      { record, shared: { ...shared, browserStatus: "suspended" } },
    ];
    for (const state of refused) {
      expect(isHostedRecordQueryRefreshReady(state, environmentId, 7)).toBe(false);
    }
  });

  it("revalidates the browser by the same rule as the session registry", () => {
    const statuses = Object.keys({
      current: true,
      suspended: true,
      offline: true,
      "checking-access": true,
      synchronizing: true,
      stale: true,
    } satisfies Record<HostedBrowserStatus, true>) as ReadonlyArray<HostedBrowserStatus>;
    for (const browserStatus of statuses) {
      expect(
        isHostedRecordQueryRefreshReady(
          { record, shared: { ...shared, browserStatus } },
          environmentId,
          7,
        ),
        browserStatus,
      ).toBe(hostedBrowserRevalidated(browserStatus));
    }
  });

  it.each([
    ["a record that is not selected", "synchronizing"],
    ["the selected record", "current"],
  ] as const)(
    "refreshes the fenced queries of %s once its snapshot after a relay gap is accepted",
    async (_label, browserStatus) => {
      const sessions = createHostedEnvironmentSessions({
        now: () => 1,
        setTimeout: () => 0,
        clearTimeout: () => undefined,
      });
      const node = hostedNode("gap");
      const { generation } = sessions.ensureRecord(node);
      sessions.markConnectRequested(node.environmentId, generation);
      sessions.transportStatus(node.environmentId, generation, "online");
      sessions.markSessionReady(node.environmentId, generation);
      const harness = makeHarness();
      const readiness = () =>
        isHostedRecordQueryRefreshReady(
          {
            record: sessions.read(node.environmentId),
            shared: { directoryStatus: "ready", browserStatus },
          },
          node.environmentId,
          generation,
        );

      // The channel drops and its replacement resubscribes: queries are fenced.
      sessions.connectionClosed(node.environmentId, generation);
      const refresh = harness.coordinator.begin(node.environmentId);
      expect(harness.fence).toHaveBeenCalledWith(node.environmentId);
      // A snapshot that lands in the gap came from the lost channel.
      sessions.markSessionReady(node.environmentId, generation);
      await expect(harness.coordinator.ready(node.environmentId, refresh, readiness)).resolves.toBe(
        false,
      );

      sessions.connectionRecovered(node.environmentId, generation);
      sessions.transportStatus(node.environmentId, generation, "online");
      await expect(harness.coordinator.ready(node.environmentId, refresh, readiness)).resolves.toBe(
        false,
      );
      expect(harness.refresh).not.toHaveBeenCalled();

      sessions.markSessionReady(node.environmentId, generation);
      await expect(harness.coordinator.ready(node.environmentId, refresh, readiness)).resolves.toBe(
        true,
      );
      expect(harness.refresh).toHaveBeenCalledTimes(1);
    },
  );
});

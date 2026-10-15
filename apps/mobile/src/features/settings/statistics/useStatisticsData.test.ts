import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, USAGE_CONTRACT_VERSION } from "@ryco/contracts";
import { usageSummaryCache } from "@ryco/client-runtime/usage";
import {
  cachedNodeUsage,
  deriveStatisticsView,
  loadNodeStatistics,
  nodeAnswer,
  type NodeAnswer,
} from "./useStatisticsData";
const rpc = vi.hoisted(() => ({
  server: { getStatistics: vi.fn(), getUsageSummary: vi.fn(), refreshProviders: vi.fn() },
}));
vi.mock("../../../connection/environmentApi", () => ({ readRpcClient: () => rpc }));
const environment = {
  environmentId: EnvironmentId.make("device"),
  label: "Mac",
  connectionState: "connected" as const,
  role: "owner" as const,
};
beforeEach(() => {
  vi.resetAllMocks();
  usageSummaryCache.clear();
});
describe("mobile statistics loading", () => {
  it("does not query offline devices or nodes without owner access", async () => {
    const offline = await loadNodeStatistics(
      { ...environment, connectionState: "offline" },
      "usage",
      "7d",
    );
    const viewer = await loadNodeStatistics({ ...environment, role: "viewer" }, "limits", "7d");
    expect(offline.usage?.status).toBe("failed");
    expect(viewer.error).toContain("owner access");
    expect(rpc.server.getUsageSummary).not.toHaveBeenCalled();
    expect(rpc.server.refreshProviders).not.toHaveBeenCalled();
  });
  it("retains partial source coverage and sends the desktop date contract", async () => {
    rpc.server.getUsageSummary.mockResolvedValue({
      contractVersion: USAGE_CONTRACT_VERSION,
      sources: [{ status: "partial" }],
    });
    const result = await loadNodeStatistics(environment, "usage", "30d");
    expect(result.usage?.status).toBe("partial");
    expect(rpc.server.getUsageSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        contractVersion: USAGE_CONTRACT_VERSION,
        timeZone: expect.any(String),
        startDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      }),
      // The shared flight's signal: abandoned requests can be withdrawn.
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
  it("rejects incompatible summaries instead of showing zero totals", async () => {
    rpc.server.getUsageSummary.mockResolvedValue({ contractVersion: -1 });
    expect((await loadNodeStatistics(environment, "usage", "all")).error).toContain("Update Ryco");
  });
  it("joins an identical usage request already in flight", async () => {
    let answer!: (summary: unknown) => void;
    rpc.server.getUsageSummary.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const first = loadNodeStatistics(environment, "usage", "7d");
    const second = loadNodeStatistics(environment, "usage", "7d");
    answer({ contractVersion: USAGE_CONTRACT_VERSION, sources: [] });

    expect((await first).usage?.status).toBe("complete");
    expect((await second).usage?.status).toBe("complete");
    expect(rpc.server.getUsageSummary).toHaveBeenCalledTimes(1);
  });
  it("keeps the last usable summary per range to show while the next visit reloads", async () => {
    rpc.server.getUsageSummary.mockResolvedValue({
      contractVersion: USAGE_CONTRACT_VERSION,
      sources: [],
    });
    await loadNodeStatistics(environment, "usage", "30d");

    expect(cachedNodeUsage([{ ...environment, label: "Studio" }], "30d")).toEqual([
      expect.objectContaining({ environmentId: environment.environmentId, label: "Studio" }),
    ]);
    expect(cachedNodeUsage([environment], "7d")).toEqual([]);
    // A device that will not be asked shows its coming error, not the old summary.
    expect(
      cachedNodeUsage([{ ...environment, connectionState: "offline" as const }], "30d"),
    ).toEqual([]);
    expect(cachedNodeUsage([{ ...environment, role: "viewer" as const }], "30d")).toEqual([]);
    // A failed answer never replaces the last usable one.
    rpc.server.getUsageSummary.mockRejectedValue(new Error("Node restarted"));
    expect((await loadNodeStatistics(environment, "usage", "30d")).error).toBe("Node restarted");
    expect(cachedNodeUsage([environment], "30d")).toHaveLength(1);
  });
  it("loads the selected surface only and preserves absent provider limits", async () => {
    const providers = [{ instanceId: "custom", enabled: true }];
    rpc.server.refreshProviders.mockResolvedValue({ providers });
    expect((await loadNodeStatistics(environment, "limits", "30d")).providers).toEqual(providers);
    expect(rpc.server.getUsageSummary).not.toHaveBeenCalled();
    expect(rpc.server.getStatistics).not.toHaveBeenCalled();
  });
  it("surfaces server errors", async () => {
    rpc.server.getStatistics.mockRejectedValue(new Error("Owner access required"));
    expect((await loadNodeStatistics(environment, "activity", "7d")).error).toBe(
      "Owner access required",
    );
  });
});

it("shows stale-contract update instructions returned by the shared transport", async () => {
  const { UsageContractMismatchError } = await import("@ryco/client-runtime/usage");
  rpc.server.getUsageSummary.mockRejectedValue(new UsageContractMismatchError());
  const result = await loadNodeStatistics(environment, "usage", "30d");
  expect(result.usage?.status).toBe("stale-contract");
  expect(result.error).toContain("Update Ryco");
});

describe("progressive mobile statistics", () => {
  const slow = { ...environment, environmentId: EnvironmentId.make("slow-device"), label: "Mini" };

  it("forwards the caller's signal so a superseded range scan is withdrawn", async () => {
    rpc.server.getUsageSummary.mockImplementation(
      (_request: unknown, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) =>
          options?.signal?.addEventListener("abort", () => reject(new Error("withdrawn"))),
        ),
    );
    const view = new AbortController();
    const pending = loadNodeStatistics(environment, "usage", "7d", { signal: view.signal });
    const requestSignal = rpc.server.getUsageSummary.mock.calls[0]?.[1]?.signal as
      | AbortSignal
      | undefined;
    expect(requestSignal?.aborted).toBe(false);
    view.abort();
    expect(requestSignal?.aborted).toBe(true);
    expect((await pending).usage?.status).toBe("failed");
  });

  it("shows a fast device while a slow one is still loading", async () => {
    rpc.server.getUsageSummary.mockResolvedValue({
      contractVersion: USAGE_CONTRACT_VERSION,
      sources: [],
      buckets: [],
      imports: [],
    });
    const fast = await loadNodeStatistics(environment, "usage", "30d");
    const answers = new Map<EnvironmentId, NodeAnswer>([
      [environment.environmentId, nodeAnswer(environment, "usage", "30d", 0, fast)],
    ]);
    const view = deriveStatisticsView([environment, slow], answers, "usage", "30d", 0);
    expect(view.loading).toBe(true);
    expect(view.refreshing).toBe(false);
    expect(view.nodes).toEqual([fast]);
    expect(view.usage?.environments.map((result) => result.environmentId)).toEqual([
      environment.environmentId,
    ]);
  });

  it("keeps a device's earlier answer on screen while a refresh reloads it", () => {
    const node = { environment, activity: { generatedAt: "earlier" } as never };
    const answers = new Map<EnvironmentId, NodeAnswer>([
      [environment.environmentId, nodeAnswer(environment, "activity", "7d", 0, node)],
    ]);
    // Activity does not depend on the range: switching it keeps the answer current.
    expect(deriveStatisticsView([environment], answers, "activity", "90d", 0)).toMatchObject({
      nodes: [node],
      loading: false,
    });
    expect(deriveStatisticsView([environment], answers, "activity", "7d", 1)).toMatchObject({
      nodes: [node],
      loading: true,
      refreshing: true,
    });
    // Another device state is another request: its old answer is not shown.
    expect(
      deriveStatisticsView(
        [{ ...environment, connectionState: "offline" as const }],
        answers,
        "activity",
        "7d",
        0,
      ),
    ).toMatchObject({ nodes: [], loading: true, refreshing: false });
  });
});

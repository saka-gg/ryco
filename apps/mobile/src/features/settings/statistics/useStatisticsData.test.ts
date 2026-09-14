import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, USAGE_CONTRACT_VERSION } from "@ryco/contracts";
import { loadNodeStatistics } from "./useStatisticsData";
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
beforeEach(() => vi.resetAllMocks());
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
    );
  });
  it("rejects incompatible summaries instead of showing zero totals", async () => {
    rpc.server.getUsageSummary.mockResolvedValue({ contractVersion: -1 });
    expect((await loadNodeStatistics(environment, "usage", "all")).error).toContain("Update Ryco");
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

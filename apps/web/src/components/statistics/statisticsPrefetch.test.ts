import { WS_METHODS } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  allowed: new Set<string>(),
  readCapability: vi.fn(),
  prefetchUsageSummary: vi.fn(),
  prefetchStatistics: vi.fn(),
}));

vi.mock("~/hostedHub/capabilities", () => ({ readHostedRpcCapability: mocks.readCapability }));
vi.mock("./useUsageSummary", () => ({ prefetchUsageSummary: mocks.prefetchUsageSummary }));
vi.mock("../settings/statistics/useStatistics", () => ({
  prefetchStatistics: mocks.prefetchStatistics,
}));

import { prefetchStatisticsPage } from "./statisticsPrefetch";

beforeEach(() => {
  mocks.readCapability.mockImplementation((method: string) => ({
    allowed: mocks.allowed.has(method),
  }));
});

afterEach(() => {
  mocks.allowed.clear();
  vi.clearAllMocks();
});

describe("prefetchStatisticsPage", () => {
  it("starts the usage requests of the selected range and environments", () => {
    mocks.allowed.add(WS_METHODS.serverGetUsageSummary);
    prefetchStatisticsPage({ view: "usage", range: "7d", environmentIds: ["node-a"] });
    expect(mocks.prefetchUsageSummary).toHaveBeenCalledWith("7d", ["node-a"]);
    expect(mocks.prefetchStatistics).not.toHaveBeenCalled();
  });

  it("starts the activity snapshot for the activity view", () => {
    mocks.allowed.add(WS_METHODS.serverGetStatistics);
    prefetchStatisticsPage({ view: "activity", range: "30d", environmentIds: undefined });
    expect(mocks.prefetchStatistics).toHaveBeenCalledOnce();
    expect(mocks.prefetchUsageSummary).not.toHaveBeenCalled();
  });

  it("starts no activity snapshot for the limits view", () => {
    mocks.allowed.add(WS_METHODS.serverGetStatistics);
    mocks.allowed.add(WS_METHODS.serverGetUsageSummary);
    prefetchStatisticsPage({ view: "limits", range: "30d", environmentIds: undefined });
    expect(mocks.prefetchStatistics).not.toHaveBeenCalled();
    expect(mocks.prefetchUsageSummary).not.toHaveBeenCalled();
  });

  it("gates the requests on the routed node", () => {
    mocks.allowed.add(WS_METHODS.serverGetUsageSummary);
    mocks.allowed.add(WS_METHODS.serverGetStatistics);
    prefetchStatisticsPage({ view: "usage", range: "30d", environmentIds: undefined });
    prefetchStatisticsPage({ view: "activity", range: "30d", environmentIds: undefined });
    expect(mocks.readCapability).toHaveBeenCalledWith(WS_METHODS.serverGetUsageSummary, null);
    expect(mocks.readCapability).toHaveBeenCalledWith(WS_METHODS.serverGetStatistics, null);
  });

  it("asks nothing for a session the page would refuse", () => {
    prefetchStatisticsPage({ view: "usage", range: "30d", environmentIds: undefined });
    prefetchStatisticsPage({ view: "activity", range: "30d", environmentIds: undefined });
    expect(mocks.prefetchUsageSummary).not.toHaveBeenCalled();
    expect(mocks.prefetchStatistics).not.toHaveBeenCalled();
  });
});

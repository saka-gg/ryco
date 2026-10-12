import { describe, expect, it, vi } from "vite-plus/test";

const prefetch = vi.hoisted(() => ({ prefetchStatisticsPage: vi.fn() }));

vi.mock("./statisticsPrefetch", () => prefetch);
vi.mock("../routeViews/RoutePagePending", () => ({
  ROUTE_PAGE_PENDING_MS: 0,
  RoutePagePending: () => null,
}));

import { Route } from "../../routes/statistics";
import { parseStatisticsSearch } from "./statisticsSearch";

const loaderDeps = (raw: Record<string, unknown>) =>
  (Route.options.loaderDeps as (input: { search: unknown }) => unknown)({
    search: parseStatisticsSearch(raw),
  });
const loader = Route.options.loader as (input: {
  location: { search: Record<string, unknown> };
}) => void;

describe("statistics route loader", () => {
  it("reruns only for changes the mounted page does not request by itself", () => {
    expect(loaderDeps({ range: "7d" })).toEqual({ view: "usage", range: "7d" });
    expect(loaderDeps({ range: "90d" })).not.toEqual(loaderDeps({ range: "7d" }));
    // The usage view asks a newly selected environment itself; metrics ask nothing.
    expect(loaderDeps({ range: "7d", environmentIds: ["a"], usageMetric: "tokens" })).toEqual(
      loaderDeps({ range: "7d" }),
    );
    // The activity snapshot ignores the range.
    expect(loaderDeps({ view: "activity", range: "7d" })).toEqual(
      loaderDeps({ view: "activity", range: "90d" }),
    );
    expect(loaderDeps({ view: "activity" })).not.toEqual(loaderDeps({ view: "usage" }));
  });

  it("prefetches the requests of the location being entered, environment filter included", async () => {
    loader({ location: { search: { range: "7d", environmentIds: ["b", "a"] } } });
    await vi.waitFor(() => expect(prefetch.prefetchStatisticsPage).toHaveBeenCalledOnce());
    expect(prefetch.prefetchStatisticsPage).toHaveBeenCalledWith(
      expect.objectContaining({ view: "usage", range: "7d", environmentIds: ["a", "b"] }),
    );
  });
});

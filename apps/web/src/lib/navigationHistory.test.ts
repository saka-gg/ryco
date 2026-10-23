import { createMemoryHistory } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";

import { stepNavigationHistory } from "./navigationHistory";

function historyAt(...pathnames: string[]) {
  const history = createMemoryHistory({ initialEntries: [pathnames[0] ?? "/"] });
  for (const pathname of pathnames.slice(1)) history.push(pathname);
  return history;
}

describe("stepNavigationHistory", () => {
  it("stays on the first page instead of leaving the app", () => {
    const history = historyAt("/thread");
    const back = vi.spyOn(history, "back");

    stepNavigationHistory(history, "back");

    expect(back).not.toHaveBeenCalled();
    expect(history.location.pathname).toBe("/thread");
  });

  it("goes back and forward through visited pages", () => {
    const history = historyAt("/thread", "/pull-requests", "/settings");

    stepNavigationHistory(history, "back");
    expect(history.location.pathname).toBe("/pull-requests");
    stepNavigationHistory(history, "back");
    expect(history.location.pathname).toBe("/thread");
    stepNavigationHistory(history, "forward");
    expect(history.location.pathname).toBe("/pull-requests");
  });

  it("does nothing going forward from the newest page", () => {
    const history = historyAt("/thread", "/settings");

    stepNavigationHistory(history, "forward");

    expect(history.location.pathname).toBe("/settings");
  });

  it("drops the forward pages once a new page opens", () => {
    const history = historyAt("/thread", "/pull-requests");
    stepNavigationHistory(history, "back");
    history.push("/settings");

    stepNavigationHistory(history, "forward");

    expect(history.location.pathname).toBe("/settings");
    stepNavigationHistory(history, "back");
    expect(history.location.pathname).toBe("/thread");
  });

  it("flushes queued router writes before stepping", () => {
    const history = historyAt("/thread", "/settings");
    const flush = vi.spyOn(history, "flush");
    const back = vi.spyOn(history, "back");

    stepNavigationHistory(history, "back");

    expect(flush).toHaveBeenCalledOnce();
    expect(flush.mock.invocationCallOrder[0]).toBeLessThan(back.mock.invocationCallOrder[0]!);
  });
});

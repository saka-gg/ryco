import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { renderHook } from "vitest-browser-react";

import type { CrownSnapshot } from "./crownAlerts.logic";
import {
  CROWN_ALERT_DWELL_MS,
  CROWN_ALERT_DWELL_QUEUED_MS,
  CROWN_GIT_ACTION_SUPPRESS_MS,
} from "./crownLayout";
import { makeSnapshot } from "./crownTestFixtures";
import { useCrownAlerts } from "./useCrownAlerts";

interface Props {
  snapshot: CrownSnapshot;
  cardOpen: boolean;
  userGitActionActive: boolean;
  paused: boolean;
}

const failing = (names: string[], headSha = "sha-1"): CrownSnapshot["checks"] => ({
  headSha,
  kind: "failed",
  failed: names,
  passed: 0,
  total: 3,
  refName: "feature/crown",
});
const RUNNING: CrownSnapshot["checks"] = {
  headSha: "sha-1",
  kind: "running",
  failed: [],
  passed: 0,
  total: 3,
  refName: "feature/crown",
};

async function setup(initial: Partial<Props> = {}) {
  const props: Props = {
    snapshot: makeSnapshot({ checks: RUNNING }),
    cardOpen: false,
    userGitActionActive: false,
    paused: false,
    ...initial,
  };
  const hook = await renderHook((p?: Props) => useCrownAlerts(p ?? props), {
    initialProps: props,
  });
  return {
    hook,
    update: (next: Partial<Props>) => {
      Object.assign(props, next);
      return hook.rerender({ ...props });
    },
  };
}

describe("useCrownAlerts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("treats the first snapshot as a silent baseline", async () => {
    const { hook } = await setup({ snapshot: makeSnapshot({ checks: failing(["lint"]) }) });
    expect(hook.result.current.current).toBeNull();
    expect(hook.result.current.pings.checks.n).toBe(0);
  });

  it("alerts, pings and dwells before folding back", async () => {
    const { hook, update } = await setup();
    await update({ snapshot: makeSnapshot({ checks: failing(["lint"]) }) });
    expect(hook.result.current.current?.title).toBe("1 check failing");
    expect(hook.result.current.pings.checks).toEqual({ n: 1, tone: "danger" });

    await hook.act(() => vi.advanceTimersByTime(CROWN_ALERT_DWELL_MS - 1));
    expect(hook.result.current.current).not.toBeNull();
    await hook.act(() => vi.advanceTimersByTime(1));
    expect(hook.result.current.current).toBeNull();
  });

  it("does not re-diff a snapshot with the same value", async () => {
    const { hook, update } = await setup();
    const next = makeSnapshot({ checks: failing(["lint"]) });
    await update({ snapshot: next });
    await update({ snapshot: structuredClone(next) });
    expect(hook.result.current.pings.checks.n).toBe(1);
  });

  it("queues alerts and keeps the dwell fixed when the alert appeared", async () => {
    const { hook, update } = await setup({
      snapshot: makeSnapshot({ checks: RUNNING, subagents: {} }),
    });
    await update({
      snapshot: makeSnapshot({
        checks: failing(["lint"]),
        subagents: { a: { status: "running", name: "Scout" } },
      }),
    });
    expect(hook.result.current.current?.title).toBe("1 check failing");
    expect(hook.result.current.queuedCount).toBe(1);

    // The first alert had one waiting behind it, so it uses the shorter dwell.
    await hook.act(() => vi.advanceTimersByTime(CROWN_ALERT_DWELL_QUEUED_MS));
    expect(hook.result.current.current?.title).toBe("Scout started");
    expect(hook.result.current.queuedCount).toBe(0);

    await hook.act(() => vi.advanceTimersByTime(CROWN_ALERT_DWELL_MS));
    expect(hook.result.current.current).toBeNull();
  });

  it("clears on demand", async () => {
    const { hook, update } = await setup();
    await update({
      snapshot: makeSnapshot({
        checks: failing(["lint"]),
        subagents: { a: { status: "running", name: "Scout" } },
      }),
    });
    await hook.act(() => hook.result.current.clear());
    expect(hook.result.current.current).toBeNull();
    expect(hook.result.current.queuedCount).toBe(0);
  });

  it("clears alerts when the card opens and drops new ones while it is open", async () => {
    const { hook, update } = await setup();
    await update({ snapshot: makeSnapshot({ checks: failing(["lint"]) }) });
    await update({ cardOpen: true });
    expect(hook.result.current.current).toBeNull();
    await update({ snapshot: makeSnapshot({ checks: failing(["lint", "test"]) }) });
    expect(hook.result.current.current).toBeNull();
    // Pings still mark the icon.
    expect(hook.result.current.pings.checks.n).toBe(2);
  });

  it("pings branch and ship for branch events", async () => {
    const { hook, update } = await setup();
    await update({
      snapshot: makeSnapshot({
        checks: RUNNING,
        branch: { refName: "feature/crown", ahead: 2, behind: 0 },
      }),
    });
    expect(hook.result.current.pings.branch.n).toBe(1);
    expect(hook.result.current.pings.ship.n).toBe(1);
    expect(hook.result.current.current?.title).toBe("2 new commits");
  });

  it("suppresses branch alerts during and shortly after a user git action", async () => {
    const ahead = (n: number) =>
      makeSnapshot({ checks: RUNNING, branch: { refName: "feature/crown", ahead: n, behind: 0 } });
    const { hook, update } = await setup({ snapshot: ahead(2) });
    await update({ userGitActionActive: true });
    await update({ userGitActionActive: false, snapshot: ahead(0) });
    expect(hook.result.current.current).toBeNull();
    expect(hook.result.current.pings.ship.n).toBe(0);

    await hook.act(() => vi.advanceTimersByTime(CROWN_GIT_ACTION_SUPPRESS_MS));
    await update({ snapshot: ahead(1) });
    expect(hook.result.current.current?.title).toBe("1 new commit");
  });

  it("holds the alert while paused and restarts its dwell afterwards", async () => {
    const { hook, update } = await setup();
    await update({ snapshot: makeSnapshot({ checks: failing(["lint"]) }) });
    await update({ paused: true });
    await hook.act(() => vi.advanceTimersByTime(CROWN_ALERT_DWELL_MS * 2));
    expect(hook.result.current.current?.title).toBe("1 check failing");

    await update({ paused: false });
    await hook.act(() => vi.advanceTimersByTime(CROWN_ALERT_DWELL_MS - 1));
    expect(hook.result.current.current).not.toBeNull();
    await hook.act(() => vi.advanceTimersByTime(1));
    expect(hook.result.current.current).toBeNull();
  });

  it("announces a watched turn once it settles, through the turn-completion tracker", async () => {
    const turn = (running: boolean, settled: boolean): CrownSnapshot["turn"] => ({
      turnId: "turn-1",
      state: running ? "running" : "completed",
      startedAt: "2026-10-07T10:00:00.000Z",
      completedAt: running ? null : "2026-10-07T10:02:00.000Z",
      settled,
      running,
    });
    const { hook, update } = await setup({ snapshot: makeSnapshot({ turn: turn(true, false) }) });
    // Completed but the session still runs: not settled yet.
    await update({ snapshot: makeSnapshot({ turn: turn(false, false) }) });
    expect(hook.result.current.current).toBeNull();
    await update({ snapshot: makeSnapshot({ turn: turn(false, true) }) });
    expect(hook.result.current.current?.title).toBe("Turn finished");
    expect(hook.result.current.current?.sub).toBe("Took 2m");
  });

  it("stays quiet for a turn that had already ended when it was first seen", async () => {
    const settledTurn: CrownSnapshot["turn"] = {
      turnId: "turn-1",
      state: "completed",
      startedAt: "2026-10-07T10:00:00.000Z",
      completedAt: "2026-10-07T10:02:00.000Z",
      settled: true,
      running: false,
    };
    const { hook, update } = await setup({ snapshot: makeSnapshot({ turn: settledTurn }) });
    await update({ snapshot: makeSnapshot({ turn: settledTurn, fileCount: 1 }) });
    expect(hook.result.current.current).toBeNull();
  });

  it("re-baselines silently on a thread switch", async () => {
    const { hook, update } = await setup();
    await update({
      snapshot: makeSnapshot({ scopeKey: "thread-2|/repo", checks: failing(["lint"]) }),
    });
    expect(hook.result.current.current).toBeNull();
  });

  it("pauses the dwell while the document is hidden", async () => {
    const { hook, update } = await setup();
    await update({ snapshot: makeSnapshot({ checks: failing(["lint"]) }) });
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    await hook.act(() => vi.advanceTimersByTime(CROWN_ALERT_DWELL_MS * 2));
    expect(hook.result.current.current).not.toBeNull();

    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    await hook.act(() => vi.advanceTimersByTime(CROWN_ALERT_DWELL_MS));
    expect(hook.result.current.current).toBeNull();
    hidden.mockRestore();
  });
});

import { ThreadId, type WorktreeSetupSnapshot } from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  isWorktreeSetupFeedSettled,
  resolveWorktreeLaunchWorkStartedAt,
  resolveWorktreeSetupScriptChip,
  resolveWorktreeSetupStages,
} from "./logic.ts";
import { startWorktreeLaunchFeed, stopWorktreeLaunchFeed } from "./runtime.ts";
import { readWorktreeLaunch, useWorktreeLaunchStore } from "./store.ts";

const threadId = ThreadId.make("thread-launch");
const key = "env-1:thread-launch";

const snapshot = (overrides: Partial<WorktreeSetupSnapshot> = {}): WorktreeSetupSnapshot => ({
  threadId,
  sequence: 1,
  status: "running",
  baseRef: "origin/main",
  stages: [
    { id: "fetch", status: "done", detail: "prefetched" },
    { id: "checkout", status: "running", percent: 40 },
    { id: "setup-script", status: "pending" },
    { id: "agent", status: "pending" },
  ],
  outputTail: [],
  startedAt: "2026-10-14T10:00:00.000Z",
  updatedAt: "2026-10-14T10:00:01.000Z",
  ...overrides,
});

const begin = () =>
  useWorktreeLaunchStore.getState().begin({
    key,
    environmentId: "env-1",
    threadId,
    messageId: "message-1",
    baseRef: "origin/main",
    fetchOrigin: true,
    startedAtMs: Date.parse("2026-10-14T10:00:00.000Z"),
  });

afterEach(() => {
  stopWorktreeLaunchFeed(key);
  useWorktreeLaunchStore.getState().remove(key);
});

describe("worktree launch store", () => {
  it("lays out every stage before the node reports any", () => {
    begin();
    const launch = readWorktreeLaunch(key)!;
    expect(resolveWorktreeSetupStages(launch).map((stage) => [stage.label, stage.status])).toEqual([
      ["Fetch origin/main", "pending"],
      ["Check out files", "pending"],
      ["Run setup script", "pending"],
      ["Start agent", "pending"],
    ]);
    expect(resolveWorktreeSetupStages({ ...launch, fetchOrigin: false })[0]?.status).toBe(
      "skipped",
    );
  });

  it("applies snapshots in sequence and ignores a stale one", () => {
    begin();
    const store = useWorktreeLaunchStore.getState();
    store.applySnapshot(key, snapshot({ sequence: 5 }));
    store.applySnapshot(key, snapshot({ sequence: 3, status: "failed" }));
    expect(readWorktreeLaunch(key)?.snapshot?.sequence).toBe(5);
    const stages = resolveWorktreeSetupStages(readWorktreeLaunch(key)!);
    expect(stages[0]).toMatchObject({ status: "done", detail: "prefetched" });
    expect(stages[1]).toMatchObject({ status: "running", percent: 40 });
  });

  it("names the setup script in its stage and hands it to a chip after the hand-off", () => {
    begin();
    const store = useWorktreeLaunchStore.getState();
    store.applySnapshot(
      key,
      snapshot({
        sequence: 2,
        status: "done",
        setupTerminalId: "setup-install",
        stages: [
          { id: "fetch", status: "done" },
          { id: "checkout", status: "done" },
          { id: "setup-script", status: "running", detail: "bun install" },
          { id: "agent", status: "done" },
        ],
      }),
    );
    expect(resolveWorktreeSetupStages(readWorktreeLaunch(key)!)[2]?.label).toBe(
      "Run setup script · bun install",
    );
    // Before the hand-off the card shows the script, not a chip.
    expect(resolveWorktreeSetupScriptChip(readWorktreeLaunch(key))).toBeNull();
    store.handOff(key);
    expect(resolveWorktreeSetupScriptChip(readWorktreeLaunch(key))).toEqual({
      name: "bun install",
      status: "running",
      terminalId: "setup-install",
      finishedAt: null,
    });
  });

  it("counts the launched turn from the send and later turns as usual", () => {
    begin();
    const launch = readWorktreeLaunch(key)!;
    expect(resolveWorktreeLaunchWorkStartedAt(launch, [])).toBe(launch.startedAt);
    useWorktreeLaunchStore.getState().handOff(key);
    const handedOff = readWorktreeLaunch(key)!;
    expect(
      resolveWorktreeLaunchWorkStartedAt(handedOff, [{ role: "user" }, { role: "assistant" }]),
    ).toBe(launch.startedAt);
    expect(
      resolveWorktreeLaunchWorkStartedAt(handedOff, [{ role: "user" }, { role: "user" }]),
    ).toBeNull();
  });

  it("only cancels a launch that is still preparing", () => {
    begin();
    const store = useWorktreeLaunchStore.getState();
    store.requestCancel(key);
    expect(readWorktreeLaunch(key)?.phase).toBe("cancelling");
    store.handOff(key);
    store.requestCancel(key);
    expect(readWorktreeLaunch(key)?.phase).toBe("handed-off");
  });
});

describe("worktree launch feed", () => {
  it("follows the node's feed until the setup and its script settled", () => {
    begin();
    let listener: ((snapshot: WorktreeSetupSnapshot) => void) | null = null;
    const unsubscribe = vi.fn();
    const onWorktreeSetup = vi.fn((_input, callback) => {
      listener = callback;
      return unsubscribe;
    });
    startWorktreeLaunchFeed({ api: { vcs: { onWorktreeSetup } }, key, threadId });
    expect(onWorktreeSetup).toHaveBeenCalledWith({ threadId }, expect.any(Function), {
      onError: expect.any(Function),
    });

    const scriptRunning = snapshot({
      sequence: 2,
      status: "done",
      stages: [
        { id: "fetch", status: "done" },
        { id: "checkout", status: "done" },
        { id: "setup-script", status: "running", detail: "bun install" },
        { id: "agent", status: "done" },
      ],
    });
    expect(isWorktreeSetupFeedSettled(scriptRunning)).toBe(false);
    listener!(scriptRunning);
    expect(unsubscribe).not.toHaveBeenCalled();

    const settled = snapshot({
      sequence: 3,
      status: "done",
      stages: [
        { id: "fetch", status: "done" },
        { id: "checkout", status: "done" },
        { id: "setup-script", status: "done", detail: "bun install" },
        { id: "agent", status: "done" },
      ],
    });
    listener!(settled);
    expect(readWorktreeLaunch(key)?.snapshot?.sequence).toBe(3);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("marks the feed unavailable on a node without it", () => {
    begin();
    startWorktreeLaunchFeed({ api: { vcs: {} }, key, threadId });
    expect(readWorktreeLaunch(key)?.feedUnavailable).toBe(true);

    begin();
    startWorktreeLaunchFeed({
      api: {
        vcs: {
          onWorktreeSetup: (_input, _callback, options) => {
            options?.onError?.();
            return () => undefined;
          },
        },
      },
      key,
      threadId,
    });
    expect(readWorktreeLaunch(key)?.feedUnavailable).toBe(true);
  });
});

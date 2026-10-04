import { EnvironmentId, MessageId, ProjectId, ThreadId, ProviderInstanceId } from "@ryco/contracts";
import type {
  ThreadReadCacheShellResponse,
  ThreadReadCacheThreadResponse,
} from "@ryco/contracts/thread-read-cache";
import type { HostedHubNode } from "@ryco/client-runtime/authorization";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { selectThreadByRef, useStore } from "../store";
import { hostedHubStore } from "./state";
import { startHostedThreadReadCache } from "./threadReadCache";
import type { RoutedHostedNode } from "./nodeRoutes";

const environmentId = EnvironmentId.make("env_aaaaaaaaaaaaaaaaaaaaaa");
const threadId = ThreadId.make("thread-a");
const node: HostedHubNode = {
  id: "node_aaaaaaaaaaaaaaaaaaaaaa",
  environmentId,
  label: "Mac",
  platformOs: "darwin",
  platformArch: "arm64",
  clientVersion: "1",
  createdAt: 1,
  updatedAt: 1,
  lastAuthenticatedAt: 1,
  revokedAt: null,
  revocationReasonCode: null,
  grant: { id: "grant-a", role: "owner" },
  effectiveRole: "owner",
  presence: { online: false, lastHeartbeatAt: 1 },
};
const date = "2026-10-04T12:00:00.000Z";
const shell: ThreadReadCacheShellResponse = {
  protocolVersion: 1,
  generation: 1,
  revision: 2,
  storedAt: 100,
  snapshot: {
    snapshotSequence: 1,
    updatedAt: date,
    projects: [
      {
        id: ProjectId.make("project-a"),
        title: "Project",
        workspaceRoot: "/repo",
        defaultModelSelection: null,
        scripts: [],
        createdAt: date,
        updatedAt: date,
      },
    ],
    worktrees: [],
    threads: [
      {
        id: threadId,
        projectId: ProjectId.make("project-a"),
        title: "A cloud thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        goal: null,
        createdAt: date,
        updatedAt: date,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        session: null,
        latestUserMessageAt: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
      },
    ],
  },
};
const detail: ThreadReadCacheThreadResponse = {
  protocolVersion: 1,
  generation: 1,
  revision: 1,
  storedAt: 90,
  threadId,
  snapshot: {
    messages: [
      {
        id: MessageId.make("message-a"),
        role: "assistant",
        text: "Ready before the Mac connects",
        createdAt: date,
      },
    ],
  },
};
const settle = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};
const stops: Array<() => void> = [];
afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  useStore.setState({ activeEnvironmentId: null, environmentStateById: {} });
});

function harness() {
  let state = {
    ...hostedHubStore.getInitialState(),
    accountStatus: "authenticated" as const,
    account: {
      id: "account-a",
      displayName: "A",
      role: "owner" as const,
      createdAt: 1,
      disabledAt: null,
    },
    directoryStatus: "ready" as const,
    browserStatus: "current" as const,
    nodes: [node],
  } as ReturnType<typeof hostedHubStore.getState>;
  let route: RoutedHostedNode = {
    nodeId: node.id,
    malformed: false,
    logicalPathname: `/${environmentId}/${threadId}`,
  };
  let visible = true;
  let now = 1;
  let tick = () => {};
  const stateListeners = new Set<() => void>();
  const routeListeners = new Set<() => void>();
  const readShell = vi.fn(async (_nodeId: string, _signal: AbortSignal) => shell);
  const readThread = vi.fn(
    async (_nodeId: string, _threadId: string, _signal: AbortSignal) => detail,
  );
  const onSnapshot = vi.fn();
  return {
    readShell,
    readThread,
    onSnapshot,
    start() {
      const stop = startHostedThreadReadCache({
        readState: () => state,
        subscribeState: (listener) => {
          stateListeners.add(listener);
          return () => stateListeners.delete(listener);
        },
        readRoute: () => route,
        subscribeRoute: (listener) => {
          routeListeners.add(listener);
          return () => routeListeners.delete(listener);
        },
        readShell,
        readThread,
        onSnapshot,
        now: () => now,
        isVisible: () => visible,
        setInterval: (callback) => {
          tick = callback;
          return 1;
        },
        clearInterval: () => {},
      });
      stops.push(stop);
      return stop;
    },
    patch(patch: Partial<typeof state>) {
      state = { ...state, ...patch };
      stateListeners.forEach((listener) => listener());
    },
    route(value: RoutedHostedNode) {
      route = value;
      routeListeners.forEach((listener) => listener());
    },
    tick(elapsed = 15_000) {
      now += elapsed;
      tick();
    },
    visible(value: boolean) {
      visible = value;
    },
  };
}

describe("hosted cloud thread read cache", () => {
  it("opens thread text in a fresh browser with an offline node and no remembered browser cache", async () => {
    const test = harness();
    test.start();
    await settle();
    const thread = selectThreadByRef(useStore.getState(), { environmentId, threadId });
    expect(thread?.messages[0]?.text).toBe("Ready before the Mac connects");
    expect(thread?.session).toBeNull();
    expect(useStore.getState().environmentStateById[environmentId]).toMatchObject({
      bootstrapComplete: false,
      hydratedFromCacheAt: 100,
    });
    expect(test.onSnapshot.mock.calls.at(-1)?.[0].threads).toHaveLength(1);
  });

  it("rejects a late response after account change or directory revocation", async () => {
    const test = harness();
    let complete!: (value: ThreadReadCacheShellResponse) => void;
    test.readShell.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    test.start();
    test.patch({ nodes: [] });
    complete(shell);
    await settle();
    expect(useStore.getState().environmentStateById[environmentId]).toBeUndefined();
    expect(test.onSnapshot).not.toHaveBeenCalled();

    test.readShell.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    test.patch({ nodes: [node] });
    test.patch({ accountStatus: "signed-out", account: null });
    complete(shell);
    await settle();
    expect(useStore.getState().environmentStateById[environmentId]).toBeUndefined();
  });

  it("falls back quietly for missing caches and never polls hidden browsers", async () => {
    const test = harness();
    test.readShell.mockRejectedValue(new Error("404"));
    test.readThread.mockRejectedValue(new Error("404"));
    test.start();
    await settle();
    expect(test.onSnapshot).not.toHaveBeenCalled();
    test.visible(false);
    test.tick(60_000);
    await settle();
    expect(test.readShell).toHaveBeenCalledTimes(1);
    expect(test.readThread).toHaveBeenCalledTimes(1);
    test.visible(true);
    test.tick();
    await settle();
    expect(test.readShell).toHaveBeenCalledTimes(2);
    expect(test.readThread).toHaveBeenCalledTimes(2);
  });

  it("does not replace a live snapshot that arrived while cloud history was loading", async () => {
    const test = harness();
    let complete!: (value: ThreadReadCacheShellResponse) => void;
    test.readShell.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    test.start();
    useStore.getState().syncServerShellSnapshot({ ...shell.snapshot, threads: [] }, environmentId);
    complete({ ...shell, storedAt: Date.now() + 60_000 });
    await settle();
    expect(useStore.getState().environmentStateById[environmentId]).toMatchObject({
      bootstrapComplete: true,
      threadIds: [],
    });
    expect(test.onSnapshot).not.toHaveBeenCalled();
  });
});

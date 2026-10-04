import type { ScopedThreadRef } from "@ryco/contracts";
import { EnvironmentId, ThreadId } from "@ryco/contracts";
import { beforeEach, afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { useLayoutEffect } from "react";

const fixture = vi.hoisted(() => ({
  hostedMode: false,
  hosted: {
    generation: 1,
    effectiveRole: "owner",
    directoryStatus: "ready",
    transportStatus: "online",
    browserStatus: "current",
    sessionStatus: "ready",
  },
  lease: null as {
    environmentId: string;
    selectionGeneration: number;
    snapshotGeneration: number;
  } | null,
  state: {} as unknown,
  connections: new Map<string, unknown>(),
}));
vi.mock("../env", () => ({ isHostedHubMode: () => fixture.hostedMode }));
vi.mock("../lib/utils", () => ({ randomUUID: () => crypto.randomUUID() }));
vi.mock("../environments/runtime", () => ({
  readEnvironmentConnection: (environmentId: string) => fixture.connections.get(environmentId),
}));
vi.mock("../store", () => ({ useStore: { getState: () => fixture.state } }));
vi.mock("../hostedHub/state", () => ({
  useHostedHubStore: Object.assign(
    (selector: (state: typeof fixture.hosted) => unknown) => selector(fixture.hosted),
    { getState: () => fixture.hosted },
  ),
  hostedHubController: {
    acknowledgeDeliveryUnknown: vi.fn(),
    markEnvironmentDeliveryUnknown: vi.fn(),
  },
}));
vi.mock("../hostedHub/hostedConnectionCoordinator", () => ({
  readHostedNodeMutationLease: (environmentId: string) =>
    fixture.lease?.environmentId === environmentId ? fixture.lease : null,
}));

import { TerminalSnippetActions } from "./chat/TerminalSnippetActions";
import { useTerminalSnippetAction } from "./chat/CodeBlockActions";
import { PaneFocusContext } from "./chat/PaneFocus";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { terminalSnippetBroker } from "../terminalSnippetInsertion";
import { useTierOverrideStore } from "../tierOverrideStore";
import { syncDocumentPresentationTier } from "../lib/presentationTier";

const threadRef: ScopedThreadRef = {
  environmentId: EnvironmentId.make("synthetic-node-a"),
  threadId: ThreadId.make("synthetic-thread"),
};
const otherRef = { ...threadRef, environmentId: EnvironmentId.make("synthetic-node-b") };
let action: ((source: string) => Promise<void>) | null;
function CaptureAction() {
  const current = useTerminalSnippetAction();
  useLayoutEffect(() => {
    action = current;
  }, [current]);
  return null;
}

function environment(worktreePath: string) {
  return {
    projectById: { project: { id: "project", cwd: "/synthetic/project" } },
    threadShellById: {
      [threadRef.threadId]: { id: threadRef.threadId, projectId: "project", worktreePath },
    },
    threadSessionById: {},
    threadTurnStateById: {},
    messageIdsByThreadId: {},
    messageByThreadId: {},
    activityIdsByThreadId: {},
    activityByThreadId: {},
    proposedPlanIdsByThreadId: {},
    proposedPlanByThreadId: {},
    turnDiffIdsByThreadId: {},
    turnDiffSummaryByThreadId: {},
  };
}

describe("conversation terminal action ownership", () => {
  let stopTier: () => void;
  let evidence: object | null;
  beforeEach(() => {
    useTierOverrideStore.setState({ override: "desktop" });
    stopTier = syncDocumentPresentationTier();
    action = null;
    fixture.hostedMode = false;
    fixture.hosted = {
      generation: 1,
      effectiveRole: "owner",
      directoryStatus: "ready",
      transportStatus: "online",
      browserStatus: "current",
      sessionStatus: "ready",
    };
    fixture.lease = null;
    fixture.state = {
      activeEnvironmentId: otherRef.environmentId,
      environmentStateById: {
        [threadRef.environmentId]: environment("/synthetic/worktree-a"),
        [otherRef.environmentId]: environment("/synthetic/worktree-b"),
      },
    };
    evidence = {};
    fixture.connections.set(threadRef.environmentId, {
      shellSnapshotReadiness: { read: () => evidence },
    });
    useTerminalStateStore.setState({
      terminalStateByThreadKey: {},
      terminalLaunchContextByThreadKey: {},
    });
  });
  afterEach(() => {
    fixture.connections.clear();
    useTierOverrideStore.setState({ override: null });
    stopTier();
  });
  const mount = () =>
    render(
      <TerminalSnippetActions threadRef={threadRef}>
        <CaptureAction />
      </TerminalSnippetActions>,
    );
  const readRequest = () => {
    const state = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadKey,
      threadRef,
    );
    return terminalSnippetBroker.read({ threadRef, terminalId: state.activeTerminalId })!;
  };

  it("targets the message owner rather than the globally focused node and preserves existing terminal state", async () => {
    const store = useTerminalStateStore.getState();
    store.newTerminal(threadRef, "existing-unfinished-pane");
    store.newTerminal(otherRef, "other-focused-pane");
    const screen = await mount();
    try {
      const result = action!("printf 'héllo 🌏'\n");
      const request = readRequest();
      expect(request.target).toEqual({
        threadRef,
        terminalId: expect.any(String),
        cwd: "/synthetic/worktree-a",
        worktreePath: "/synthetic/worktree-a",
      });
      expect(
        selectThreadTerminalState(
          useTerminalStateStore.getState().terminalStateByThreadKey,
          threadRef,
        ).terminalIds,
      ).toContain("existing-unfinished-pane");
      expect(
        selectThreadTerminalState(
          useTerminalStateStore.getState().terminalStateByThreadKey,
          otherRef,
        ).activeTerminalId,
      ).toBe("other-focused-pane");
      expect(request.isCurrent()).toBe(true);
      request.complete();
      await result;
    } finally {
      await screen.unmount();
    }
  });

  it("rejects missing shell readiness before creating a terminal", async () => {
    evidence = null;
    const screen = await mount();
    try {
      await expect(action!("printf 'a'")).rejects.toThrow("must be ready");
      expect(useTerminalStateStore.getState().terminalStateByThreadKey).toEqual({});
    } finally {
      await screen.unmount();
    }
  });

  it("invalidates pending insertion on reconnect evidence, workspace changes, pane switches and drawer closure", async () => {
    for (const change of ["reconnect", "workspace", "terminal", "close"]) {
      const screen = await mount();
      const result = action!("printf 'a'").catch((error: Error) => error);
      const request = readRequest();
      if (change === "reconnect") evidence = {};
      if (change === "workspace")
        fixture.state = {
          environmentStateById: {
            [threadRef.environmentId]: environment("/synthetic/new-worktree"),
          },
        };
      if (change === "terminal")
        useTerminalStateStore.getState().newTerminal(threadRef, "other-pane");
      if (change === "close") useTerminalStateStore.getState().setTerminalOpen(threadRef, false);
      expect(request.isCurrent()).toBe(false);
      const send = vi.fn(async () => undefined);
      request.dispatch("synthetic-process", send);
      expect(await result).toBeInstanceOf(Error);
      expect(send).not.toHaveBeenCalled();
      await screen.unmount();
    }
  });

  it("requires the authoritative hosted node lease and fences its generations", async () => {
    fixture.hostedMode = true;
    fixture.lease = {
      environmentId: otherRef.environmentId,
      selectionGeneration: 1,
      snapshotGeneration: 1,
    };
    const screen = await mount();
    try {
      await expect(action!("printf 'a'")).rejects.toThrow("current and authorized");
      fixture.lease = {
        environmentId: threadRef.environmentId,
        selectionGeneration: 2,
        snapshotGeneration: 1,
      };
      const result = action!("printf 'a'").catch((error: Error) => error);
      const request = readRequest();
      fixture.lease = { ...fixture.lease, selectionGeneration: 3 };
      expect(request.isCurrent()).toBe(false);
      const send = vi.fn(async () => undefined);
      request.dispatch("synthetic-process", send);
      expect(await result).toBeInstanceOf(Error);
      expect(send).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("hides the action for hosted viewers and cancels on chat pane focus loss", async () => {
    fixture.hostedMode = true;
    fixture.hosted.effectiveRole = "viewer";
    const screen = await mount();
    expect(action).toBeNull();
    fixture.hostedMode = false;
    await screen.rerender(
      <TerminalSnippetActions key="standard" threadRef={threadRef}>
        <CaptureAction />
      </TerminalSnippetActions>,
    );
    const result = action!("printf 'a'").catch((error: Error) => error);
    const request = readRequest();
    await screen.rerender(
      <PaneFocusContext value={false}>
        <TerminalSnippetActions threadRef={threadRef}>
          <CaptureAction />
        </TerminalSnippetActions>
      </PaneFocusContext>,
    );
    expect(request.isCurrent()).toBe(false);
    expect(await result).toBeInstanceOf(Error);
    await screen.unmount();
  });
});

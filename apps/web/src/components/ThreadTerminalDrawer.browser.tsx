import "../index.css";

import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import { ThreadId } from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const {
  terminalConstructorSpy,
  terminalDisposeSpy,
  terminalWriteSpy,
  fitAddonFitSpy,
  fitAddonLoadSpy,
  environmentApiById,
  readEnvironmentApiMock,
  readLocalApiMock,
} = vi.hoisted(() => ({
  terminalConstructorSpy: vi.fn(),
  terminalDisposeSpy: vi.fn(),
  terminalWriteSpy: vi.fn(),
  fitAddonFitSpy: vi.fn(),
  fitAddonLoadSpy: vi.fn(),
  environmentApiById: new Map<
    string,
    { terminal: { open: ReturnType<typeof vi.fn>; resize?: ReturnType<typeof vi.fn> } }
  >(),
  readEnvironmentApiMock: vi.fn((environmentId: string) => environmentApiById.get(environmentId)),
  readLocalApiMock: vi.fn<
    () =>
      | {
          contextMenu: { show: ReturnType<typeof vi.fn> };
          shell: { openExternal: ReturnType<typeof vi.fn> };
        }
      | undefined
  >(() => ({
    contextMenu: { show: vi.fn(async () => null) },
    shell: { openExternal: vi.fn(async () => undefined) },
  })),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    fit = fitAddonFitSpy;
  },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class MockTerminal {
    cols = 80;
    rows = 24;
    options: { theme?: unknown } = {};
    buffer = {
      active: {
        viewportY: 0,
        baseY: 0,
        getLine: vi.fn(() => null),
      },
    };

    element: HTMLElement | undefined;

    constructor(options: unknown) {
      terminalConstructorSpy(options);
    }

    loadAddon(addon: unknown) {
      fitAddonLoadSpy(addon);
    }

    open(parent: HTMLElement) {
      this.element = document.createElement("div");
      this.element.className = "xterm";
      parent.append(this.element);
    }

    write(data: string) {
      terminalWriteSpy(data);
    }

    clear() {}

    clearSelection() {}

    focus() {}

    refresh() {}

    scrollToBottom() {}

    hasSelection() {
      return false;
    }

    getSelection() {
      return "";
    }

    getSelectionPosition() {
      return null;
    }

    attachCustomKeyEventHandler() {
      return true;
    }

    registerLinkProvider() {
      return { dispose: vi.fn() };
    }

    onData() {
      return { dispose: vi.fn() };
    }

    onSelectionChange() {
      return { dispose: vi.fn() };
    }

    dispose() {
      terminalDisposeSpy();
    }
  },
}));

vi.mock("~/environmentApi", () => ({
  ensureEnvironmentApi: (environmentId: string) => {
    const api = readEnvironmentApiMock(environmentId);
    if (!api) throw new Error(`Environment API not found for ${environmentId}`);
    return api;
  },
  readEnvironmentApi: readEnvironmentApiMock,
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: vi.fn(() => {
    throw new Error("ensureLocalApi not implemented in browser test");
  }),
  readLocalApi: readLocalApiMock,
}));

import { resetPreparedTerminalOpensForTests, prepareThreadTerminal } from "../terminalPrepare";
import { useTerminalStateStore } from "../terminalStateStore";
import ThreadTerminalDrawer, {
  disposeCachedTerminalViewsForTests,
  TerminalViewport,
} from "./ThreadTerminalDrawer";

const THREAD_ID = ThreadId.make("thread-terminal-browser");

function createEnvironmentApi(history = "") {
  return {
    terminal: {
      open: vi.fn(async () => ({
        threadId: THREAD_ID,
        terminalId: "default",
        cwd: "/repo/project",
        worktreePath: null,
        status: "running" as const,
        pid: 123,
        history,
        exitCode: null,
        exitSignal: null,
        updatedAt: "2026-04-07T00:00:00.000Z",
        cursor: { generation: "g1", sequence: 5 },
      })),
      write: vi.fn(async () => undefined),
      resize: vi.fn(async () => undefined),
    },
  };
}

async function mountTerminalViewport(props: {
  threadRef: ReturnType<typeof scopeThreadRef>;
  drawerBackgroundColor?: string;
  drawerTextColor?: string;
}) {
  const drawer = document.createElement("div");
  drawer.className = "thread-terminal-drawer";
  if (props.drawerBackgroundColor) {
    drawer.style.backgroundColor = props.drawerBackgroundColor;
  }
  if (props.drawerTextColor) {
    drawer.style.color = props.drawerTextColor;
  }

  const host = document.createElement("div");
  host.style.width = "800px";
  host.style.height = "400px";
  drawer.append(host);
  document.body.append(drawer);

  const screen = await render(
    <TerminalViewport
      threadRef={props.threadRef}
      threadId={THREAD_ID}
      terminalId="default"
      terminalLabel="Terminal"
      cwd="/repo/project"
      onSessionExited={() => undefined}
      onAddTerminalContext={() => undefined}
      focusRequestId={0}
      autoFocus={false}
      resizeEpoch={0}
      drawerHeight={320}
      keybindings={[]}
    />,
    { container: host },
  );

  return {
    host,
    rerender: async (nextProps: { threadRef: ReturnType<typeof scopeThreadRef> }) => {
      await screen.rerender(
        <TerminalViewport
          threadRef={nextProps.threadRef}
          threadId={THREAD_ID}
          terminalId="default"
          terminalLabel="Terminal"
          cwd="/repo/project"
          onSessionExited={() => undefined}
          onAddTerminalContext={() => undefined}
          focusRequestId={0}
          autoFocus={false}
          resizeEpoch={0}
          drawerHeight={320}
          keybindings={[]}
        />,
      );
    },
    cleanup: async () => {
      await screen.unmount();
      drawer.remove();
    },
  };
}

describe("TerminalViewport", () => {
  afterEach(() => {
    environmentApiById.clear();
    readEnvironmentApiMock.mockClear();
    readLocalApiMock.mockClear();
    terminalConstructorSpy.mockClear();
    terminalDisposeSpy.mockClear();
    terminalWriteSpy.mockClear();
    disposeCachedTerminalViewsForTests();
    resetPreparedTerminalOpensForTests();
    fitAddonFitSpy.mockClear();
    fitAddonLoadSpy.mockClear();
  });

  it("does not create a terminal when APIs are unavailable", async () => {
    readEnvironmentApiMock.mockReturnValueOnce(undefined);
    readLocalApiMock.mockReturnValueOnce(undefined);

    const mounted = await mountTerminalViewport({
      threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
    });

    try {
      await vi.waitFor(() => {
        expect(terminalConstructorSpy).not.toHaveBeenCalled();
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("reopens the terminal when the scoped thread reference changes", async () => {
    const environmentA = createEnvironmentApi();
    const environmentB = createEnvironmentApi();
    environmentApiById.set("environment-a", environmentA);
    environmentApiById.set("environment-b", environmentB);

    const mounted = await mountTerminalViewport({
      threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
    });

    try {
      await vi.waitFor(() => {
        expect(environmentA.terminal.open).toHaveBeenCalledTimes(1);
      });

      await mounted.rerender({
        threadRef: scopeThreadRef("environment-b" as never, THREAD_ID),
      });

      await vi.waitFor(() => {
        expect(environmentB.terminal.open).toHaveBeenCalledTimes(1);
      });
      // The environment A view is detached and kept for a quick return.
      expect(terminalConstructorSpy).toHaveBeenCalledTimes(2);
      expect(terminalDisposeSpy).not.toHaveBeenCalled();
      expect(mounted.host.querySelectorAll(".xterm")).toHaveLength(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not reopen the terminal when the scoped thread reference values stay the same", async () => {
    const environment = createEnvironmentApi();
    environmentApiById.set("environment-a", environment);

    const mounted = await mountTerminalViewport({
      threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
    });

    try {
      await vi.waitFor(() => {
        expect(environment.terminal.open).toHaveBeenCalledTimes(1);
      });

      await mounted.rerender({
        threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
      });

      await vi.waitFor(() => {
        expect(environment.terminal.open).toHaveBeenCalledTimes(1);
      });
      expect(terminalDisposeSpy).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("uses the drawer surface colors for the terminal theme", async () => {
    const environment = createEnvironmentApi();
    environmentApiById.set("environment-a", environment);

    const mounted = await mountTerminalViewport({
      threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
      drawerBackgroundColor: "rgb(24, 28, 36)",
      drawerTextColor: "rgb(228, 232, 240)",
    });

    try {
      await vi.waitFor(() => {
        expect(terminalConstructorSpy).toHaveBeenCalledTimes(1);
      });

      expect(terminalConstructorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          theme: expect.objectContaining({
            background: "rgb(24, 28, 36)",
            foreground: "rgb(228, 232, 240)",
          }),
        }),
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("reattaches a kept view on remount without rebuilding or re-parsing it", async () => {
    const environment = createEnvironmentApi("prompt$ ");
    environmentApiById.set("environment-a", environment);
    const threadRef = scopeThreadRef("environment-a" as never, THREAD_ID);

    const first = await mountTerminalViewport({ threadRef });
    await vi.waitFor(() => {
      expect(terminalWriteSpy).toHaveBeenCalledWith("prompt$ ");
    });
    const firstElement = first.host.querySelector(".xterm");
    await first.cleanup();
    expect(terminalDisposeSpy).not.toHaveBeenCalled();
    terminalWriteSpy.mockClear();

    const second = await mountTerminalViewport({ threadRef });
    try {
      await vi.waitFor(() => {
        expect(environment.terminal.open).toHaveBeenCalledTimes(2);
      });
      // Same xterm instance and element; the open confirmed the view is
      // current, so the history was not written again.
      expect(terminalConstructorSpy).toHaveBeenCalledTimes(1);
      expect(second.host.querySelector(".xterm")).toBe(firstElement);
      // It asked only for the output after what it shows; this server answered in full.
      expect(environment.terminal.open).toHaveBeenLastCalledWith(
        expect.objectContaining({ sinceCursor: { generation: "g1", sequence: 5 } }),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(terminalWriteSpy).not.toHaveBeenCalledWith("prompt$ ");
    } finally {
      await second.cleanup();
    }
  });

  it("appends only the output a kept view missed while detached", async () => {
    const environment = createEnvironmentApi("prompt$ ");
    environmentApiById.set("environment-a", environment);
    const threadRef = scopeThreadRef("environment-a" as never, THREAD_ID);

    const first = await mountTerminalViewport({ threadRef });
    await vi.waitFor(() => {
      expect(terminalWriteSpy).toHaveBeenCalledWith("prompt$ ");
    });
    await first.cleanup();
    terminalWriteSpy.mockClear();
    environment.terminal.open.mockImplementation(async () => ({
      threadId: THREAD_ID,
      terminalId: "default",
      cwd: "/repo/project",
      worktreePath: null,
      status: "running" as const,
      pid: 123,
      history: "ls\r\nREADME.md\r\nprompt$ ",
      exitCode: null,
      exitSignal: null,
      updatedAt: "2026-04-07T00:01:00.000Z",
      cursor: { generation: "g1", sequence: 9 },
      historySince: { generation: "g1", sequence: 5 },
    }));

    const second = await mountTerminalViewport({ threadRef });
    try {
      await vi.waitFor(() => {
        expect(terminalWriteSpy).toHaveBeenCalledWith("ls\r\nREADME.md\r\nprompt$ ");
      });
      expect(environment.terminal.open).toHaveBeenLastCalledWith(
        expect.objectContaining({ sinceCursor: { generation: "g1", sequence: 5 } }),
      );
      expect(terminalConstructorSpy).toHaveBeenCalledTimes(1);
      expect(terminalWriteSpy).not.toHaveBeenCalledWith("\u001bc");
    } finally {
      await second.cleanup();
    }
  });

  it("applies the output a kept view held during a failed delta open", async () => {
    const environment = createEnvironmentApi("prompt$ ");
    environmentApiById.set("environment-a", environment);
    const threadRef = scopeThreadRef("environment-a" as never, THREAD_ID);

    const first = await mountTerminalViewport({ threadRef });
    await vi.waitFor(() => {
      expect(terminalWriteSpy).toHaveBeenCalledWith("prompt$ ");
    });
    await first.cleanup();
    terminalWriteSpy.mockClear();
    let fail!: (error: Error) => void;
    environment.terminal.open.mockImplementationOnce(
      () =>
        new Promise<never>((_resolve, reject) => {
          fail = reject;
        }),
    );

    const second = await mountTerminalViewport({ threadRef });
    try {
      await vi.waitFor(() => expect(fail).toBeDefined());
      // Arrives while the delta open is in flight: held, not applied yet.
      useTerminalStateStore.getState().applyTerminalEvent(threadRef, {
        type: "output",
        threadId: THREAD_ID,
        terminalId: "default",
        createdAt: "2026-04-07T00:01:00.000Z",
        cursor: { generation: "g1", sequence: 6 },
        data: " held",
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(terminalWriteSpy).not.toHaveBeenCalledWith(" held");

      // The shell then stays idle: nothing else would flush what the view held.
      fail(new Error("open failed"));
      await vi.waitFor(() => {
        expect(terminalWriteSpy).toHaveBeenCalledWith("\r\n[terminal] open failed\r\n");
      });
      const writes = terminalWriteSpy.mock.calls.map(([data]) => data);
      expect(writes).toContain(" held");
      expect(writes.indexOf(" held")).toBeLessThan(
        writes.indexOf("\r\n[terminal] open failed\r\n"),
      );
    } finally {
      await second.cleanup();
      useTerminalStateStore.getState().removeTerminalState(threadRef);
    }
  });

  it("re-hydrates a kept view from its own cursor when a reconnect replay arrived while detached", async () => {
    const environment = createEnvironmentApi("prompt$ ");
    environmentApiById.set("environment-a", environment);
    const threadRef = scopeThreadRef("environment-a" as never, THREAD_ID);

    const first = await mountTerminalViewport({ threadRef });
    await vi.waitFor(() => {
      expect(terminalWriteSpy).toHaveBeenCalledWith("prompt$ ");
    });
    await first.cleanup();
    terminalWriteSpy.mockClear();
    const caughtUp = {
      threadId: THREAD_ID,
      terminalId: "default",
      cwd: "/repo/project",
      worktreePath: null,
      status: "running" as const,
      pid: 123,
      history: "",
      exitCode: null,
      exitSignal: null,
      updatedAt: "2026-04-07T00:01:00.000Z",
      cursor: { generation: "g1", sequence: 8 },
    };
    // A reconnect while detached: its replay carries no history for the output it stands for.
    useTerminalStateStore.getState().applyTerminalEvent(threadRef, {
      type: "started",
      threadId: THREAD_ID,
      terminalId: "default",
      createdAt: caughtUp.updatedAt,
      cursor: caughtUp.cursor,
      snapshot: caughtUp,
      replay: true,
    });
    environment.terminal.open.mockImplementation(async () => ({
      ...caughtUp,
      history: "missed\r\n",
      historySince: { generation: "g1", sequence: 5 },
    }));

    const second = await mountTerminalViewport({ threadRef });
    try {
      await vi.waitFor(() => {
        expect(terminalWriteSpy).toHaveBeenCalledWith("missed\r\n");
      });
      expect(environment.terminal.open).toHaveBeenLastCalledWith(
        expect.objectContaining({ sinceCursor: { generation: "g1", sequence: 5 } }),
      );
      expect(terminalWriteSpy).not.toHaveBeenCalledWith("\u001bc");
    } finally {
      await second.cleanup();
      useTerminalStateStore.getState().removeTerminalState(threadRef);
    }
  });

  it("drops kept views when the terminal store is reset", async () => {
    const environment = createEnvironmentApi("prompt$ ");
    environmentApiById.set("environment-a", environment);
    const threadRef = scopeThreadRef("environment-a" as never, THREAD_ID);
    const initialNextEventId = useTerminalStateStore.getState().nextTerminalEventId;

    const first = await mountTerminalViewport({ threadRef });
    await vi.waitFor(() => {
      expect(terminalWriteSpy).toHaveBeenCalledWith("prompt$ ");
    });
    await first.cleanup();
    expect(terminalDisposeSpy).not.toHaveBeenCalled();

    // Hosted account teardown wipes the store and restarts its event ids.
    useTerminalStateStore.setState({ nextTerminalEventId: initialNextEventId + 10 });
    useTerminalStateStore.setState({ terminalEventEntriesByKey: {}, nextTerminalEventId: 1 });
    expect(terminalDisposeSpy).toHaveBeenCalledTimes(1);

    const second = await mountTerminalViewport({ threadRef });
    try {
      await vi.waitFor(() => {
        expect(environment.terminal.open).toHaveBeenCalledTimes(2);
      });
      expect(terminalConstructorSpy).toHaveBeenCalledTimes(2);
    } finally {
      await second.cleanup();
      useTerminalStateStore.setState({ nextTerminalEventId: initialNextEventId });
    }
  });

  it("rehydrates a kept view when the session moved on while detached", async () => {
    const environment = createEnvironmentApi("prompt$ ");
    environmentApiById.set("environment-a", environment);
    const threadRef = scopeThreadRef("environment-a" as never, THREAD_ID);

    const first = await mountTerminalViewport({ threadRef });
    await vi.waitFor(() => {
      expect(terminalWriteSpy).toHaveBeenCalledWith("prompt$ ");
    });
    await first.cleanup();
    terminalWriteSpy.mockClear();
    environment.terminal.open.mockImplementation(async () => ({
      threadId: THREAD_ID,
      terminalId: "default",
      cwd: "/repo/project",
      worktreePath: null,
      status: "running" as const,
      pid: 456,
      history: "restarted$ ",
      exitCode: null,
      exitSignal: null,
      updatedAt: "2026-04-07T00:01:00.000Z",
      cursor: { generation: "g2", sequence: 1 },
    }));

    const second = await mountTerminalViewport({ threadRef });
    try {
      await vi.waitFor(() => {
        expect(terminalWriteSpy).toHaveBeenCalledWith("restarted$ ");
      });
      expect(terminalConstructorSpy).toHaveBeenCalledTimes(1);
    } finally {
      await second.cleanup();
    }
  });

  it("takes a prepared open instead of opening again, and resizes once if the fit differs", async () => {
    const environment = createEnvironmentApi();
    environmentApiById.set("environment-a", environment);
    const threadRef = scopeThreadRef("environment-a" as never, THREAD_ID);
    prepareThreadTerminal({
      environmentId: threadRef.environmentId,
      threadId: THREAD_ID,
      terminalId: "default",
      launch: { cwd: "/repo/project", worktreePath: null, runtimeEnv: {} },
      layout: "drawer",
    });
    expect(environment.terminal.open).toHaveBeenCalledTimes(1);

    const mounted = await mountTerminalViewport({ threadRef });
    try {
      await vi.waitFor(() => {
        expect(terminalWriteSpy).toHaveBeenCalledWith("\u001bc");
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(environment.terminal.open).toHaveBeenCalledTimes(1);
      // The prepared open used the default 80x24, which the mock fit keeps.
      expect(environment.terminal.resize).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("hides the native xterm viewport scrollbar strip", () => {
    const drawer = document.createElement("div");
    drawer.className = "thread-terminal-drawer";

    const xterm = document.createElement("div");
    xterm.className = "xterm";

    const viewport = document.createElement("div");
    viewport.className = "xterm-viewport";

    xterm.append(viewport);
    drawer.append(xterm);
    document.body.append(drawer);

    try {
      expect(getComputedStyle(viewport).getPropertyValue("scrollbar-width")).toBe("none");
    } finally {
      drawer.remove();
    }
  });
});

describe("ThreadTerminalDrawer", () => {
  afterEach(() => {
    environmentApiById.clear();
    readEnvironmentApiMock.mockClear();
    readLocalApiMock.mockClear();
    terminalConstructorSpy.mockClear();
    terminalDisposeSpy.mockClear();
    terminalWriteSpy.mockClear();
    disposeCachedTerminalViewsForTests();
    resetPreparedTerminalOpensForTests();
    fitAddonFitSpy.mockClear();
    fitAddonLoadSpy.mockClear();
  });

  it("renders the new terminal button immediately after the last terminal tab", async () => {
    const environment = createEnvironmentApi();
    environmentApiById.set("environment-a", environment);

    const screen = await render(
      <ThreadTerminalDrawer
        threadRef={scopeThreadRef("environment-a" as never, THREAD_ID)}
        threadId={THREAD_ID}
        cwd="/repo/project"
        height={320}
        terminalIds={["one", "two"]}
        runningTerminalIds={[]}
        activeTerminalId="two"
        terminalGroups={[
          { id: "group-one", terminalIds: ["one"] },
          { id: "group-two", terminalIds: ["two"] },
        ]}
        activeTerminalGroupId="group-two"
        focusRequestId={0}
        onSplitTerminal={() => undefined}
        onNewTerminal={() => undefined}
        onActiveTerminalChange={() => undefined}
        onCloseTerminal={() => undefined}
        onHeightChange={() => undefined}
        onAddTerminalContext={() => undefined}
        keybindings={[]}
      />,
    );

    try {
      const tablist = document.querySelector<HTMLElement>(
        '[role="tablist"][aria-label="Terminals"]',
      );
      const newTerminalButton = document.querySelector<HTMLButtonElement>(
        'button[aria-label="New Terminal"]',
      );
      const terminalTabs = document.querySelectorAll<HTMLElement>('[role="tab"]');
      const lastTerminalTab = terminalTabs[terminalTabs.length - 1] ?? null;

      expect(tablist).not.toBeNull();
      expect(newTerminalButton).not.toBeNull();
      expect(lastTerminalTab).not.toBeNull();
      expect(tablist?.firstElementChild?.contains(newTerminalButton)).toBe(true);
      expect(lastTerminalTab?.nextElementSibling).toBe(newTerminalButton);
    } finally {
      await screen.unmount();
    }
  });
});

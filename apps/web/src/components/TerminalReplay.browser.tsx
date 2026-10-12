import "../index.css";
import { Terminal } from "@xterm/xterm";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { scopeThreadRef, scopedThreadKey } from "@ryco/client-runtime/scoped";
import { ThreadId } from "@ryco/contracts";
import type { TerminalSessionSnapshot } from "@ryco/contracts";
import { createTerminalEventReconciler } from "@ryco/client-runtime/state/terminal";
import {
  createTerminalOutputBatcher,
  writeTerminalSnapshot,
  TerminalViewport,
} from "./ThreadTerminalDrawer";
import { useTerminalStateStore } from "../terminalStateStore";

const { api } = vi.hoisted(() => ({
  api: {
    terminal: {
      open: vi.fn(),
      write: vi.fn(async () => undefined),
      resize: vi.fn(async () => undefined),
    },
  },
}));
vi.mock("~/environmentApi", () => ({
  readEnvironmentApi: () => api,
  ensureEnvironmentApi: () => api,
}));
vi.mock("~/localApi", () => ({
  ensureLocalApi: vi.fn(),
  readLocalApi: () => ({ contextMenu: { show: vi.fn() }, shell: { openExternal: vi.fn() } }),
}));

let terminal: Terminal | undefined;
let mount: HTMLDivElement | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  terminal?.dispose();
  mount?.remove();
});

it("reconciles same-millisecond buffered output in the mounted real terminal viewport", async () => {
  const id = ThreadId.make("terminal-real-viewport");
  const threadRef = scopeThreadRef("environment-a" as never, id);
  const snapshot: TerminalSessionSnapshot = {
    threadId: id,
    terminalId: "default",
    cwd: "/tmp",
    worktreePath: null,
    status: "running",
    pid: 1,
    history: "snapshot",
    exitCode: null,
    exitSignal: null,
    updatedAt: "2026-09-15T00:00:00.000Z",
    cursor: { generation: "real-view", sequence: 1 },
  };
  let resolveOpen!: (snapshot: TerminalSessionSnapshot) => void;
  api.terminal.open.mockImplementationOnce(
    () =>
      new Promise<TerminalSessionSnapshot>((resolve) => {
        resolveOpen = resolve;
      }),
  );
  let viewportTerminal: Terminal | undefined;
  const originalOpen = Terminal.prototype.open;
  vi.spyOn(Terminal.prototype, "open").mockImplementation(function (
    this: Terminal,
    parent: HTMLElement,
  ) {
    viewportTerminal = this;
    originalOpen.call(this, parent);
  });
  mount = document.createElement("div");
  mount.style.cssText = "width:800px;height:400px";
  document.body.append(mount);
  const screen = await render(
    <TerminalViewport
      threadRef={threadRef}
      threadId={id}
      terminalId="default"
      terminalLabel="Terminal"
      cwd="/tmp"
      onSessionExited={() => undefined}
      onAddTerminalContext={() => undefined}
      focusRequestId={0}
      autoFocus={false}
      resizeEpoch={0}
      drawerHeight={320}
      keybindings={[]}
    />,
    { container: mount },
  );
  try {
    await vi.waitFor(() => expect(resolveOpen).toBeDefined());
    const output = {
      threadId: id,
      terminalId: "default",
      type: "output" as const,
      createdAt: snapshot.updatedAt,
      cursor: { generation: "real-view", sequence: 2 },
      data: " live🙂",
    };
    useTerminalStateStore.getState().applyTerminalEvent(threadRef, output);
    resolveOpen(snapshot);
    await vi.waitFor(() =>
      expect(viewportTerminal?.buffer.active.getLine(0)?.translateToString(true)).toBe(
        "snapshot live🙂",
      ),
    );
    useTerminalStateStore.getState().applyTerminalEvent(threadRef, output);
    useTerminalStateStore.getState().applyTerminalEvent(threadRef, {
      ...output,
      cursor: { generation: "real-view", sequence: 3 },
      type: "cleared",
    });
    useTerminalStateStore.getState().applyTerminalEvent(threadRef, {
      ...output,
      cursor: { generation: "real-view", sequence: 4 },
      data: "after reset",
    });
    await vi.waitFor(() =>
      expect(viewportTerminal?.buffer.active.getLine(0)?.translateToString(true)).toBe(
        "after reset",
      ),
    );
  } finally {
    await screen.unmount();
    useTerminalStateStore.getState().removeTerminalState(threadRef);
  }
});

it("keeps scrollback on a caught-up reconnect replay and re-hydrates when output was missed", async () => {
  const id = ThreadId.make("terminal-replay-resync");
  const threadRef = scopeThreadRef("environment-a" as never, id);
  const snapshot: TerminalSessionSnapshot = {
    threadId: id,
    terminalId: "default",
    cwd: "/tmp",
    worktreePath: null,
    status: "running",
    pid: 1,
    history: "snapshot",
    exitCode: null,
    exitSignal: null,
    updatedAt: "2026-10-11T00:00:00.000Z",
    cursor: { generation: "resync-view", sequence: 1 },
  };
  const opens = api.terminal.open.mock.calls.length;
  api.terminal.open.mockResolvedValueOnce(snapshot);
  const terminalOpen = vi.spyOn(Terminal.prototype, "open");
  mount = document.createElement("div");
  mount.style.cssText = "width:800px;height:400px";
  document.body.append(mount);
  const screen = await render(
    <TerminalViewport
      threadRef={threadRef}
      threadId={id}
      terminalId="default"
      terminalLabel="Terminal"
      cwd="/tmp"
      onSessionExited={() => undefined}
      onAddTerminalContext={() => undefined}
      focusRequestId={0}
      autoFocus={false}
      resizeEpoch={0}
      drawerHeight={320}
      keybindings={[]}
    />,
    { container: mount },
  );
  const firstLine = () =>
    (terminalOpen.mock.contexts.at(-1) as Terminal | undefined)?.buffer.active
      .getLine(0)
      ?.translateToString(true);
  const replay = (sequence: number) => ({
    type: "started" as const,
    threadId: id,
    terminalId: "default",
    createdAt: snapshot.updatedAt,
    cursor: { generation: "resync-view", sequence },
    snapshot: { ...snapshot, history: "", cursor: { generation: "resync-view", sequence } },
    replay: true as const,
  });
  try {
    await vi.waitFor(() => expect(firstLine()).toBe("snapshot"));
    useTerminalStateStore.getState().applyTerminalEvent(threadRef, {
      type: "output",
      threadId: id,
      terminalId: "default",
      createdAt: snapshot.updatedAt,
      cursor: { generation: "resync-view", sequence: 2 },
      data: " live",
    });
    await vi.waitFor(() => expect(firstLine()).toBe("snapshot live"));

    // Reconnect after seeing everything: the history-free replay must not blank or reopen.
    useTerminalStateStore.getState().applyTerminalEvent(threadRef, replay(2));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(firstLine()).toBe("snapshot live");
    expect(api.terminal.open.mock.calls.length).toBe(opens + 1);

    // Output was missed while disconnected: re-hydrate through terminal.open.
    api.terminal.open.mockResolvedValueOnce({
      ...snapshot,
      history: "snapshot live missed",
      cursor: { generation: "resync-view", sequence: 5 },
    });
    useTerminalStateStore.getState().applyTerminalEvent(threadRef, replay(5));
    await vi.waitFor(() => expect(firstLine()).toBe("snapshot live missed"));
    expect(api.terminal.open.mock.calls.length).toBe(opens + 2);
    expect(
      useTerminalStateStore.getState().terminalStateByThreadKey[scopedThreadKey(threadRef)]
        ?.terminalOpen ?? false,
    ).toBe(false);
  } finally {
    await screen.unmount();
    useTerminalStateStore.getState().removeTerminalState(threadRef);
  }
});

it("re-hydrates a missed reconnect from the history after the view's cursor", async () => {
  const id = ThreadId.make("terminal-replay-delta");
  const threadRef = scopeThreadRef("environment-a" as never, id);
  const cursor = (sequence: number) => ({ generation: "delta-view", sequence });
  const snapshot: TerminalSessionSnapshot = {
    threadId: id,
    terminalId: "default",
    cwd: "/tmp",
    worktreePath: null,
    status: "running",
    pid: 1,
    history: "snapshot",
    exitCode: null,
    exitSignal: null,
    updatedAt: "2026-10-12T00:00:00.000Z",
    cursor: cursor(1),
  };
  const output = (sequence: number, data: string) => ({
    type: "output" as const,
    threadId: id,
    terminalId: "default",
    createdAt: snapshot.updatedAt,
    cursor: cursor(sequence),
    data,
  });
  api.terminal.open.mockResolvedValueOnce(snapshot);
  const terminalOpen = vi.spyOn(Terminal.prototype, "open");
  const terminalWrite = vi.spyOn(Terminal.prototype, "write");
  mount = document.createElement("div");
  mount.style.cssText = "width:800px;height:400px";
  document.body.append(mount);
  const screen = await render(
    <TerminalViewport
      threadRef={threadRef}
      threadId={id}
      terminalId="default"
      terminalLabel="Terminal"
      cwd="/tmp"
      onSessionExited={() => undefined}
      onAddTerminalContext={() => undefined}
      focusRequestId={0}
      autoFocus={false}
      resizeEpoch={0}
      drawerHeight={320}
      keybindings={[]}
    />,
    { container: mount },
  );
  const firstLine = () =>
    (terminalOpen.mock.contexts.at(-1) as Terminal | undefined)?.buffer.active
      .getLine(0)
      ?.translateToString(true);
  try {
    await vi.waitFor(() => expect(firstLine()).toBe("snapshot"));
    useTerminalStateStore.getState().applyTerminalEvent(threadRef, output(2, " live"));
    await vi.waitFor(() => expect(firstLine()).toBe("snapshot live"));

    let answer!: (snapshot: TerminalSessionSnapshot) => void;
    api.terminal.open.mockImplementationOnce(
      () =>
        new Promise<TerminalSessionSnapshot>((resolve) => {
          answer = resolve;
        }),
    );
    terminalWrite.mockClear();
    // Output 3-4 was missed while disconnected; 4 and 6 arrive while the open is in flight.
    useTerminalStateStore.getState().applyTerminalEvent(threadRef, {
      type: "started",
      threadId: id,
      terminalId: "default",
      createdAt: snapshot.updatedAt,
      cursor: cursor(4),
      snapshot: { ...snapshot, history: "", cursor: cursor(4) },
      replay: true,
    });
    await vi.waitFor(() => expect(answer).toBeDefined());
    expect(api.terminal.open).toHaveBeenLastCalledWith(
      expect.objectContaining({ sinceCursor: cursor(2) }),
    );
    useTerminalStateStore.getState().applyTerminalEvent(threadRef, output(4, " four"));
    useTerminalStateStore.getState().applyTerminalEvent(threadRef, output(6, " six"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(firstLine()).toBe("snapshot live");

    answer({ ...snapshot, history: " three four", cursor: cursor(5), historySince: cursor(2) });
    await vi.waitFor(() => expect(firstLine()).toBe("snapshot live three four six"));
    // Appended, never reset and rewritten.
    expect(terminalWrite).not.toHaveBeenCalledWith("\u001bc");
  } finally {
    await screen.unmount();
    useTerminalStateStore.getState().removeTerminalState(threadRef);
  }
});

it("restores a real xterm alternate screen and preserves replay/live/reset byte order", async () => {
  mount = document.createElement("div");
  mount.style.cssText = "width:800px;height:360px";
  document.body.append(mount);
  const term = new Terminal({ cols: 80, rows: 20, allowProposedApi: true });
  terminal = term;
  term.open(mount);
  const parsed = () => new Promise<void>((resolve) => term.write("", resolve));
  const replies: string[] = [];
  term.onData((data) => replies.push(data));
  const snapshot: TerminalSessionSnapshot = {
    threadId: "t",
    terminalId: "default",
    cwd: "/tmp",
    worktreePath: null,
    status: "running",
    pid: 1,
    exitCode: null,
    exitSignal: null,
    history: "normal\r\n\u001b[?1049h\u001b[2J\u001b[Halternate",
    updatedAt: "2026-09-15T00:00:00.000Z",
    cursor: { generation: "server", sequence: 1 },
  };
  const reconciler = createTerminalEventReconciler();
  reconciler.reset(snapshot);
  writeTerminalSnapshot(term, snapshot);
  const batcher = createTerminalOutputBatcher({ write: (data) => term.write(data) });
  const live = {
    threadId: "t",
    terminalId: "default",
    type: "output" as const,
    createdAt: snapshot.updatedAt,
    cursor: { generation: "server", sequence: 2 },
    data: " live🙂",
  };
  if (reconciler.accept(live)) batcher.writeOutput(live.data);
  if (reconciler.accept(live)) batcher.writeOutput(live.data);
  batcher.flush();
  await parsed();
  expect(term.buffer.active.type).toBe("alternate");
  expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("alternate live🙂");
  expect(replies).toEqual([]);

  const recovered = {
    ...snapshot,
    history: snapshot.history + live.data,
    cursor: { generation: "next-server", sequence: 1 },
  };
  reconciler.reset(recovered);
  writeTerminalSnapshot(term, recovered);
  if (reconciler.accept({ ...live, data: "stale" })) batcher.writeOutput("stale");
  batcher.flush();
  await parsed();
  expect(term.buffer.active.type).toBe("alternate");
  expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("alternate live🙂");
  const leave = {
    ...live,
    cursor: { generation: "next-server", sequence: 2 },
    data: "\u001b[?1049l",
  };
  if (reconciler.accept(leave)) batcher.writeOutput(leave.data);
  batcher.dispose();
  await parsed();
  expect(term.buffer.active.type).toBe("normal");
  expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("normal");
});

import "../index.css";
import { EnvironmentId, ThreadId } from "@ryco/contracts";
import type { TerminalSessionSnapshot } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

const { apis } = vi.hoisted(() => ({ apis: new Map<string, unknown>() }));
vi.mock("../environmentApi", () => ({
  readEnvironmentApi: (environmentId: string) => apis.get(environmentId),
  ensureEnvironmentApi: (environmentId: string) => apis.get(environmentId),
}));
vi.mock("../localApi", () => ({
  readLocalApi: () => ({
    contextMenu: { show: async () => null },
    shell: { openExternal: async () => undefined },
  }),
  ensureLocalApi: () => {
    throw new Error("Unavailable in fixture");
  },
}));
vi.mock("@pierre/diffs", () => ({
  getSharedHighlighter: async () => ({ codeToHtml: () => "<pre><code>fixture</code></pre>" }),
}));

import ChatMarkdown from "./ChatMarkdown";
import { TerminalViewport } from "./ThreadTerminalDrawer";
import { TerminalSnippetActionContext } from "./chat/CodeBlockActions";
import { terminalSnippetBroker } from "../terminalSnippetInsertion";
import { useTerminalStateStore } from "../terminalStateStore";
import { useTierOverrideStore } from "../tierOverrideStore";
import { syncDocumentPresentationTier } from "../lib/presentationTier";

const threadRef = {
  environmentId: EnvironmentId.make("synthetic-node-a"),
  threadId: ThreadId.make("synthetic-thread-a"),
};
const target = {
  threadRef,
  terminalId: "fresh-snippet",
  cwd: "/synthetic/worktree",
  worktreePath: "/synthetic/worktree",
};
const snapshot: TerminalSessionSnapshot = {
  threadId: threadRef.threadId,
  terminalId: target.terminalId,
  cwd: target.cwd,
  worktreePath: target.worktreePath,
  status: "running",
  pid: 123,
  history: "\x1b[?2004h$ ",
  exitCode: null,
  exitSignal: null,
  updatedAt: "2026-09-01T00:00:00.000Z",
  cursor: { generation: "synthetic-server", sequence: 1 },
  inputEpoch: "synthetic-process",
};

async function viewport(open: () => Promise<TerminalSessionSnapshot>) {
  const write = vi.fn(async () => undefined);
  const terminalOpen = vi.fn(open);
  apis.set(threadRef.environmentId, {
    terminal: { open: terminalOpen, write, resize: async () => undefined },
  });
  const screen = await render(
    <div className="thread-terminal-drawer" style={{ width: 800, height: 320 }}>
      <TerminalViewport
        threadRef={threadRef}
        threadId={threadRef.threadId}
        terminalId={target.terminalId}
        terminalLabel="Snippet terminal"
        cwd={target.cwd}
        worktreePath={target.worktreePath}
        onSessionExited={() => undefined}
        onAddTerminalContext={() => undefined}
        focusRequestId={0}
        autoFocus={false}
        resizeEpoch={0}
        drawerHeight={320}
        keybindings={[]}
      />
    </div>,
  );
  return { screen, write, terminalOpen };
}

describe("shell snippet insertion", () => {
  let stopTier: () => void;
  beforeEach(() => {
    useTierOverrideStore.setState({ override: "desktop" });
    stopTier = syncDocumentPresentationTier();
  });
  afterEach(() => {
    useTierOverrideStore.setState({ override: null });
    stopTier();
    terminalSnippetBroker.inputBlocked(target, "cleanup-new-epoch");
    apis.clear();
    useTerminalStateStore.setState({
      terminalEventEntriesByKey: {},
      terminalEventReconciliationByKey: {},
    });
  });

  it("keeps insertion absent on the frozen web phone tier", async () => {
    useTierOverrideStore.setState({ override: "phone" });
    const insert = vi.fn(async () => undefined);
    const screen = await render(
      <TerminalSnippetActionContext value={insert}>
        <ChatMarkdown allowTerminalInsertion cwd={undefined} text={"```sh\nprintf 'hello'\n```"} />
      </TerminalSnippetActionContext>,
    );
    await expect.element(screen.getByRole("button", { name: "Copy code" })).toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: "Insert in terminal" }))
      .not.toBeInTheDocument();
    expect(insert).not.toHaveBeenCalled();
    await screen.unmount();
  });

  it("offers insertion only for complete supported message fences and hands off the exact content", async () => {
    const insert = vi.fn(async () => undefined);
    const source = "printf 'héllo 🌏'\n\tprintf '第二行'\n";
    const screen = await render(
      <TerminalSnippetActionContext value={insert}>
        <ChatMarkdown
          allowTerminalInsertion
          cwd={undefined}
          text={`\`\`\`bash\n${source}\n\`\`\`\n\n\`\`\`js\nalert(1)\n\`\`\``}
        />
      </TerminalSnippetActionContext>,
    );
    await screen.getByRole("button", { name: "Insert in terminal" }).click();
    expect(insert).toHaveBeenCalledExactlyOnceWith(source);
    await screen.rerender(
      <TerminalSnippetActionContext value={insert}>
        <ChatMarkdown allowTerminalInsertion cwd={undefined} text={"```sh\nprintf a"} />
      </TerminalSnippetActionContext>,
    );
    await expect
      .element(screen.getByRole("button", { name: "Insert in terminal" }))
      .not.toBeInTheDocument();
    await screen.rerender(
      <TerminalSnippetActionContext value={insert}>
        <ChatMarkdown
          allowTerminalInsertion
          isStreaming
          cwd={undefined}
          text={"```sh\nprintf a\n```"}
        />
      </TerminalSnippetActionContext>,
    );
    await expect
      .element(screen.getByRole("button", { name: "Insert in terminal" }))
      .not.toBeInTheDocument();
    await screen.unmount();
  });

  it("shows a clear disabled insertion action for empty or oversized snippets", async () => {
    const insert = vi.fn(async () => undefined);
    const screen = await render(
      <TerminalSnippetActionContext value={insert}>
        <ChatMarkdown allowTerminalInsertion cwd={undefined} text={"```sh\n\n```"} />
      </TerminalSnippetActionContext>,
    );
    await expect.element(screen.getByRole("button", { name: "Insert in terminal" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Insert in terminal" }).element().getAttribute("title"),
    ).toContain("empty");
    await screen.rerender(
      <TerminalSnippetActionContext value={insert}>
        <ChatMarkdown
          allowTerminalInsertion
          cwd={undefined}
          text={`\`\`\`zsh\n${"x".repeat(48 * 1024 + 1)}\n\`\`\``}
        />
      </TerminalSnippetActionContext>,
    );
    await expect.element(screen.getByRole("button", { name: "Insert in terminal" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Insert in terminal" }).element().getAttribute("title"),
    ).toContain("48 KiB");
    expect(insert).not.toHaveBeenCalled();
    await screen.unmount();
  });

  it("uses a real xterm's bracketed mode, sends exact bytes to its owning target, and only sends Enter after the user's keypress", async () => {
    const source = "printf 'héllo 🌏'\r\n\tprintf '第二行'\n\n";
    const request = terminalSnippetBroker.request(target, source, () => true);
    const otherWrite = vi.fn();
    apis.set("synthetic-node-b", { terminal: { write: otherWrite } });
    const { screen, write, terminalOpen } = await viewport(async () => snapshot);
    try {
      await request.promise;
      expect(terminalOpen).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: threadRef.threadId,
          terminalId: target.terminalId,
          cwd: target.cwd,
          worktreePath: target.worktreePath,
          requireCurrentWorkspace: true,
        }),
      );
      expect(write).toHaveBeenCalledExactlyOnceWith({
        threadId: threadRef.threadId,
        terminalId: target.terminalId,
        data: `\x1b[200~${source}\x1b[201~`,
        guard: {
          inputEpoch: snapshot.inputEpoch,
          outputCursor: snapshot.cursor,
          cwd: target.cwd,
          worktreePath: target.worktreePath,
        },
      });
      expect(otherWrite).not.toHaveBeenCalled();
      await userEvent.keyboard("{Enter}");
      await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
      expect(write.mock.calls[1]).toEqual([
        { threadId: threadRef.threadId, terminalId: target.terminalId, data: "\r" },
      ]);
    } finally {
      await screen.unmount();
    }
  });

  it("refuses unsupported paste instead of sending multiline input", async () => {
    const request = terminalSnippetBroker.request(target, "printf 'a'\nprintf 'b'", () => true);
    const result = request.promise.catch((error: Error) => error);
    const { screen, write } = await viewport(async () => ({ ...snapshot, history: "$ " }));
    try {
      await vi.waitFor(() =>
        expect(document.querySelector(".xterm-helper-textarea")).not.toBeNull(),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      document.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")!.focus();
      await userEvent.keyboard("{Enter}");
      expect(write).not.toHaveBeenCalled();
      request.cancel();
      expect(await result).toBeInstanceOf(Error);
      expect(write).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("refuses insertion into a full-screen terminal application even if it advertises bracketed paste", async () => {
    const request = terminalSnippetBroker.request(target, "printf 'a'", () => true);
    const result = request.promise.catch((error: Error) => error);
    const { screen, write } = await viewport(async () => ({
      ...snapshot,
      history: "\x1b[?1049h\x1b[?2004h",
    }));
    try {
      expect(await result).toEqual(
        expect.objectContaining({ message: expect.stringContaining("full-screen") }),
      );
      expect(write).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("cancels when the owning thread switches during terminal creation", async () => {
    let current = true;
    let finishOpen!: (value: TerminalSessionSnapshot) => void;
    const request = terminalSnippetBroker.request(target, "printf 'a'", () => current);
    const result = request.promise.catch((error: Error) => error);
    const { screen, write } = await viewport(
      () =>
        new Promise((resolve) => {
          finishOpen = resolve;
        }),
    );
    try {
      await vi.waitFor(() => expect(finishOpen).toBeTypeOf("function"));
      current = false;
      finishOpen(snapshot);
      expect(await result).toBeInstanceOf(Error);
      expect(write).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("refuses a PTY restart during handoff instead of replaying into the replacement process", async () => {
    const request = terminalSnippetBroker.request(target, "printf 'a'", () => true);
    const result = request.promise.catch((error: Error) => error);
    const { screen, write } = await viewport(async () => ({ ...snapshot, history: "$ " }));
    try {
      useTerminalStateStore.getState().applyTerminalEvent(threadRef, {
        threadId: threadRef.threadId,
        terminalId: target.terminalId,
        type: "restarted",
        createdAt: snapshot.updatedAt,
        cursor: { generation: "synthetic-server", sequence: 2 },
        snapshot: {
          ...snapshot,
          inputEpoch: "replacement-process",
          cursor: { generation: "synthetic-server", sequence: 2 },
        },
      });
      expect(await result).toEqual(
        expect.objectContaining({ message: expect.stringContaining("restarted") }),
      );
      expect(write).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("does not steal focus after a thread switch while the insertion acknowledgment is in flight", async () => {
    let current = true;
    let finishWrite!: () => void;
    const request = terminalSnippetBroker.request(target, "printf 'a'", () => current);
    const result = request.promise.catch((error: Error) => error);
    const { screen, write } = await viewport(async () => snapshot);
    write.mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          finishWrite = () => resolve(undefined);
        }),
    );
    const otherThreadButton = document.createElement("button");
    document.body.append(otherThreadButton);
    try {
      await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
      current = false;
      otherThreadButton.focus();
      await vi.waitFor(() => expect(terminalSnippetBroker.read(target)).toBeUndefined());
      expect(await result).toBeInstanceOf(Error);
      finishWrite();
      await Promise.resolve();
      expect(document.activeElement).toBe(otherThreadButton);
      expect(terminalSnippetBroker.inputBlocked(target, snapshot.inputEpoch)).toBe(false);
    } finally {
      otherThreadButton.remove();
      await screen.unmount();
    }
  });

  it("settles a never-resolving ACK on timeout or reconnect, restores the action, and recovers input only in a replacement PTY", async () => {
    for (const mode of ["timeout", "reconnect"]) {
      useTerminalStateStore.setState({
        terminalEventEntriesByKey: {},
        terminalEventReconciliationByKey: {},
      });
      const timers = vi.spyOn(globalThis, "setTimeout");
      let current = true;
      const request = terminalSnippetBroker.request(target, "printf '🌏'", () => current);
      const result = request.promise.catch((error: Error) => error);
      const { screen, write } = await viewport(async () => snapshot);
      write.mockImplementationOnce(() => new Promise<undefined>(() => {}));
      const markdown = await render(
        <TerminalSnippetActionContext value={() => request.promise}>
          <ChatMarkdown allowTerminalInsertion cwd={undefined} text={"```sh\nprintf '🌏'\n```"} />
        </TerminalSnippetActionContext>,
      );
      try {
        await markdown.getByRole("button", { name: "Insert in terminal" }).click();
        await expect.element(markdown.getByRole("button", { name: "Inserting…" })).toBeDisabled();
        await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
        document.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")!.focus();
        await userEvent.keyboard("{Enter}");
        expect(write).toHaveBeenCalledTimes(1);
        if (mode === "reconnect") current = false;
        else {
          const deadline = timers.mock.calls.findLast((call) => call[1] === 10_000)?.[0];
          expect(deadline).toBeTypeOf("function");
          if (typeof deadline === "function") deadline();
        }
        expect(await result).toEqual(
          expect.objectContaining({ message: expect.stringContaining("unconfirmed") }),
        );
        await expect
          .element(markdown.getByRole("button", { name: "Insert in terminal" }))
          .toBeEnabled();
        document.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")!.focus();
        await userEvent.keyboard("{Enter}");
        expect(write).toHaveBeenCalledTimes(1);
        useTerminalStateStore.getState().applyTerminalEvent(threadRef, {
          threadId: threadRef.threadId,
          terminalId: target.terminalId,
          type: "restarted",
          createdAt: snapshot.updatedAt,
          cursor: { generation: "synthetic-server", sequence: 2 },
          snapshot: {
            ...snapshot,
            history: "\x1b[?2004h$ ",
            inputEpoch: "new-process",
            cursor: { generation: "synthetic-server", sequence: 2 },
          },
        });
        await vi.waitFor(() =>
          expect(terminalSnippetBroker.inputBlocked(target, "new-process")).toBe(false),
        );
        document.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")!.focus();
        await userEvent.keyboard("x");
        await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
        expect(write.mock.calls[1]).toEqual([
          { threadId: threadRef.threadId, terminalId: target.terminalId, data: "x" },
        ]);
      } finally {
        await markdown.unmount();
        await screen.unmount();
        timers.mockRestore();
      }
    }
  });

  it("settles teardown with a forever-lost ACK without dispatching or replaying Enter", async () => {
    const request = terminalSnippetBroker.request(target, "printf 'a'", () => true);
    const result = request.promise.catch((error: Error) => error);
    const { screen, write } = await viewport(async () => snapshot);
    write.mockImplementationOnce(() => new Promise<undefined>(() => {}));
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    await screen.unmount();
    expect(await result).toEqual(
      expect.objectContaining({ message: expect.stringContaining("unconfirmed") }),
    );
    expect(terminalSnippetBroker.read(target)).toBeUndefined();
    expect(terminalSnippetBroker.inputBlocked(target, snapshot.inputEpoch)).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
  });
  it("reports creation failures and older servers without writing or retrying", async () => {
    for (const open of [
      async () => {
        throw new Error("synthetic spawn failure");
      },
      async () => {
        const { inputEpoch: _epoch, ...old } = snapshot;
        return old;
      },
    ]) {
      const request = terminalSnippetBroker.request(target, "printf 'a'", () => true);
      const result = request.promise.catch((error: Error) => error);
      const { screen, write, terminalOpen } = await viewport(open);
      try {
        expect(await result).toBeInstanceOf(Error);
        expect(write).not.toHaveBeenCalled();
        expect(terminalOpen).toHaveBeenCalledTimes(1);
      } finally {
        await screen.unmount();
      }
    }
  });
});

import { TerminalInputRejectedError, type EnvironmentApi } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  bracketedTerminalSnippet,
  createTerminalSnippetBroker,
  isTerminalSnippetLanguage,
  MAX_TERMINAL_SNIPPET_BYTES,
  terminalSnippetError,
} from "./snippet.ts";

const target = {
  threadRef: { environmentId: "node-a" as never, threadId: "thread-a" as never },
  terminalId: "fresh",
  cwd: "/synthetic/worktree",
  worktreePath: "/synthetic/worktree",
};

describe("terminal snippet handoff", () => {
  it("preserves all multiline Unicode and trailing newline bytes inside the paste envelope", () => {
    const source = "printf 'héllo 🌏'\r\n\tprintf '第二行'\n\n";
    const data = bracketedTerminalSnippet(source);
    expect(data.slice(6, -6)).toBe(source);
    expect(data).toBe(`\x1b[200~${source}\x1b[201~`);
    expect(data.endsWith("\n")).toBe(false);
    expect(data.endsWith("\r")).toBe(false);
  });
  it("restricts languages, sizes and control bytes without rewriting code", () => {
    for (const language of ["shell", "bash", "sh", "zsh", "BASH"])
      expect(isTerminalSnippetLanguage(language)).toBe(true);
    for (const language of ["text", "powershell", "console", "js", ""])
      expect(isTerminalSnippetLanguage(language)).toBe(false);
    for (const source of [
      "",
      " \n\t",
      "a\x1b[201~\r",
      "a\x00",
      "a\x03",
      "a\u009b",
      "a\ud800",
      "é".repeat(MAX_TERMINAL_SNIPPET_BYTES),
    ])
      expect(terminalSnippetError(source)).not.toBeNull();
    expect(terminalSnippetError("a".repeat(MAX_TERMINAL_SNIPPET_BYTES))).toBeNull();
    expect(terminalSnippetError("printf '🌏'\n")).toBeNull();
  });
  it("only hands off to the exact owning node, thread and terminal once", async () => {
    const broker = createTerminalSnippetBroker();
    const request = broker.request(target, "printf 'hello'", () => true);
    expect(
      broker.read({
        ...target,
        threadRef: { ...target.threadRef, environmentId: "node-b" as never },
      }),
    ).toBeUndefined();
    expect(
      broker.read({ ...target, threadRef: { ...target.threadRef, threadId: "thread-b" as never } }),
    ).toBeUndefined();
    expect(broker.read({ ...target, terminalId: "focused-other-pane" })).toBeUndefined();
    const pending = broker.read(target)!;
    const send = vi.fn(async () => undefined);
    pending.dispatch("epoch", send);
    pending.dispatch("epoch", send);
    await request.promise;
    expect(send).toHaveBeenCalledExactlyOnceWith("printf 'hello'");
    expect(broker.read(target)).toBeUndefined();
  });
  it("never replays a request after cancellation, changed generation or a failed write", async () => {
    const broker = createTerminalSnippetBroker();
    for (const mode of ["cancel", "stale", "failure"]) {
      const request = broker.request(target, "printf 'hello'", () => mode !== "stale");
      const result = expect(request.promise).rejects.toThrow();
      const pending = broker.read(target)!;
      const send = vi.fn(async () => {
        throw new Error("connection lost");
      });
      if (mode === "cancel") request.cancel();
      else pending.dispatch("epoch", send);
      await result;
      expect(broker.read(target)).toBeUndefined();
      if (mode !== "failure") expect(send).not.toHaveBeenCalled();
    }
  });
  it("times out unsupported paste without sending or retaining the snippet", async () => {
    vi.useFakeTimers();
    try {
      const broker = createTerminalSnippetBroker();
      const request = broker.request(target, "printf 'hello'", () => true);
      const result = expect(request.promise).rejects.toThrow("Nothing was sent");
      await vi.advanceTimersByTimeAsync(10_000);
      await result;
      expect(broker.read(target)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not let a stale completion cancel a replacement handoff", async () => {
    const broker = createTerminalSnippetBroker();
    const first = broker.request(target, "printf 'first'", () => true);
    const stale = broker.read(target)!;
    stale.dispatch("epoch", async () => undefined);
    await first.promise;
    const second = broker.request(target, "printf 'second'", () => true);
    stale.complete(new Error("late failure"));
    first.cancel();
    expect(broker.read(target)?.source).toBe("printf 'second'");
    broker.read(target)!.complete();
    await second.promise;
  });
  it("bounds a forever-lost write ACK, never replays, and fences only the uncertain PTY epoch", async () => {
    vi.useFakeTimers();
    try {
      const broker = createTerminalSnippetBroker();
      const request = broker.request(target, "printf 'a'", () => true);
      const entry = broker.read(target)!;
      const send = vi.fn(() => new Promise<void>(() => {}));
      const result = expect(request.promise).rejects.toThrow("delivery is unconfirmed");
      await vi.advanceTimersByTimeAsync(9_000);
      entry.dispatch("old-epoch", send);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(broker.read(target)).toBe(entry);
      await vi.advanceTimersByTimeAsync(1);
      await result;
      expect(broker.read(target)).toBeUndefined();
      expect(broker.inputBlocked(target, "old-epoch")).toBe(true);
      expect(broker.inputBlocked({ ...target, terminalId: "new-pane" }, "new-epoch")).toBe(false);
      expect(() => broker.request(target, "printf 'a'", () => true)).toThrow("unconfirmed");
      entry.dispatch("old-epoch", send);
      request.cancel();
      expect(send).toHaveBeenCalledTimes(1);
      expect(broker.inputBlocked(target, "replacement-epoch")).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("settles cancellation after dispatch even if the ACK never arrives", async () => {
    const broker = createTerminalSnippetBroker();
    const request = broker.request(target, "printf 'a'", () => true);
    const entry = broker.read(target)!;
    const send = vi.fn(() => new Promise<void>(() => {}));
    entry.dispatch("epoch", send);
    const result = expect(request.promise).rejects.toThrow("delivery is unconfirmed");
    request.cancel();
    await result;
    entry.dispatch("epoch", send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(broker.read(target)).toBeUndefined();
    expect(broker.inputBlocked(target, "epoch")).toBe(true);
  });
  it("ignores late ACK settlement, releases only its own input fence, and preserves a replacement request", async () => {
    const broker = createTerminalSnippetBroker();
    let acknowledge!: () => void;
    const first = broker.request(target, "printf 'first'", () => true);
    const stale = broker.read(target)!;
    stale.dispatch(
      "old-epoch",
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve;
        }),
    );
    const result = expect(first.promise).rejects.toThrow("delivery is unconfirmed");
    first.cancel();
    await result;
    expect(broker.inputBlocked(target, "new-epoch")).toBe(false);
    const second = broker.request(target, "printf 'second'", () => true);
    const current = broker.read(target)!;
    current.dispatch("new-epoch", () => new Promise<void>(() => {}));
    acknowledge();
    await Promise.resolve();
    expect(broker.read(target)).toBe(current);
    expect(broker.inputBlocked(target, "new-epoch")).toBe(true);
    const secondResult = expect(second.promise).rejects.toThrow("delivery is unconfirmed");
    second.cancel();
    await secondResult;
  });

  it("releases the input fence on authoritative rejection without claiming ambiguous delivery", async () => {
    const broker = createTerminalSnippetBroker();
    const request = broker.request(target, "printf 'a'", () => true);
    const result = expect(request.promise).rejects.toThrow("Workspace changed");
    broker.read(target)!.dispatch("epoch", async () => {
      throw new TerminalInputRejectedError({ message: "Workspace changed" });
    });
    await result;
    expect(broker.inputBlocked(target, "epoch")).toBe(false);
  });
  it("never submits the legacy exit/Enter fallback for uncertain delivery and releases evidence only on confirmed closure", async () => {
    const broker = createTerminalSnippetBroker();
    const request = broker.request(target, "printf 'a'", () => true);
    broker.read(target)!.dispatch("epoch", () => new Promise<void>(() => {}));
    const result = expect(request.promise).rejects.toThrow("unconfirmed");
    const write = vi.fn(async () => undefined);
    const clear = vi.fn(async () => undefined);
    const close = vi.fn(async (): Promise<void> => {
      throw new Error("lost close ACK");
    });
    const terminal = { write, clear, close } as unknown as EnvironmentApi["terminal"];
    await expect(broker.close(target, terminal, true)).rejects.toThrow("lost close ACK");
    await result;
    expect(write).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(broker.inputBlocked(target, "epoch")).toBe(true);
    close.mockImplementationOnce(async () => undefined);
    await broker.close(target, terminal, true);
    expect(broker.inputBlocked(target, "epoch")).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
  it("does not execute an acknowledged snippet through a failed-close Enter fallback", async () => {
    const broker = createTerminalSnippetBroker();
    const request = broker.request(target, "printf 'a'", () => true);
    broker.read(target)!.dispatch("epoch", async () => undefined);
    await request.promise;
    expect(broker.inputBlocked(target, "epoch")).toBe(false);
    const write = vi.fn(async () => undefined);
    const clear = vi.fn(async () => undefined);
    const close = vi.fn(async () => {
      throw new Error("close failed");
    });
    await expect(
      broker.close(target, { write, clear, close } as unknown as EnvironmentApi["terminal"], true),
    ).rejects.toThrow("close failed");
    expect(write).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });
  it("retains ordinary terminal closure and its compatibility fallback for panes without snippets", async () => {
    const broker = createTerminalSnippetBroker();
    const calls: string[] = [];
    const terminal = {
      clear: async () => {
        calls.push("clear");
      },
      close: async () => {
        calls.push("close");
      },
      write: async (input: { data: string }) => {
        calls.push(input.data);
      },
    } as unknown as EnvironmentApi["terminal"];
    await broker.close(target, terminal, true);
    expect(calls).toEqual(["clear", "close"]);
    terminal.close = async () => {
      throw new Error("ordinary close failure");
    };
    await broker.close(target, terminal, false);
    expect(calls).toEqual(["clear", "close", "exit\n"]);
  });
});

import { describe, expect, it, vi } from "vite-plus/test";

import type { TerminalEvent } from "@ryco/contracts";

import { runScriptInTerminal, shellPromptShown } from "./runScriptInTerminal";

const request = { cwd: "/r", worktreePath: null, env: { RYCO_PROJECT_ROOT: "/r" }, input: "ls\r" };

function fakeApi(history: string, failWrite = false) {
  let listener: ((event: TerminalEvent) => void) | null = null;
  const calls: string[] = [];
  return {
    calls,
    emit: (event: Partial<TerminalEvent>) => listener?.(event as TerminalEvent),
    api: {
      onEvent: (callback: (event: TerminalEvent) => void) => {
        listener = callback;
        calls.push("subscribe");
        return () => {
          listener = null;
          calls.push("unsubscribe");
        };
      },
      open: vi.fn(async () => {
        calls.push("open");
        return { history } as never;
      }),
      write: vi.fn(async (input: { data: string }) => {
        calls.push(`write:${input.data}`);
        if (failWrite) throw new Error("socket closed");
      }),
      close: vi.fn(async () => {
        calls.push("close");
      }),
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("runScriptInTerminal", () => {
  it("recognises a line editor that started reading", () => {
    expect(shellPromptShown("\u001b[0m% \u001b[K\u001b[?2004h")).toBe(true);
    expect(shellPromptShown("Loading plugins…")).toBe(false);
  });

  it("types at once when the snapshot shows the prompt", async () => {
    const fake = fakeApi("% \u001b[?2004h");
    await runScriptInTerminal({ api: fake.api, threadId: "t", terminalId: "x", request });
    expect(fake.calls).toEqual(["subscribe", "open", "unsubscribe", "write:ls\r"]);
  });

  it("types once a shell that already printed something stays quiet", async () => {
    const fake = fakeApi("% ");
    await runScriptInTerminal({
      api: fake.api,
      threadId: "t",
      terminalId: "x",
      request,
      quietMs: 1,
    });
    expect(fake.calls).toEqual(["subscribe", "open", "unsubscribe", "write:ls\r"]);
  });

  it("waits for a starting shell's line editor", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeApi("");
      const run = runScriptInTerminal({
        api: fake.api,
        threadId: "t",
        terminalId: "x",
        request,
        quietMs: 2_000,
        timeoutMs: 10_000,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fake.calls).toEqual(["subscribe", "open"]);
      fake.emit({ threadId: "t", terminalId: "other", type: "output", data: "x" });
      fake.emit({ threadId: "t", terminalId: "x", type: "output", data: "loading" });
      await vi.advanceTimersByTimeAsync(300);
      await vi.advanceTimersByTimeAsync(300);
      expect(fake.calls).toEqual(["subscribe", "open"]);
      fake.emit({ threadId: "t", terminalId: "x", type: "output", data: "% \u001b[?2004h" });
      await run;
      expect(fake.calls).toEqual(["subscribe", "open", "unsubscribe", "write:ls\r"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("types anyway after the timeout", async () => {
    const fake = fakeApi("");
    await runScriptInTerminal({
      api: fake.api,
      threadId: "t",
      terminalId: "x",
      request,
      timeoutMs: 5,
    });
    await tick();
    expect(fake.calls.at(-1)).toBe("write:ls\r");
  });

  it("closes the shell on the machine when the run fails after it opened", async () => {
    const fake = fakeApi("% \u001b[?2004h", true);
    await expect(
      runScriptInTerminal({ api: fake.api, threadId: "t", terminalId: "x", request }),
    ).rejects.toThrow("socket closed");
    expect(fake.calls).toEqual(["subscribe", "open", "unsubscribe", "write:ls\r", "close"]);
  });
});

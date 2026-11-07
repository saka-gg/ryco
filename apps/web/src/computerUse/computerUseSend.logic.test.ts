import type { ComputerBetaState, ComputerTurnIntent } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  computerUseSendBlocker,
  DEFAULT_COMPUTER_SEND_DEADLINE_MS,
  isExternalOpenCodeInstance,
  resolveComputerSendIntent,
} from "./computerUseSend.logic";

describe("computerUseSendBlocker", () => {
  const ready = { provider: "codex", agentControlEnabled: true, externalOpenCode: false };
  it("allows a supported provider with Agent Control on", () => {
    expect(computerUseSendBlocker(ready)).toBeNull();
  });
  it("names what blocks Computer Use", () => {
    expect(computerUseSendBlocker({ ...ready, provider: "grok" })).toContain("does not support");
    expect(computerUseSendBlocker({ ...ready, agentControlEnabled: false })).toContain(
      "Turn on Computer Use",
    );
    expect(
      computerUseSendBlocker({ ...ready, provider: "opencode", externalOpenCode: true }),
    ).toContain("managed OpenCode");
  });
  it("detects an external OpenCode server", () => {
    expect(isExternalOpenCodeInstance("opencode", { serverUrl: "http://x" })).toBe(true);
    expect(isExternalOpenCodeInstance("opencode", { serverUrl: "" })).toBe(false);
    expect(isExternalOpenCodeInstance("codex", { serverUrl: "http://x" })).toBe(false);
    expect(isExternalOpenCodeInstance("opencode", null)).toBe(false);
  });
});

/**
 * A desktop like the real one: permissions read as missing until a check, and `prepare` checks
 * them first. `granted` is what macOS would report.
 */
function fakeDesktop(options: { readonly defaultEnabled: boolean; readonly granted: boolean }) {
  let checked = false;
  const intent: ComputerTurnIntent = { mode: "chat", generation: "epoch:0:thread" };
  const state = () =>
    ({
      preferences: { defaultEnabled: options.defaultEnabled },
      setup: {
        missing: checked && options.granted ? [] : ["accessibility", "screenRecording"],
      },
    }) as unknown as ComputerBetaState;
  const computer = {
    getState: vi.fn(async () => state()),
    prepare: vi.fn(async (_threadId: string, explicit: boolean) => {
      checked = true;
      if (!options.granted) {
        if (explicit) throw new Error("Complete Computer Use setup, then send your task again.");
        return null;
      }
      return explicit ? { ...intent, mode: "request" as const } : intent;
    }),
  };
  return { computer, intent };
}

describe("resolveComputerSendIntent", () => {
  const noBlocker = async () => null;

  // The first send of a new chat after a desktop start: nothing had checked the permissions
  // yet, the send went without its intent, and that turn's session listed no Computer tools.
  it("carries the chat intent on the first default send, before any permission check", async () => {
    const { computer, intent } = fakeDesktop({ defaultEnabled: true, granted: true });
    const resolution = await resolveComputerSendIntent({
      threadId: "thread-1",
      explicit: false,
      computer,
      readBlocker: noBlocker,
    });
    expect(resolution).toEqual({ intent, prepared: false, setupMissing: false });
    expect(computer.prepare).toHaveBeenCalledWith("thread-1", false);
  });

  it("sends a default message without Computer Use and notes missing setup", async () => {
    const { computer } = fakeDesktop({ defaultEnabled: true, granted: false });
    const resolution = await resolveComputerSendIntent({
      threadId: "thread-1",
      explicit: false,
      computer,
      readBlocker: noBlocker,
    });
    expect(resolution).toEqual({ intent: null, prepared: false, setupMissing: true });
  });

  it("asks nothing when Use in every chat is off", async () => {
    const { computer } = fakeDesktop({ defaultEnabled: false, granted: true });
    const readBlocker = vi.fn(noBlocker);
    const resolution = await resolveComputerSendIntent({
      threadId: "thread-1",
      explicit: false,
      computer,
      readBlocker,
    });
    expect(resolution).toEqual({ intent: null, prepared: false, setupMissing: false });
    expect(readBlocker).not.toHaveBeenCalled();
    expect(computer.prepare).not.toHaveBeenCalled();
  });

  it("sends a blocked default message without Computer Use, and an explicit task reports it", async () => {
    const { computer } = fakeDesktop({ defaultEnabled: true, granted: true });
    const readBlocker = async () => "This provider does not support Computer Use.";
    await expect(
      resolveComputerSendIntent({ threadId: "thread-1", explicit: false, computer, readBlocker }),
    ).resolves.toEqual({ intent: null, prepared: false, setupMissing: false });
    await expect(
      resolveComputerSendIntent({ threadId: "thread-1", explicit: true, computer, readBlocker }),
    ).rejects.toThrow("does not support");
    expect(computer.prepare).not.toHaveBeenCalled();
  });

  it("prepares an explicit task even with Use in every chat off, and reports missing setup", async () => {
    const ready = fakeDesktop({ defaultEnabled: false, granted: true });
    await expect(
      resolveComputerSendIntent({
        threadId: "thread-1",
        explicit: true,
        computer: ready.computer,
        readBlocker: noBlocker,
      }),
    ).resolves.toMatchObject({ intent: { mode: "request" }, prepared: true });
    const unready = fakeDesktop({ defaultEnabled: false, granted: false });
    await expect(
      resolveComputerSendIntent({
        threadId: "thread-1",
        explicit: true,
        computer: unready.computer,
        readBlocker: noBlocker,
      }),
    ).rejects.toThrow("Complete Computer Use setup");
  });

  it("sends a default message without Computer Use once its short deadline passes", async () => {
    vi.useFakeTimers();
    try {
      const { computer } = fakeDesktop({ defaultEnabled: true, granted: true });
      computer.prepare.mockImplementation(() => new Promise(() => {}));
      const resolution = resolveComputerSendIntent({
        threadId: "thread-1",
        explicit: false,
        computer,
        readBlocker: noBlocker,
      });
      await vi.advanceTimersByTimeAsync(DEFAULT_COMPUTER_SEND_DEADLINE_MS);
      await expect(resolution).resolves.toEqual({
        intent: null,
        prepared: false,
        setupMissing: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds every step of a default send, settings read included", async () => {
    vi.useFakeTimers();
    try {
      const { computer } = fakeDesktop({ defaultEnabled: true, granted: true });
      const resolution = resolveComputerSendIntent({
        threadId: "thread-1",
        explicit: false,
        computer,
        readBlocker: () => new Promise(() => {}),
        deadlineMs: 200,
      });
      await vi.advanceTimersByTimeAsync(200);
      await expect(resolution).resolves.toMatchObject({ intent: null, prepared: false });
      expect(computer.prepare).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never fails a default send for Computer Use", async () => {
    const { computer } = fakeDesktop({ defaultEnabled: true, granted: true });
    computer.prepare.mockRejectedValue(new Error("desktop gone"));
    await expect(
      resolveComputerSendIntent({
        threadId: "thread-1",
        explicit: false,
        computer,
        readBlocker: noBlocker,
      }),
    ).resolves.toEqual({ intent: null, prepared: false, setupMissing: false });
    await expect(
      resolveComputerSendIntent({
        threadId: "thread-1",
        explicit: false,
        computer,
        readBlocker: async () => {
          throw new Error("settings unavailable");
        },
      }),
    ).resolves.toEqual({ intent: null, prepared: false, setupMissing: false });
  });

  it("lets an explicit task wait past the default deadline", async () => {
    vi.useFakeTimers();
    try {
      const { computer, intent } = fakeDesktop({ defaultEnabled: true, granted: true });
      let finishSetup = (_value: ComputerTurnIntent) => {};
      computer.prepare.mockImplementation(
        () =>
          new Promise<ComputerTurnIntent>((resolve) => {
            finishSetup = resolve;
          }),
      );
      const resolution = resolveComputerSendIntent({
        threadId: "thread-1",
        explicit: true,
        computer,
        readBlocker: noBlocker,
      });
      await vi.advanceTimersByTimeAsync(DEFAULT_COMPUTER_SEND_DEADLINE_MS * 4);
      finishSetup({ ...intent, mode: "request" });
      await expect(resolution).resolves.toMatchObject({
        intent: { mode: "request" },
        prepared: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

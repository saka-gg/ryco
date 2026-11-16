// Adapted from Synara v0.9.1; see docs/licenses/synara-computer-use.txt.
import { describe, expect, it, vi } from "vitest";
import {
  ComputerApprovalExpiredError,
  ComputerApprovalGate,
  ComputerApprovalPendingError,
  ComputerApprovalQueueFullError,
  ComputerApprovalUnavailableError,
  computerApprovalRefusalPayload,
  isComputerApprovalRefusal,
} from "./ComputerApprovalGate.ts";
import { CuaActionError } from "./CuaComputerBackend.ts";
import { ToolInputError } from "./tools/toolInput.ts";

describe("Computer approval refusals", () => {
  it.each([
    ["an expiry", () => new ComputerApprovalExpiredError(), "approval_expired", true],
    ["a second expiry", () => new ComputerApprovalExpiredError(false), "approval_expired", false],
    ["an unanswered dialog", () => new ComputerApprovalPendingError(), "approval_pending", true],
    [
      "a missing dialog",
      () => new ComputerApprovalUnavailableError(),
      "approval_unavailable",
      true,
    ],
    [
      "a dialog that could not be shown again",
      () => new ComputerApprovalUnavailableError(false),
      "approval_unavailable",
      false,
    ],
    [
      "a full prompt queue",
      () => new ComputerApprovalQueueFullError(),
      "approval_queue_full",
      true,
    ],
    [
      "a prompt queue that kept the dialog from showing again",
      () => new ComputerApprovalQueueFullError(false),
      "approval_queue_full",
      false,
    ],
  ] as const)(
    "reports %s as a not-dispatched refusal with its code",
    (_label, make, code, retryable) => {
      const error = make();
      expect(isComputerApprovalRefusal(error)).toBe(true);
      expect(error).toMatchObject({ code, effect: "not-dispatched", retryable });
      expect(computerApprovalRefusalPayload(error)).toStrictEqual({
        error: { code, effect: "not-dispatched", retryable, message: error.message },
      });
    },
  );

  it("tells the agent to stop asking once the desktop stopped asking", () => {
    expect(new ComputerApprovalExpiredError().message).toContain("Request approval again");
    for (const error of [
      new ComputerApprovalExpiredError(false),
      new ComputerApprovalUnavailableError(false),
      new ComputerApprovalQueueFullError(false),
    ])
      expect(error.message).toContain("Do not ask again in this turn");
    expect(new ComputerApprovalUnavailableError().message).toContain("Try again");
  });

  it("does not treat other failures as approval refusals", () => {
    for (const error of [
      new CuaActionError("No input was sent.", "not-dispatched", "approval_expired"),
      new ToolInputError("approval_expired"),
      Object.assign(new Error("approval_expired"), { code: "approval_expired" }),
    ])
      expect(isComputerApprovalRefusal(error)).toBe(false);
  });
});

describe("ComputerApprovalGate per-app approval", () => {
  const safari = { key: "safari", name: "Safari", canAlwaysAllow: true };
  const notes = { key: "notes", name: "Notes", canAlwaysAllow: true };
  const unnamed = { key: "\u0000mac", name: "your Mac", canAlwaysAllow: false };
  function store(initial: readonly string[] = []) {
    const keys = new Set(initial);
    return {
      keys,
      has: async (key: string) => keys.has(key),
      add: async (app: { key: string }) => {
        keys.add(app.key);
      },
    };
  }
  function harness(answers: Array<"always" | "chat" | "deny"> = []) {
    const gate = new ComputerApprovalGate();
    const alwaysAllowed = store();
    const present = vi.fn(async () => answers.shift() ?? "deny");
    const ask = (
      app: { key: string; name: string; canAlwaysAllow: boolean },
      overrides: Partial<{ threadId: string; turnId: string; signal: AbortSignal }> = {},
    ) =>
      gate.requestApp({
        threadId: "thread",
        turnId: "turn",
        app,
        signal: new AbortController().signal,
        alwaysAllowed,
        present,
        ...overrides,
      });
    return { gate, alwaysAllowed, present, ask };
  }

  it("remembers Always allow across chats and turns, and asks again once revoked", async () => {
    const { ask, present, alwaysAllowed } = harness(["always", "chat"]);
    expect(await ask(safari)).toBe(true);
    expect(alwaysAllowed.keys.has("safari")).toBe(true);
    expect(await ask(safari, { threadId: "other", turnId: "t2" })).toBe(true);
    expect(present).toHaveBeenCalledTimes(1);
    // Settings removed it: the next action asks again.
    alwaysAllowed.keys.delete("safari");
    expect(await ask(safari, { threadId: "third", turnId: "t3" })).toBe(true);
    expect(present).toHaveBeenCalledTimes(2);
  });

  it("keeps Allow for this chat to that chat, across its turns", async () => {
    const { ask, present, alwaysAllowed } = harness(["chat", "deny"]);
    expect(await ask(safari)).toBe(true);
    expect(await ask(safari, { turnId: "next-turn" })).toBe(true);
    expect(present).toHaveBeenCalledTimes(1);
    expect(alwaysAllowed.keys.size).toBe(0);
    expect(await ask(safari, { threadId: "other" })).toBe(false);
    expect(present).toHaveBeenCalledTimes(2);
  });

  it("refuses an app the user declined for the rest of the turn only", async () => {
    const { ask, present } = harness(["deny", "chat", "chat"]);
    expect(await ask(safari)).toBe(false);
    expect(await ask(safari)).toBe(false);
    expect(present).toHaveBeenCalledTimes(1);
    // Other apps still ask.
    expect(await ask(notes)).toBe(true);
    // A new turn asks again.
    expect(await ask(safari, { turnId: "next-turn" })).toBe(true);
    expect(present).toHaveBeenCalledTimes(3);
  });

  it("shares one dialog between concurrent calls for the same app", async () => {
    const { ask, present } = harness();
    let answer!: (value: "chat") => void;
    present.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const first = ask(safari);
    const second = ask(safari);
    await Promise.resolve();
    expect(present).toHaveBeenCalledTimes(1);
    answer("chat");
    expect(await Promise.all([first, second])).toEqual([true, true]);
  });

  it("never stores an unnamed target as always allowed, and keeps it to the turn", async () => {
    const { ask, alwaysAllowed, present } = harness(["always", "chat"]);
    expect(await ask(unnamed)).toBe(true);
    expect(alwaysAllowed.keys.size).toBe(0);
    // It counts for the rest of this turn...
    expect(await ask(unnamed)).toBe(true);
    expect(present).toHaveBeenCalledTimes(1);
    // ...but a later turn asks again: one answer must not open every app to window-less calls.
    expect(await ask(unnamed, { turnId: "next" })).toBe(true);
    expect(present).toHaveBeenCalledTimes(2);
  });

  it("clears chat approvals after a desktop interruption but keeps Always allow", async () => {
    const { gate, ask, present } = harness(["chat", "always", "chat"]);
    expect(await ask(safari)).toBe(true);
    expect(await ask(notes)).toBe(true);
    gate.revokeTaskGrants();
    expect(await ask(notes)).toBe(true);
    expect(present).toHaveBeenCalledTimes(2);
    expect(await ask(safari)).toBe(true);
    expect(present).toHaveBeenCalledTimes(3);
  });

  it("records nothing from a dialog answered after Stop ended the turn", async () => {
    const { gate, ask, present, alwaysAllowed } = harness();
    let answer!: (value: "always") => void;
    present.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const pending = ask(safari);
    await Promise.resolve();
    gate.cancelThread("thread", "turn");
    answer("always");
    expect(await pending).toBe(false);
    expect(alwaysAllowed.keys.size).toBe(0);
  });

  it("counts an answer to a dialog that stayed open across an interruption", async () => {
    const { gate, ask, present } = harness();
    let answer!: (value: "chat") => void;
    present.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const pending = ask(safari);
    await Promise.resolve();
    gate.revokeTaskGrants();
    answer("chat");
    expect(await pending).toBe(true);
    expect(await ask(safari)).toBe(true);
    expect(present).toHaveBeenCalledTimes(1);
  });

  it("forgets a removed chat's approvals", async () => {
    const { gate, ask, present } = harness(["chat", "chat"]);
    expect(await ask(safari)).toBe(true);
    gate.forgetThread("thread");
    expect(await ask(safari, { turnId: "next" })).toBe(true);
    expect(present).toHaveBeenCalledTimes(2);
  });

  it("propagates a refusal that is not an answer and asks again on the next call", async () => {
    const { ask, present } = harness(["chat"]);
    present.mockRejectedValueOnce(new ComputerApprovalPendingError());
    await expect(ask(safari)).rejects.toBeInstanceOf(ComputerApprovalPendingError);
    expect(await ask(safari)).toBe(true);
    expect(present).toHaveBeenCalledTimes(2);
  });

  it("lets a cancelled caller leave without settling the shared dialog", async () => {
    const { ask, present } = harness();
    let answer!: (value: "chat") => void;
    present.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const controller = new AbortController();
    const leaving = ask(safari, { signal: controller.signal });
    const staying = ask(safari);
    controller.abort(new Error("caller left"));
    await expect(leaving).rejects.toThrow("caller left");
    answer("chat");
    expect(await staying).toBe(true);
  });
});

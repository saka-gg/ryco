import type { DesktopQuitGuardResponder, DesktopQuitRunningChatsReport } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { answerQuitGuardRequest, parseQuitGuardRequest } from "./quitGuardChannels.ts";

const KNOWN: DesktopQuitRunningChatsReport = {
  status: "known",
  runningCount: 1,
  resumableCount: 1,
  chats: [{ threadId: "t", title: "Chat", status: "working" }],
  otherNodesRunningCount: 0,
  continueThreadsAfterRestart: false,
};

function responder(overrides: Partial<DesktopQuitGuardResponder> = {}): DesktopQuitGuardResponder {
  return {
    runningChats: () => KNOWN,
    setContinueAfterRestart: () => Promise.resolve(),
    ...overrides,
  };
}

describe("parseQuitGuardRequest", () => {
  it("accepts the two requests and nothing else", () => {
    expect(parseQuitGuardRequest({ requestId: "a", kind: "running-chats" })).toEqual({
      requestId: "a",
      kind: "running-chats",
    });
    expect(
      parseQuitGuardRequest({ requestId: "a", kind: "continue-after-restart", enabled: false }),
    ).toEqual({ requestId: "a", kind: "continue-after-restart", enabled: false });
    expect(parseQuitGuardRequest(null)).toBeNull();
    expect(parseQuitGuardRequest({ requestId: "", kind: "running-chats" })).toBeNull();
    expect(parseQuitGuardRequest({ requestId: "x".repeat(129), kind: "running-chats" })).toBeNull();
    expect(parseQuitGuardRequest({ requestId: "a", kind: "continue-after-restart" })).toBeNull();
    expect(parseQuitGuardRequest({ requestId: "a", kind: "quit-now" })).toBeNull();
  });
});

describe("answerQuitGuardRequest", () => {
  it("answers unavailable without a responder", async () => {
    await expect(
      answerQuitGuardRequest(null, { requestId: "a", kind: "running-chats" }),
    ).resolves.toEqual({
      requestId: "a",
      kind: "running-chats",
      report: { status: "unavailable" },
    });
    await expect(
      answerQuitGuardRequest(null, {
        requestId: "b",
        kind: "continue-after-restart",
        enabled: true,
      }),
    ).resolves.toEqual({
      requestId: "b",
      kind: "continue-after-restart",
      saved: false,
      error: "unavailable",
    });
  });

  it("answers unavailable when the responder throws", async () => {
    const failing = responder({
      runningChats: () => {
        throw new Error("store not ready");
      },
      setContinueAfterRestart: () => Promise.reject(new Error("node offline")),
    });
    await expect(
      answerQuitGuardRequest(failing, { requestId: "a", kind: "running-chats" }),
    ).resolves.toEqual({
      requestId: "a",
      kind: "running-chats",
      report: { status: "unavailable" },
    });
    await expect(
      answerQuitGuardRequest(failing, {
        requestId: "b",
        kind: "continue-after-restart",
        enabled: true,
      }),
    ).resolves.toEqual({
      requestId: "b",
      kind: "continue-after-restart",
      saved: false,
      error: "node offline",
    });
  });

  it("round-trips a working responder", async () => {
    const setContinueAfterRestart = vi.fn(() => Promise.resolve());
    const working = responder({ setContinueAfterRestart });
    await expect(
      answerQuitGuardRequest(working, { requestId: "a", kind: "running-chats" }),
    ).resolves.toEqual({ requestId: "a", kind: "running-chats", report: KNOWN });
    await expect(
      answerQuitGuardRequest(working, {
        requestId: "b",
        kind: "continue-after-restart",
        enabled: true,
      }),
    ).resolves.toEqual({ requestId: "b", kind: "continue-after-restart", saved: true });
    expect(setContinueAfterRestart).toHaveBeenCalledWith(true);
  });

  it("does not answer a malformed request", async () => {
    const runningChats = vi.fn(() => KNOWN);
    await expect(
      answerQuitGuardRequest(responder({ runningChats }), { kind: "running-chats" }),
    ).resolves.toBeNull();
    expect(runningChats).not.toHaveBeenCalled();
  });

  it("truncates a long error to 200 characters", async () => {
    const reply = await answerQuitGuardRequest(
      responder({ setContinueAfterRestart: () => Promise.reject(new Error("x".repeat(500))) }),
      { requestId: "b", kind: "continue-after-restart", enabled: true },
    );
    expect(reply).toMatchObject({ saved: false, error: "x".repeat(200) });
    const thrownString = await answerQuitGuardRequest(
      responder({ setContinueAfterRestart: () => Promise.reject("plain") }),
      { requestId: "c", kind: "continue-after-restart", enabled: true },
    );
    expect(thrownString).toMatchObject({ saved: false, error: "plain" });
  });
});

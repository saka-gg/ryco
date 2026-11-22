import { describe, expect, it } from "vite-plus/test";

import { type AccessSubject, decideTerminalAccess, isAgentTerminalId } from "./access.ts";

const NOW = 1_000_000;

const subject = (overrides: Partial<AccessSubject> = {}): AccessSubject => ({
  callerThreadId: "thread-1",
  terminalThreadId: "thread-1",
  terminalId: "default",
  fullAccess: false,
  consent: "none",
  refusedUntil: undefined,
  now: NOW,
  ...overrides,
});

describe("decideTerminalAccess", () => {
  it("denies every use of another thread's terminal", () => {
    for (const use of ["read", "control", "close"] as const) {
      expect(
        decideTerminalAccess(
          subject({ terminalThreadId: "thread-2", terminalId: "agent-1", fullAccess: true }),
          use,
        ),
      ).toEqual({ kind: "denied", reason: "other-thread" });
    }
  });

  it("allows everything on the agent's own terminals", () => {
    expect(isAgentTerminalId("agent-1")).toBe(true);
    for (const use of ["read", "control", "close"] as const) {
      expect(decideTerminalAccess(subject({ terminalId: "agent-1" }), use)).toEqual({
        kind: "allowed",
      });
    }
  });

  it("allows reading a user terminal", () => {
    expect(decideTerminalAccess(subject(), "read")).toEqual({ kind: "allowed" });
  });

  it("never lets the agent close a user terminal", () => {
    expect(
      decideTerminalAccess(subject({ fullAccess: true, consent: "granted" }), "close"),
    ).toEqual({ kind: "denied", reason: "user-terminal-close" });
  });

  describe("control of a user terminal", () => {
    it("is allowed in a Full access thread", () => {
      expect(decideTerminalAccess(subject({ fullAccess: true }), "control")).toEqual({
        kind: "allowed",
      });
    });

    it("is allowed once granted", () => {
      expect(decideTerminalAccess(subject({ consent: "granted" }), "control")).toEqual({
        kind: "allowed",
      });
    });

    it("waits while the user has not answered", () => {
      expect(decideTerminalAccess(subject({ consent: "pending" }), "control")).toEqual({
        kind: "pending",
      });
    });

    it("is denied after a decline", () => {
      expect(decideTerminalAccess(subject({ consent: "declined" }), "control")).toEqual({
        kind: "denied",
        reason: "declined",
      });
    });

    it("is denied during the cooldown of an earlier decline", () => {
      expect(decideTerminalAccess(subject({ refusedUntil: NOW + 1 }), "control")).toEqual({
        kind: "denied",
        reason: "cooldown",
      });
    });

    it("asks once the cooldown has passed", () => {
      expect(decideTerminalAccess(subject({ refusedUntil: NOW - 1 }), "control")).toEqual({
        kind: "ask",
      });
      expect(decideTerminalAccess(subject({ refusedUntil: NOW }), "control")).toEqual({
        kind: "ask",
      });
    });

    it("asks without any earlier answer", () => {
      expect(decideTerminalAccess(subject(), "control")).toEqual({ kind: "ask" });
    });
  });
});

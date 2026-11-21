import type { TerminalRef } from "@ryco/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vite-plus/test";

import type { TerminalSessionInspection } from "../Services/Manager.ts";
import { MAX_MIRRORS, MIRROR_IDLE_MS, makeAgentTerminals } from "./AgentTerminals.ts";

const inspection = (ref: TerminalRef): TerminalSessionInspection => ({
  snapshot: {
    threadId: ref.threadId,
    terminalId: ref.terminalId,
    cwd: "/repo",
    worktreePath: null,
    status: "running",
    pid: 4242,
    history: "$ ",
    exitCode: null,
    exitSignal: null,
    updatedAt: "2026-11-21T00:00:00.000Z",
  },
  hasRunningSubprocess: true,
  cols: 120,
  rows: 30,
});

const fakeTerminals = {
  subscribe: () => Effect.succeed(() => undefined),
  inspect: (ref: TerminalRef) => Effect.succeed(Option.some(inspection(ref))),
};

describe("AgentTerminals mirror eviction", () => {
  it("drops a mirror the agent stopped using, also while its command runs", async () => {
    let clock = 1_000;
    const rt = await Effect.runPromise(
      makeAgentTerminals({ terminals: fakeTerminals, now: () => clock }),
    );
    try {
      const busy = { threadId: "t", terminalId: "agent-1" };
      const tracked = Option.getOrThrow(await Effect.runPromise(rt.track(busy)));
      rt.beginExecution(tracked, "npm run dev");
      expect(rt.find(busy)).toBeDefined();

      clock += MIRROR_IDLE_MS + 1;
      // Any use sweeps (the timer does too, every minute).
      await Effect.runPromise(rt.track({ threadId: "t", terminalId: "agent-2" }));
      expect(rt.find(busy)).toBeUndefined();
      expect(rt.mirrorCount()).toBe(1);

      // The next call rebuilds it from the history.
      expect(Option.isSome(await Effect.runPromise(rt.track(busy)))).toBe(true);
    } finally {
      rt.close();
    }
  });

  it(`keeps at most ${MAX_MIRRORS} mirrors, the least recently used go first`, async () => {
    let clock = 1_000;
    const rt = await Effect.runPromise(
      makeAgentTerminals({ terminals: fakeTerminals, now: () => clock }),
    );
    try {
      for (let index = 1; index <= MAX_MIRRORS + 2; index += 1) {
        clock += 10;
        await Effect.runPromise(rt.track({ threadId: "t", terminalId: `agent-${index}` }));
      }
      expect(rt.mirrorCount()).toBe(MAX_MIRRORS);
      expect(rt.find({ threadId: "t", terminalId: "agent-1" })).toBeUndefined();
      expect(rt.find({ threadId: "t", terminalId: `agent-${MAX_MIRRORS + 2}` })).toBeDefined();
    } finally {
      rt.close();
    }
  });
});

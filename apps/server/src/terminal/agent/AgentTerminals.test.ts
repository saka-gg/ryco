import type { TerminalRef } from "@ryco/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vite-plus/test";

import type { TerminalSessionInspection } from "../Services/Manager.ts";
import type { TerminalAgentOutput } from "../Services/Manager.ts";
import {
  MAX_MIRRORS,
  MIRROR_IDLE_MS,
  MirrorLimitError,
  makeAgentTerminals,
} from "./AgentTerminals.ts";

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

/** A terminal whose output arrives in numbered chunks, with the manager's history reads. */
function fakeShell(markNonce: string | null = null) {
  const chunks: Array<{ readonly sequence: number; readonly data: string }> = [];
  const listeners = new Set<(output: TerminalAgentOutput) => void>();
  let sequence = 0;
  const ref = { threadId: "t", terminalId: "agent-1" };
  const history = () => chunks.map((chunk) => chunk.data).join("");
  const terminals = {
    subscribe: () => Effect.succeed(() => undefined),
    inspect: () =>
      Effect.succeed(
        Option.some({
          ...inspection(ref),
          ...(markNonce === null ? {} : { markNonce }),
          snapshot: {
            ...inspection(ref).snapshot,
            history: history(),
            cursor: { generation: "g", sequence },
          },
        }),
      ),
    historySince: (_ref: TerminalRef, since: number) =>
      Effect.succeed(
        Option.some(
          chunks
            .filter((chunk) => chunk.sequence > since)
            .map((chunk) => chunk.data)
            .join(""),
        ),
      ),
    subscribeAgentOutput: (listener: (output: TerminalAgentOutput) => void) =>
      Effect.sync(() => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
  };
  const print = (data: string) => {
    sequence += 1;
    chunks.push({ sequence, data });
    for (const listener of listeners) {
      listener({ ...ref, data, cursor: { generation: "g", sequence }, markNonce });
    }
  };
  return { ref, terminals, print };
}

describe("AgentTerminals after a mirror rebuild", () => {
  it("keeps each thread's read position: new output is only what came after it", async () => {
    let clock = 1_000;
    const shell = fakeShell();
    shell.print("old line 1\r\nold line 2\r\n");
    const rt = await Effect.runPromise(
      makeAgentTerminals({ terminals: shell.terminals, now: () => clock }),
    );
    try {
      const first = Option.getOrThrow(await Effect.runPromise(rt.track(shell.ref)));
      rt.readNew(first, "thread-a");
      shell.print("seen before the drop\r\n");
      await Effect.runPromise(rt.track(shell.ref));
      expect(rt.readNew(first, "thread-a").lines).toEqual(["seen before the drop"]);

      // Unused for a while: the mirror is dropped while output goes on.
      clock += MIRROR_IDLE_MS + 1;
      await Effect.runPromise(rt.track({ threadId: "t", terminalId: "agent-2" }));
      expect(rt.find(shell.ref)).toBeUndefined();
      shell.print("while nobody watched\r\n");

      const rebuilt = Option.getOrThrow(await Effect.runPromise(rt.track(shell.ref)));
      const fresh = rt.readNew(rebuilt, "thread-a");
      expect(fresh.lines).toEqual(["while nobody watched"]);
      expect(fresh.startLost).toBe(false);
    } finally {
      rt.close();
    }
  });

  it("keeps the agent's command, its line and its output across the rebuild", async () => {
    let clock = 1_000;
    const shell = fakeShell();
    shell.print("$ ");
    const rt = await Effect.runPromise(
      makeAgentTerminals({ terminals: shell.terminals, now: () => clock }),
    );
    try {
      const t = Option.getOrThrow(await Effect.runPromise(rt.track(shell.ref)));
      rt.beginExecution(t, "npm test");
      shell.print("npm test\r\nrunning 1\r\n");
      clock += MIRROR_IDLE_MS + 1;
      await Effect.runPromise(rt.track({ threadId: "t", terminalId: "agent-2" }));
      shell.print("running 2\r\n");

      const rebuilt = Option.getOrThrow(await Effect.runPromise(rt.track(shell.ref)));
      const current = rebuilt.current;
      expect(current?.commandLine).toBe("npm test");
      expect(current?.startedBy).toBe("agent");
      expect(rt.outputOf(rebuilt, current!).lines).toEqual(["npm test", "running 1", "running 2"]);
    } finally {
      rt.close();
    }
  });
});

describe("AgentTerminals command ends", () => {
  it("never ends the agent's command at the end of the command before it", async () => {
    const shell = fakeShell("n0nce");
    const mark = (kind: string) => `\u001b]133;${kind};ryco=n0nce\u0007`;
    shell.print(`${mark("A")}$ `);
    const rt = await Effect.runPromise(makeAgentTerminals({ terminals: shell.terminals }));
    try {
      const t = Option.getOrThrow(await Effect.runPromise(rt.track(shell.ref)));
      // The user's command starts (bash 5 prints C from PS0) ...
      shell.print(`echo theirs\r\n${mark("C")}theirs\r\n`);
      await t.mirror.flush();
      const agents = rt.beginExecution(t, "echo mine");
      // ... and ends only after the agent's command began.
      shell.print(`${mark("D;0")}${mark("A")}$ `);
      await t.mirror.flush();
      expect(agents.ended).toBe(false);

      shell.print(`echo mine\r\n${mark("C")}mine\r\n${mark("D;3")}${mark("A")}$ `);
      await t.mirror.flush();
      expect(agents.ended).toBe(true);
      expect(agents.exitCode).toBe(3);
    } finally {
      rt.close();
    }
  });
});

describe("AgentTerminals pins", () => {
  it("never drops a mirror a wait or hand-off holds, and says which hold the limit", async () => {
    let clock = 1_000;
    const rt = await Effect.runPromise(
      makeAgentTerminals({ terminals: fakeTerminals, now: () => clock }),
    );
    try {
      const releases: Array<() => void> = [];
      for (let index = 1; index <= MAX_MIRRORS; index += 1) {
        const ref = { threadId: "t", terminalId: `agent-${index}` };
        await Effect.runPromise(rt.track(ref));
        releases.push(rt.pin(ref));
      }
      clock += MIRROR_IDLE_MS + 1;
      const refused = await Effect.runPromise(
        Effect.flip(rt.track({ threadId: "t", terminalId: "agent-99" })),
      );
      expect(refused).toBeInstanceOf(MirrorLimitError);
      expect(refused.held).toContain("agent-1");
      expect(rt.find({ threadId: "t", terminalId: "agent-1" })).toBeDefined();

      releases[0]!();
      expect(
        Option.isSome(await Effect.runPromise(rt.track({ threadId: "t", terminalId: "agent-99" }))),
      ).toBe(true);
      expect(rt.find({ threadId: "t", terminalId: "agent-1" })).toBeUndefined();
    } finally {
      rt.close();
    }
  });
});

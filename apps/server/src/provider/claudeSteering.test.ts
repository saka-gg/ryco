import { describe, expect, it } from "vitest";
import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

import {
  CLAUDE_CLI_CAPABILITY_INTERRUPT_CANCEL_QUEUED,
  CLAUDE_CLI_CAPABILITY_INTERRUPT_RECEIPT,
  claudeEchoNamesTurn,
  claudeEchoedPromptUuids,
  claudeResultBelongsToTurn,
  classifyClaudeResultKind,
  decideClaudeStop,
  decideClaudeTurnClose,
  decideClaudeTurnResult,
  isClaudeApiErrorReply,
  isClaudeRootTurnFrame,
  parseClaudeCliCapabilities,
  readClaudeInterruptReceipt,
  rememberDiscardedSteer,
  type ClaudeResultKind,
  type ClaudeStopDecisionInput,
  type ClaudeTurnCloseInput,
} from "./claudeSteering.ts";

const P = "prompt-uuid";
const S = "steer-uuid";
const S2 = "steer-uuid-2";

const frame = (value: Record<string, unknown>) =>
  ({ uuid: "frame", session_id: "sdk-session", ...value }) as unknown as SDKMessage;
const result = (value: Record<string, unknown>) =>
  frame({ type: "result", ...value }) as unknown as SDKResultMessage;

const API_ERROR_SUCCESS = result({
  subtype: "success",
  is_error: true,
  result: "API Error: 529 Overloaded",
  terminal_reason: "api_error",
  api_error_status: 529,
});

describe("decideClaudeTurnResult", () => {
  const decide = (input: {
    readonly steers?: ReadonlyArray<string>;
    readonly settled?: ReadonlyArray<string>;
    readonly kind: ClaudeResultKind;
    readonly echoed?: ReadonlyArray<string>;
    readonly count?: number;
    readonly interruptRequested?: boolean;
  }) =>
    decideClaudeTurnResult({
      kind: input.kind,
      echoedPromptUuids: input.echoed ?? [P],
      queuedTurnCount: input.count,
      steerPromptUuids: new Set(input.steers ?? []),
      settledSteerPromptUuids: new Set(input.settled ?? []),
      interruptRequested: input.interruptRequested ?? false,
    });

  it.each([
    { row: 1, input: { kind: "abort", count: 1 }, decision: "complete" },
    { row: 2, input: { steers: [S], kind: "abort", count: 1 }, decision: "await-steer" },
    {
      row: 3,
      input: { steers: [S], kind: "abort", count: 0 },
      decision: "complete",
      abortedBySteer: true,
    },
    { row: 4, input: { steers: [S], kind: "abort" }, decision: "complete", abortedBySteer: true },
    { row: 5, input: { steers: [S], settled: [S], kind: "abort", count: 1 }, decision: "complete" },
    { row: 7, input: { steers: [S], kind: "success", count: 1 }, decision: "await-steer" },
    {
      row: 8,
      input: { steers: [S], kind: "failure", count: 1 },
      decision: "complete",
      discardUnsettled: true,
    },
    {
      row: 9,
      input: { steers: [S], kind: "abort", count: 1, interruptRequested: true },
      decision: "complete",
      discardUnsettled: true,
    },
    {
      row: 10,
      input: { steers: [S, S2], settled: [S], kind: "abort", count: 1 },
      decision: "await-steer",
    },
    { row: 11, input: { steers: [S], kind: "success", count: 0 }, decision: "complete" },
    {
      row: 12,
      input: { steers: [S], kind: "success", interruptRequested: true },
      decision: "complete",
      discardUnsettled: true,
    },
    { row: 13, input: { kind: "abort", interruptRequested: true }, decision: "complete" },
  ] as const)(
    "row $row → $decision",
    ({
      input,
      decision,
      ...flags
    }: {
      readonly input: Parameters<typeof decide>[0];
      readonly decision: string;
      readonly discardUnsettled?: boolean;
      readonly abortedBySteer?: boolean;
    }) => {
      const result = decide(input);
      expect(result.decision).toBe(decision);
      expect(result.discardUnsettled).toBe(flags.discardUnsettled ?? false);
      expect(result.abortedBySteer).toBe(flags.abortedBySteer ?? false);
    },
  );

  it("row 8 with the SDK's API-error shape: the steer is dropped, the turn completes", () => {
    const decision = decide({
      steers: [S],
      kind: classifyClaudeResultKind(API_ERROR_SUCCESS),
      count: 1,
    });
    expect(decision.decision).toBe("complete");
    expect(decision.discardUnsettled).toBe(true);
    expect(decision.abortedBySteer).toBe(false);
  });

  it("row 6: a folded steer settles and the turn completes", () => {
    expect(decide({ steers: [S], kind: "success", echoed: [P, S] })).toEqual({
      decision: "complete",
      newlySettled: [S],
      unsettled: [],
      discardUnsettled: false,
      abortedBySteer: false,
    });
  });

  it("reports settled and unsettled steers separately", () => {
    expect(decide({ steers: [S, S2], kind: "abort", echoed: [S], count: 1 })).toEqual({
      decision: "await-steer",
      newlySettled: [S],
      unsettled: [S2],
      discardUnsettled: false,
      abortedBySteer: false,
    });
  });
});

describe("classifyClaudeResultKind", () => {
  it("treats an aborted_tools terminal reason as an abort even without abort text", () => {
    expect(
      classifyClaudeResultKind(
        result({
          subtype: "error_during_execution",
          is_error: true,
          errors: ["Tool execution stopped"],
          terminal_reason: "aborted_tools",
        }),
      ),
    ).toBe("abort");
  });

  it("falls back to the abort text when the terminal reason is absent", () => {
    expect(
      classifyClaudeResultKind(
        result({
          subtype: "error_during_execution",
          is_error: false,
          errors: ["Request was aborted."],
        }),
      ),
    ).toBe("abort");
  });

  it("classifies a success flagged as an error as a failure", () => {
    expect(classifyClaudeResultKind(result({ subtype: "success", is_error: true }))).toBe(
      "failure",
    );
    expect(classifyClaudeResultKind(result({ subtype: "success", is_error: false }))).toBe(
      "success",
    );
  });

  it("classifies an API error the SDK reports as a flagged success as a failure", () => {
    // How a request that failed at the API after its retries ends (sdk.d.ts SDKResultMessage).
    expect(classifyClaudeResultKind(API_ERROR_SUCCESS)).toBe("failure");
  });

  it("classifies an api_error as a failure", () => {
    expect(
      classifyClaudeResultKind(
        result({
          subtype: "error_during_execution",
          is_error: true,
          errors: ["Overloaded"],
          terminal_reason: "api_error",
        }),
      ),
    ).toBe("failure");
  });
});

describe("decideClaudeTurnClose", () => {
  const close = (input: Partial<ClaudeTurnCloseInput>) =>
    decideClaudeTurnClose({
      resultStatus: "completed",
      decision: { discardUnsettled: false, abortedBySteer: false },
      interruptRequested: false,
      echoedPromptUuids: [P],
      promptUuid: P,
      steerPromptUuids: new Set([S]),
      foldedIntoDiscardedCliTurn: false,
      ...input,
    });

  it("follows the result by default", () => {
    expect(close({})).toEqual({ status: "completed", cause: "result" });
    expect(close({ resultStatus: "failed" })).toEqual({ status: "failed", cause: "result" });
    expect(close({ resultStatus: "interrupted", interruptRequested: true })).toEqual({
      status: "interrupted",
      cause: "result",
    });
  });

  it("never reports a steer's abort as a Stop", () => {
    expect(
      close({
        resultStatus: "interrupted",
        decision: { discardUnsettled: false, abortedBySteer: true },
      }),
    ).toEqual({ status: "completed", cause: "aborted-by-steer" });
  });

  it("reports a failure that dropped a steer as a failure, even when flagged as success", () => {
    const decision = { discardUnsettled: true, abortedBySteer: false };
    expect(close({ decision })).toEqual({
      status: "failed",
      cause: "failed-segment-dropped-steers",
    });
    expect(close({ decision, resultStatus: "failed" })).toEqual({
      status: "failed",
      cause: "result",
    });
    // Stop dropped the steer, and the prompt's own result raced it: unchanged.
    expect(close({ decision, interruptRequested: true })).toEqual({
      status: "completed",
      cause: "result",
    });
  });

  it("ends a stopped turn as interrupted when a steer's CLI turn closes it", () => {
    expect(close({ interruptRequested: true, echoedPromptUuids: [S] })).toEqual({
      status: "interrupted",
      cause: "stopped",
    });
    // A steerable provider turn has no prompt uuid.
    expect(
      close({ interruptRequested: true, echoedPromptUuids: [S], promptUuid: undefined }),
    ).toEqual({ status: "interrupted", cause: "stopped" });
    // The prompt's own result, or a steer folded into it, keeps its status.
    expect(close({ interruptRequested: true, echoedPromptUuids: [P, S] })).toEqual({
      status: "completed",
      cause: "result",
    });
    expect(close({ echoedPromptUuids: [S] })).toEqual({ status: "completed", cause: "result" });
  });

  it("fails a turn folded into a dropped CLI turn unless it was stopped", () => {
    for (const resultStatus of ["completed", "interrupted"] as const) {
      expect(
        close({
          resultStatus,
          echoedPromptUuids: ["discarded", P],
          foldedIntoDiscardedCliTurn: true,
        }),
      ).toEqual({ status: "failed", cause: "folded-into-discarded-cli-turn" });
      expect(
        close({
          resultStatus,
          echoedPromptUuids: ["discarded", P],
          foldedIntoDiscardedCliTurn: true,
          interruptRequested: true,
        }),
      ).toEqual({ status: "interrupted", cause: "stopped" });
    }
  });
});

describe("claudeEchoedPromptUuids", () => {
  it("prefers the uuid list, falls back to the single uuid, and ignores other frames", () => {
    expect(claudeEchoedPromptUuids(result({ user_message_uuids: [P, S] }))).toEqual([P, S]);
    expect(
      claudeEchoedPromptUuids(frame({ type: "stream_event", user_message_uuid: S, event: {} })),
    ).toEqual([S]);
    expect(
      claudeEchoedPromptUuids(result({ user_message_uuids: [], user_message_uuid: P })),
    ).toEqual([P]);
    expect(claudeEchoedPromptUuids(result({}))).toEqual([]);
    expect(
      claudeEchoedPromptUuids(frame({ type: "system", subtype: "status", user_message_uuid: P })),
    ).toEqual([]);
  });

  it("reads a root assistant reply's echo, which a CLI turn that streamed nothing carries", () => {
    expect(
      claudeEchoedPromptUuids(
        frame({ type: "assistant", parent_tool_use_id: null, user_message_uuids: [S] }),
      ),
    ).toEqual([S]);
    expect(
      claudeEchoedPromptUuids(
        frame({ type: "assistant", parent_tool_use_id: "tool-1", user_message_uuid: P }),
      ),
    ).toEqual([]);
  });
});

describe("claudeEchoNamesTurn", () => {
  it("matches the prompt or a steer, and nothing for a turn without a prompt uuid", () => {
    const steers = new Set([S]);
    expect(claudeEchoNamesTurn({ echoed: [S2, P], promptUuid: P, steerPromptUuids: steers })).toBe(
      true,
    );
    expect(
      claudeEchoNamesTurn({ echoed: [S], promptUuid: undefined, steerPromptUuids: steers }),
    ).toBe(true);
    expect(
      claudeEchoNamesTurn({ echoed: [S2], promptUuid: undefined, steerPromptUuids: steers }),
    ).toBe(false);
    expect(claudeEchoNamesTurn({ echoed: [], promptUuid: P, steerPromptUuids: steers })).toBe(
      false,
    );
  });
});

describe("isClaudeApiErrorReply", () => {
  it("matches synthetic API-error replies except the continuable output-token limit", () => {
    expect(isClaudeApiErrorReply(frame({ type: "assistant", error: "server_error" }))).toBe(true);
    expect(isClaudeApiErrorReply(frame({ type: "assistant", error: "rate_limit" }))).toBe(true);
    expect(isClaudeApiErrorReply(frame({ type: "assistant", error: "max_output_tokens" }))).toBe(
      false,
    );
    expect(isClaudeApiErrorReply(frame({ type: "assistant" }))).toBe(false);
    expect(isClaudeApiErrorReply(result({ error: "server_error" }))).toBe(false);
  });
});

describe("claudeResultBelongsToTurn", () => {
  const belongs = (echoed: ReadonlyArray<string>, origin?: { readonly kind: string }) =>
    claudeResultBelongsToTurn({
      echoed,
      origin,
      promptUuid: P,
      steerPromptUuids: new Set([S]),
    });

  it("accepts a steer-only echo and rejects a foreign one", () => {
    expect(belongs([S])).toBe(true);
    expect(belongs([P])).toBe(true);
    expect(belongs(["foreign"])).toBe(false);
  });

  it("without an echo, rejects only non-human origins", () => {
    expect(belongs([], { kind: "task-notification" })).toBe(false);
    expect(belongs([], { kind: "human" })).toBe(true);
    expect(belongs([])).toBe(true);
  });
});

describe("decideClaudeStop", () => {
  const stop = (input: Partial<ClaudeStopDecisionInput>) =>
    decideClaudeStop({
      unsettledSteers: [],
      startedSteers: new Set(),
      promptUuid: P,
      sealedSegmentCount: 0,
      awaitingSteerContinuation: false,
      receipt: undefined,
      ...input,
    });

  it("S1: no steers never force-closes", () => {
    expect(stop({ receipt: { stillQueued: [], cancelled: undefined } })).toEqual({
      forceClose: false,
      discard: [],
      release: [],
    });
    expect(stop({})).toEqual({ forceClose: false, discard: [], release: [] });
  });

  it("S2: a cancelled steer after the prompt segment force-closes and discards nothing", () => {
    expect(
      stop({
        unsettledSteers: [S],
        sealedSegmentCount: 1,
        awaitingSteerContinuation: true,
        receipt: { stillQueued: [], cancelled: [S] },
      }),
    ).toEqual({ forceClose: true, discard: [], release: [S] });
  });

  it("S3: a still-queued steer after the prompt segment force-closes and is discarded", () => {
    expect(
      stop({
        unsettledSteers: [S],
        sealedSegmentCount: 1,
        awaitingSteerContinuation: true,
        receipt: { stillQueued: [S], cancelled: undefined },
      }),
    ).toEqual({ forceClose: true, discard: [S], release: [] });
  });

  it("S4: a still-streaming prompt is not force-closed", () => {
    expect(
      stop({ unsettledSteers: [S], receipt: { stillQueued: [S], cancelled: undefined } }),
    ).toEqual({ forceClose: false, discard: [S], release: [] });
  });

  it("S5: a steer in transit counts as running", () => {
    expect(
      stop({
        unsettledSteers: [S],
        sealedSegmentCount: 1,
        awaitingSteerContinuation: true,
        receipt: { stillQueued: [], cancelled: undefined },
      }),
    ).toEqual({ forceClose: false, discard: [S], release: [] });
  });

  it("S3/S5: a steer that already streamed counts as running despite a stale receipt", () => {
    expect(
      stop({
        unsettledSteers: [S],
        startedSteers: new Set([S]),
        sealedSegmentCount: 1,
        receipt: { stillQueued: [S], cancelled: undefined },
      }),
    ).toEqual({ forceClose: false, discard: [S], release: [] });
    expect(
      stop({
        unsettledSteers: [S],
        startedSteers: new Set([S]),
        sealedSegmentCount: 1,
        receipt: { stillQueued: [], cancelled: [S] },
      }),
    ).toEqual({ forceClose: false, discard: [S], release: [] });
  });

  it("S6: waiting cleared by a wake, steer queued, prompt done → force-close", () => {
    expect(
      stop({
        unsettledSteers: [S],
        sealedSegmentCount: 1,
        awaitingSteerContinuation: false,
        receipt: { stillQueued: [S], cancelled: undefined },
      }),
    ).toEqual({ forceClose: true, discard: [S], release: [] });
  });

  it("S7: a cancelled prompt counts as done", () => {
    expect(
      stop({
        unsettledSteers: [S],
        sealedSegmentCount: 0,
        receipt: { stillQueued: [], cancelled: [P, S] },
      }),
    ).toEqual({ forceClose: true, discard: [], release: [S] });
  });

  it("S4 with cancel_queued: a cancelled steer is released even while the prompt streams", () => {
    expect(
      stop({ unsettledSteers: [S, S2], receipt: { stillQueued: [], cancelled: [S] } }),
    ).toEqual({ forceClose: false, discard: [S2], release: [S] });
  });

  it("S8: without a receipt, force-close only while waiting and discard every steer", () => {
    expect(
      stop({ unsettledSteers: [S, S2], awaitingSteerContinuation: true, sealedSegmentCount: 1 }),
    ).toEqual({ forceClose: true, discard: [S, S2], release: [] });
    expect(stop({ unsettledSteers: [S], awaitingSteerContinuation: false })).toEqual({
      forceClose: false,
      discard: [S],
      release: [],
    });
  });
});

describe("readClaudeInterruptReceipt", () => {
  it("parses valid receipts and rejects garbage", () => {
    expect(readClaudeInterruptReceipt(undefined)).toBeUndefined();
    expect(readClaudeInterruptReceipt({})).toBeUndefined();
    expect(readClaudeInterruptReceipt({ still_queued: [1] })).toBeUndefined();
    expect(readClaudeInterruptReceipt("receipt")).toBeUndefined();
    expect(readClaudeInterruptReceipt({ still_queued: [S] })).toEqual({
      stillQueued: [S],
      cancelled: undefined,
    });
    expect(readClaudeInterruptReceipt({ still_queued: [], cancelled: [S] })).toEqual({
      stillQueued: [],
      cancelled: [S],
    });
    expect(readClaudeInterruptReceipt({ still_queued: [], cancelled: "x" })).toEqual({
      stillQueued: [],
      cancelled: undefined,
    });
  });
});

describe("rememberDiscardedSteer", () => {
  it("evicts the oldest uuid at the cap", () => {
    const set = new Set<string>();
    rememberDiscardedSteer(set, "a", 2);
    rememberDiscardedSteer(set, "b", 2);
    rememberDiscardedSteer(set, "a", 2);
    rememberDiscardedSteer(set, "c", 2);
    expect([...set]).toEqual(["b", "c"]);
  });
});

describe("parseClaudeCliCapabilities", () => {
  it("reads the init capabilities and defaults to none", () => {
    expect(
      parseClaudeCliCapabilities(
        frame({
          type: "system",
          subtype: "init",
          capabilities: [
            CLAUDE_CLI_CAPABILITY_INTERRUPT_RECEIPT,
            CLAUDE_CLI_CAPABILITY_INTERRUPT_CANCEL_QUEUED,
            7,
          ],
        }),
      ),
    ).toEqual(
      new Set([
        CLAUDE_CLI_CAPABILITY_INTERRUPT_RECEIPT,
        CLAUDE_CLI_CAPABILITY_INTERRUPT_CANCEL_QUEUED,
      ]),
    );
    expect(parseClaudeCliCapabilities(frame({ type: "system", subtype: "init" })).size).toBe(0);
  });
});

describe("isClaudeRootTurnFrame", () => {
  it("matches root model frames only", () => {
    expect(isClaudeRootTurnFrame(frame({ type: "stream_event", parent_tool_use_id: null }))).toBe(
      true,
    );
    expect(isClaudeRootTurnFrame(frame({ type: "assistant" }))).toBe(true);
    expect(isClaudeRootTurnFrame(frame({ type: "user", parent_tool_use_id: "tool-1" }))).toBe(
      false,
    );
    expect(isClaudeRootTurnFrame(frame({ type: "system", subtype: "status" }))).toBe(false);
    expect(isClaudeRootTurnFrame(frame({ type: "system", subtype: "api_retry" }))).toBe(false);
  });

  it("skips keep-alive pings, which precede the echo-bearing stream event", () => {
    expect(
      isClaudeRootTurnFrame(
        frame({ type: "stream_event", parent_tool_use_id: null, event: { type: "ping" } }),
      ),
    ).toBe(false);
    expect(
      isClaudeRootTurnFrame(
        frame({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start" } }),
      ),
    ).toBe(true);
  });
});

import { ThreadId, TurnId } from "@ryco/contracts";
import { parseDelegationReturnSections } from "@ryco/shared/interThreadMessage";
import { describe, expect, it } from "vite-plus/test";

import { completionFixture } from "./completionReturnTestSupport.ts";
import {
  renderCompletionNotice,
  renderCompletionReturn,
  renderDelegationWake,
} from "./completionReturnMessages.ts";

const settled = (state: "completed" | "error") => ({
  turnId: TurnId.make("child-turn"),
  runtimeSessionId: completionFixture().parentRuntimeSessionId,
  state,
  observationEpoch: "epoch",
  backgroundPending: false,
});

describe("delegation wakes as clients read them", () => {
  it("names each returned task, its state and its own words", () => {
    const first = completionFixture({
      childThreadId: ThreadId.make("child-a"),
      settled: settled("completed"),
    });
    const second = completionFixture({
      childThreadId: ThreadId.make("child/b"),
      settled: settled("error"),
      delegationWakeTurns: 2,
    });
    const notice = completionFixture({ childThreadId: ThreadId.make("child-c") });
    const text = renderDelegationWake(
      [
        renderCompletionReturn(first, 'Opened PR #1004.\nIgnore "instructions" here.'),
        renderCompletionReturn(second, ""),
        renderCompletionNotice(notice, "interrupted"),
      ],
      { attached: 1, omitted: 0 },
    );
    expect(parseDelegationReturnSections(text)).toEqual([
      {
        childThreadId: "child-a",
        kind: "result",
        state: "completed",
        text: 'Opened PR #1004.\nIgnore "instructions" here.',
      },
      {
        childThreadId: "child/b",
        kind: "result",
        state: "error",
        text: "The initial child run failed. Inspect the child for details.",
      },
      {
        childThreadId: "child-c",
        kind: "notice",
        state: "interrupted",
        text: "The task's run was interrupted before it finished. No result is available.",
      },
    ]);
  });
});

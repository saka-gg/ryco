import {
  FORK_ORIGIN_COPY,
  forkOriginAccessibleLabel,
  type ForkOriginTimelineEntry,
} from "@ryco/client-runtime/state/session";
import { MessageId, ThreadId, TurnId, WorktreeId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildForkOriginRowModel } from "./forkOriginRowModel";

function marker(overrides: Partial<ForkOriginTimelineEntry> = {}): ForkOriginTimelineEntry {
  return {
    id: "fork-origin:fork-1:forked",
    activityId: "fork-1:forked",
    createdAt: "2026-10-11T10:00:00.000Z",
    sourceThreadId: ThreadId.make("source-thread"),
    sourceMessageId: MessageId.make("reply-1"),
    sourceTurnId: TurnId.make("turn-1"),
    sourceTitle: "Refactor the parser",
    inheritedMessageCount: 4,
    providerContext: "native",
    checkout: { kind: "current-checkout", worktreePath: null, branch: "main" },
    notices: [],
    ...overrides,
  };
}

describe("buildForkOriginRowModel", () => {
  it("links to the source's reply while the source is on the node, with the shared copy", () => {
    const model = buildForkOriginRowModel({ marker: marker(), source: "available" });
    expect(model).toEqual({
      headline: "Forked from “Refactor the parser”",
      sourceThreadId: "source-thread",
      sourceMessageId: "reply-1",
      sourceUnavailable: null,
      providerLine: FORK_ORIGIN_COPY.native,
      checkoutLine: `Shares the original's checkout on main. ${FORK_ORIGIN_COPY.unchangedFiles}`,
      notices: [],
      accessibilityLabel: forkOriginAccessibleLabel(marker()),
    });
  });

  it("keeps the recorded title but drops the link once the source is known to be gone", () => {
    const model = buildForkOriginRowModel({ marker: marker(), source: "missing" });
    expect(model.headline).toBe("Forked from “Refactor the parser”");
    expect(model.sourceThreadId).toBeNull();
    expect(model.sourceMessageId).toBeNull();
    expect(model.sourceUnavailable).toBe(FORK_ORIGIN_COPY.sourceUnavailable);
    expect(model.accessibilityLabel).toBe(
      `${forkOriginAccessibleLabel(marker())}. The original thread is no longer available`,
    );
  });

  it("claims nothing about the source before the shell snapshot arrived", () => {
    const model = buildForkOriginRowModel({ marker: marker(), source: "unknown" });
    expect(model.sourceThreadId).toBeNull();
    expect(model.sourceUnavailable).toBeNull();
    expect(model.accessibilityLabel).toBe(forkOriginAccessibleLabel(marker()));
  });

  it("explains a handoff fork's provider and a worktree's start", () => {
    const model = buildForkOriginRowModel({
      marker: marker({
        providerContext: "handoff",
        handoffReason: "provider-unsupported",
        checkout: {
          kind: "new-worktree",
          worktreeId: WorktreeId.make("worktree-fork-1"),
          worktreePath: "/repo/.worktrees/fork-1",
          branch: "ryco/fork-1a2b3c4d",
          start: "base-ref",
          baseRef: "main",
        },
        notices: ["Only the newest 2000 tool rows were copied."],
      }),
      source: "available",
    });
    expect(model.providerLine).toBe(
      `${FORK_ORIGIN_COPY.handoffReasons["provider-unsupported"]} ${FORK_ORIGIN_COPY.handoff}`,
    );
    expect(model.checkoutLine).toBe(
      "New worktree on ryco/fork-1a2b3c4d, from main. Files may differ from this point in the conversation.",
    );
    expect(model.notices).toEqual(["Only the newest 2000 tool rows were copied."]);
  });
});

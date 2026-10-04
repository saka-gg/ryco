import { describe, expect, it } from "vite-plus/test";

import {
  makeQueueAppState,
  queueRef,
  turnStartFailed,
  type ThreadFixture,
} from "../../../test/queueThreadFixtures.ts";
import {
  appendAcknowledgedCauseKeys,
  createInterruptQueueHold,
  deriveQueueFailureCauses,
  describeQueueHold,
  MAX_ACKNOWLEDGED_CAUSE_KEYS,
  mergeQueueHold,
  partitionNewQueueFailureCauses,
  releaseQueueHoldKeys,
  type QueueFailureCause,
} from "./hold.ts";
import { readQueueThreadView } from "./threadView.ts";

const NOW = "2026-10-01T12:00:00.000Z";
const NONE: ReadonlySet<string> = new Set();

function causesFor(fixture: Omit<ThreadFixture, "id">, dispatched: ReadonlySet<string> = NONE) {
  const view = readQueueThreadView(makeQueueAppState([{ id: "t", ...fixture }]), queueRef("t"))!;
  return deriveQueueFailureCauses(view, dispatched);
}

describe("deriveQueueFailureCauses", () => {
  it("raises one stable error cause that repeated session-sets and a later stop cannot re-key", () => {
    const first = causesFor({
      session: { status: "error", lastError: "Rate limited", updatedAt: NOW },
      latestTurn: { turnId: "turn-1", state: "error" },
    });
    expect(first).toEqual([
      {
        reason: "error",
        causeKey: "error:turn-1:Rate limited",
        detail: "Rate limited",
        providerInstanceId: "codex",
      },
    ]);
    const repeated = causesFor({
      session: {
        status: "error",
        lastError: "Rate limited",
        updatedAt: "2026-10-01T12:05:00.000Z",
      },
      latestTurn: { turnId: "turn-1", state: "error" },
    });
    expect(repeated.map((cause) => cause.causeKey)).toEqual([first[0]!.causeKey]);
  });

  it.each(["running", "stopped", "ready"] as const)(
    "ignores a stale lastError while %s",
    (status) => {
      expect(
        causesFor({
          session: { status, lastError: "Old failure" },
          latestTurn: { turnId: "turn-1", state: "completed" },
        }),
      ).toEqual([]);
    },
  );

  it("raises an interrupt cause from the latest turn or the session", () => {
    expect(
      causesFor({
        session: { status: "ready" },
        latestTurn: { turnId: "turn-2", state: "interrupted" },
      }).map((cause) => cause.causeKey),
    ).toEqual(["interrupt:turn-2"]);
    expect(
      causesFor({ session: { status: "interrupted" } }).map((cause) => cause.causeKey),
    ).toEqual(["interrupt:session"]);
  });

  it("raises a start failure only for a message this client dispatched", () => {
    const fixture = {
      session: { status: "ready" as const },
      messageIds: [],
      activities: [
        turnStartFailed("activity-1", "mine", "Thread already has active turn"),
        turnStartFailed("activity-2", "someone-else"),
      ],
    };
    expect(causesFor(fixture)).toEqual([]);
    expect(causesFor(fixture, new Set(["mine"]))).toEqual([
      {
        reason: "error",
        causeKey: "start-failed:activity-1",
        detail: "Thread already has active turn",
        providerInstanceId: null,
      },
    ]);
  });
});

describe("partitionNewQueueFailureCauses", () => {
  const error: QueueFailureCause = {
    reason: "error",
    causeKey: "error:t:x",
    detail: "x",
    providerInstanceId: "claude",
  };
  const interrupt: QueueFailureCause = {
    reason: "interrupted",
    causeKey: "interrupt:t",
    detail: null,
    providerInstanceId: "claude",
  };

  it("exempts an error from another provider but never an interrupt", () => {
    expect(
      partitionNewQueueFailureCauses({
        causes: [error, interrupt],
        acknowledgedCauseKeys: [],
        hold: null,
        headProviderInstanceId: "codex",
      }),
    ).toEqual({ hold: [interrupt], exempt: [error] });
    expect(
      partitionNewQueueFailureCauses({
        causes: [error],
        acknowledgedCauseKeys: [],
        hold: null,
        headProviderInstanceId: "claude",
      }),
    ).toEqual({ hold: [error], exempt: [] });
  });

  it("skips acknowledged causes and causes the hold already covers", () => {
    expect(
      partitionNewQueueFailureCauses({
        causes: [error, interrupt],
        acknowledgedCauseKeys: [error.causeKey],
        hold: createInterruptQueueHold("t", NOW),
        headProviderInstanceId: null,
      }),
    ).toEqual({ hold: [], exempt: [] });
  });
});

describe("hold merge and release", () => {
  it("unions keys, keeps heldAt, and takes reason and detail from the higher rank", () => {
    const stop = createInterruptQueueHold("turn-1", NOW);
    const merged = mergeQueueHold(
      stop,
      { reason: "error", causeKeys: ["error:turn-1:boom"], detail: "boom" },
      "2026-10-01T13:00:00.000Z",
    );
    expect(merged).toEqual({
      reason: "error",
      detail: "boom",
      causeKeys: ["interrupt:turn-1", "error:turn-1:boom"],
      heldAt: NOW,
    });
    // A lower or equal rank keeps the existing reason.
    expect(
      mergeQueueHold(
        merged,
        { reason: "interrupted", causeKeys: ["interrupt:x"], detail: null },
        NOW,
      ).reason,
    ).toBe("error");
    expect(
      mergeQueueHold(merged, { reason: "error", causeKeys: ["error:y"], detail: "other" }, NOW)
        .detail,
    ).toBe("boom");
    expect(
      mergeQueueHold(merged, { reason: "limit", causeKeys: ["limit:z"], detail: "cap" }, NOW),
    ).toMatchObject({ reason: "limit", detail: "cap" });
  });

  it("releases the hold's own keys plus every current cause", () => {
    const hold = createInterruptQueueHold("turn-1", NOW);
    expect(
      releaseQueueHoldKeys(hold, [
        {
          reason: "error",
          causeKey: "error:turn-1:boom",
          detail: "boom",
          providerInstanceId: null,
        },
        {
          reason: "interrupted",
          causeKey: "interrupt:turn-1",
          detail: null,
          providerInstanceId: null,
        },
      ]),
    ).toEqual(["interrupt:turn-1", "error:turn-1:boom"]);
  });

  it("creates a user-scoped interrupt when no turn is active", () => {
    expect(createInterruptQueueHold(null, NOW).causeKeys).toEqual([`interrupt:user:${NOW}`]);
  });

  it("keeps the newest acknowledged keys", () => {
    const keys = Array.from({ length: MAX_ACKNOWLEDGED_CAUSE_KEYS + 3 }, (_, index) => `k${index}`);
    const next = appendAcknowledgedCauseKeys(undefined, keys);
    expect(next).toHaveLength(MAX_ACKNOWLEDGED_CAUSE_KEYS);
    expect(next.at(-1)).toBe(keys.at(-1));
    expect(next[0]).toBe("k3");
    expect(appendAcknowledgedCauseKeys(next, ["k5"])).toBe(next);
  });

  it("describes every reason with shared copy", () => {
    expect(describeQueueHold(createInterruptQueueHold("t", NOW))).toEqual({
      title: "Paused after Stop",
      detail: null,
    });
    expect(
      describeQueueHold({ reason: "error", detail: "boom", causeKeys: [], heldAt: NOW }),
    ).toEqual({ title: "Paused after an error", detail: "boom" });
    expect(
      describeQueueHold({ reason: "stalled", detail: null, causeKeys: [], heldAt: NOW }).title,
    ).toBe("Paused: the last queued message has not started");
  });
});

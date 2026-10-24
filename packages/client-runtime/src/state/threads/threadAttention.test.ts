import { describe, expect, it } from "vite-plus/test";
import {
  compareThreadAttention,
  resolveThreadAttentionReason,
  stepThreadAttention,
  type ThreadAttentionCandidate,
  type ThreadAttentionRow,
  type ThreadAttentionWalk,
} from "./threadAttention.ts";

function row(patch: Partial<ThreadAttentionRow> = {}): ThreadAttentionRow {
  return {
    state: "idle",
    attention: null,
    resting: false,
    unseen: false,
    delegated: false,
    ...patch,
  };
}

function candidate(
  key: string,
  patch: Partial<Omit<ThreadAttentionCandidate, "key">> = {},
): ThreadAttentionCandidate {
  return { key, reason: "completed", focusIndex: null, recencyMs: 0, ...patch };
}

const ordered = (candidates: ReadonlyArray<ThreadAttentionCandidate>) =>
  candidates.toSorted(compareThreadAttention).map((entry) => entry.key);

describe("resolveThreadAttentionReason", () => {
  it("names what a needs-input row waits on", () => {
    expect(resolveThreadAttentionReason(row({ state: "needs-input", attention: "approval" }))).toBe(
      "approval",
    );
    expect(resolveThreadAttentionReason(row({ state: "needs-input", attention: "input" }))).toBe(
      "input",
    );
    expect(resolveThreadAttentionReason(row({ state: "needs-input", attention: "plan" }))).toBe(
      "plan-ready",
    );
    expect(resolveThreadAttentionReason(row({ state: "needs-input" }))).toBe("input");
  });

  it("counts failures and completions only while unseen", () => {
    for (const state of ["error", "limited"] as const) {
      expect(resolveThreadAttentionReason(row({ state, unseen: true }))).toBe("failed");
      expect(resolveThreadAttentionReason(row({ state }))).toBeNull();
    }
    expect(resolveThreadAttentionReason(row({ unseen: true }))).toBe("completed");
    expect(resolveThreadAttentionReason(row())).toBeNull();
  });

  it("never counts running, uncertain, offline or settled rows", () => {
    for (const state of [
      "working",
      "connecting",
      "reconnecting",
      "delivery-unknown",
      "offline",
      "settled",
    ] as const) {
      expect(resolveThreadAttentionReason(row({ state, unseen: true }))).toBeNull();
    }
  });

  it("never counts a resting row, even one waiting on the user", () => {
    expect(
      resolveThreadAttentionReason(
        row({ state: "needs-input", attention: "approval", resting: true }),
      ),
    ).toBeNull();
    expect(resolveThreadAttentionReason(row({ unseen: true, resting: true }))).toBeNull();
  });

  it("counts a delegated child only for the requests it is blocked on", () => {
    const delegated = (patch: Partial<ThreadAttentionRow>) =>
      resolveThreadAttentionReason(row({ ...patch, delegated: true }));
    expect(delegated({ state: "needs-input", attention: "approval" })).toBe("approval");
    expect(delegated({ state: "needs-input", attention: "input" })).toBe("input");
    expect(delegated({ state: "needs-input", attention: "plan" })).toBeNull();
    expect(delegated({ state: "error", unseen: true })).toBeNull();
    expect(delegated({ state: "idle", unseen: true })).toBeNull();
  });
});

describe("compareThreadAttention", () => {
  it("puts waiting threads before unseen results, each in urgency order", () => {
    expect(
      ordered([
        candidate("completed", { reason: "completed", recencyMs: 5 }),
        candidate("failed", { reason: "failed", recencyMs: 4 }),
        candidate("plan", { reason: "plan-ready", recencyMs: 3 }),
        candidate("input", { reason: "input", recencyMs: 2 }),
        candidate("approval", { reason: "approval", recencyMs: 1 }),
      ]),
    ).toEqual(["approval", "input", "plan", "failed", "completed"]);
  });

  it("puts Focus rows first within a reason, in Focus order", () => {
    expect(
      ordered([
        candidate("newest", { recencyMs: 9 }),
        candidate("focus-second", { focusIndex: 1 }),
        candidate("focus-first", { focusIndex: 0 }),
        candidate("other-reason", { reason: "approval" }),
      ]),
    ).toEqual(["other-reason", "focus-first", "focus-second", "newest"]);
  });

  it("orders newest first, an unknown time last, then by key", () => {
    expect(
      ordered([
        candidate("unknown", { recencyMs: Number.NaN }),
        candidate("b", { recencyMs: 1 }),
        candidate("a", { recencyMs: 1 }),
        candidate("newest", { recencyMs: 2 }),
      ]),
    ).toEqual(["newest", "a", "b", "unknown"]);
  });
});

describe("stepThreadAttention", () => {
  const W1 = candidate("W1", { reason: "approval" });
  const W2 = candidate("W2", { reason: "input" });
  const U1 = candidate("U1", { recencyMs: 2 });
  const U2 = candidate("U2", { recencyMs: 1 });
  const all = [U2, W2, U1, W1];

  const step = (input: {
    readonly candidates?: ReadonlyArray<ThreadAttentionCandidate>;
    readonly currentKey: string | null;
    readonly direction?: "previous" | "next";
    readonly previous?: ThreadAttentionWalk | null;
  }) =>
    stepThreadAttention({
      candidates: input.candidates ?? all,
      currentKey: input.currentKey,
      direction: input.direction ?? "next",
      previous: input.previous ?? null,
    });

  it("starts at the most urgent thread, or the least urgent going back", () => {
    expect(step({ currentKey: null })).toEqual({
      orderedKeys: ["W1", "W2", "U1", "U2"],
      targetKey: "W1",
    });
    expect(step({ currentKey: "elsewhere" })?.targetKey).toBe("W1");
    expect(step({ currentKey: null, direction: "previous" })?.targetKey).toBe("U2");
  });

  it("steps through the order and wraps at either end", () => {
    expect(step({ currentKey: "W2" })?.targetKey).toBe("U1");
    expect(step({ currentKey: "U2" })?.targetKey).toBe("W1");
    expect(step({ currentKey: "U1", direction: "previous" })?.targetKey).toBe("W2");
    expect(step({ currentKey: "W1", direction: "previous" })?.targetKey).toBe("U2");
  });

  it("returns null when no other thread needs the user", () => {
    expect(step({ candidates: [], currentKey: null })).toBeNull();
    expect(step({ candidates: [W1], currentKey: "W1" })).toBeNull();
    expect(step({ candidates: [W1], currentKey: "W1", direction: "previous" })).toBeNull();
  });

  it("goes on past a visited result that is no longer unseen", () => {
    let walk: ThreadAttentionWalk | null = null;
    const visited: string[] = [];
    for (let press = 0; press < 3; press += 1) {
      walk = step({ currentKey: walk?.targetKey ?? null, previous: walk });
      visited.push(walk!.targetKey);
    }
    expect(visited).toEqual(["W1", "W2", "U1"]);
    // Opening U1 made it seen, so it left the order before this press.
    expect(step({ candidates: [W1, W2, U2], currentKey: "U1", previous: walk })?.targetKey).toBe(
      "U2",
    );
  });

  it("goes back past a visited result in the previous order", () => {
    const previous = step({ currentKey: "W2" })!;
    expect(previous.targetKey).toBe("U1");
    expect(
      step({ candidates: [W1, W2, U2], currentKey: "U1", direction: "previous", previous })
        ?.targetKey,
    ).toBe("W2");
  });

  it("wraps when nothing after the visited result still needs the user", () => {
    const previous = step({ currentKey: "U1" })!;
    expect(previous.targetKey).toBe("U2");
    expect(step({ candidates: [W1, W2, U1], currentKey: "U2", previous })?.targetKey).toBe("W1");
  });

  it("starts over when the open thread is not where the last press went", () => {
    const previous = step({ currentKey: "W2" })!;
    expect(step({ candidates: [W1, W2, U2], currentKey: "U9", previous })?.targetKey).toBe("W1");
  });

  it("reaches a thread that became urgent mid-walk once the walk wraps", () => {
    const previous = step({ currentKey: "U1" })!;
    const W0 = candidate("W0", { reason: "approval", recencyMs: 9 });
    const afterVisit = [W0, W1, W2, U1];
    const wrapped = step({ candidates: afterVisit, currentKey: "U2", previous })!;
    expect(wrapped.targetKey).toBe("W0");
    expect(step({ candidates: afterVisit, currentKey: "W0", previous: wrapped })?.targetKey).toBe(
      "W1",
    );
  });
});

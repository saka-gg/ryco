import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  formatInboxAge,
  formatInboxDayTime,
  inboxAttentionDetail,
  inboxGlyphHint,
  inboxGlyphLabel,
  inboxTimeHint,
  resolveInboxGlyph,
  resolveInboxStateLine,
} from "./inboxRowPresentation";
import type { InboxSidebarRow } from "./inboxSidebarModel";

type Row = Pick<InboxSidebarRow, "state" | "attention" | "errorDetail" | "statusLabel">;
const row = (overrides: Partial<Row>): Row => ({
  state: "idle",
  attention: null,
  errorDetail: null,
  statusLabel: "Idle",
  ...overrides,
});

describe("resolveInboxGlyph", () => {
  it("maps every state to one glyph, completed only when unseen", () => {
    expect(resolveInboxGlyph(row({ state: "needs-input" }), false)).toBe("needs-input");
    expect(resolveInboxGlyph(row({ state: "working" }), false)).toBe("working");
    expect(resolveInboxGlyph(row({ state: "connecting" }), false)).toBe("connecting");
    expect(resolveInboxGlyph(row({ state: "reconnecting" }), false)).toBe("connecting");
    expect(resolveInboxGlyph(row({ state: "error" }), false)).toBe("error");
    expect(resolveInboxGlyph(row({ state: "delivery-unknown" }), false)).toBe("error");
    expect(resolveInboxGlyph(row({ state: "offline" }), true)).toBe("offline");
    expect(resolveInboxGlyph(row({ state: "idle" }), false)).toBe("idle");
    expect(resolveInboxGlyph(row({ state: "idle" }), true)).toBe("completed");
  });
});

describe("inboxGlyphLabel", () => {
  it("names the attention kind and unseen completion", () => {
    expect(inboxGlyphLabel(row({ state: "needs-input", attention: "approval" }), false)).toBe(
      "Needs approval",
    );
    expect(inboxGlyphLabel(row({ state: "needs-input", attention: "plan" }), false)).toBe(
      "Plan ready",
    );
    expect(inboxGlyphLabel(row({ state: "idle" }), true)).toBe("Completed");
    expect(inboxGlyphLabel(row({ state: "idle" }), false)).toBe("Idle");
    expect(
      inboxGlyphLabel(row({ state: "offline", statusLabel: "Offline · last known" }), false),
    ).toBe("Offline · last known");
  });
});

describe("resolveInboxStateLine", () => {
  it("shows the ask for needs-input threads", () => {
    expect(resolveInboxStateLine(row({ state: "needs-input", attention: "approval" }))).toEqual({
      kind: "attention",
      text: "Needs approval",
    });
    expect(resolveInboxStateLine(row({ state: "needs-input", attention: "input" }))).toEqual({
      kind: "attention",
      text: "Needs your answer",
    });
    expect(inboxAttentionDetail({ attention: "plan" })).toBe("A plan is ready for your review.");
  });

  it("shows the reason for errors, with a fallback", () => {
    expect(
      resolveInboxStateLine(row({ state: "error", errorDetail: "Provider exited (code 1)" })),
    ).toEqual({ kind: "error", text: "Provider exited (code 1)" });
    expect(resolveInboxStateLine(row({ state: "error" }))).toEqual({
      kind: "error",
      text: "The last turn failed",
    });
    expect(resolveInboxStateLine(row({ state: "delivery-unknown" })).kind).toBe("error");
  });

  it("shows where the work lives for running and resting threads, never tool activity", () => {
    expect(resolveInboxStateLine(row({ state: "working" }))).toEqual({ kind: "workspace" });
    expect(resolveInboxStateLine(row({ state: "idle" }))).toEqual({ kind: "workspace" });
  });

  it("passes connection status through", () => {
    expect(
      resolveInboxStateLine(row({ state: "reconnecting", statusLabel: "Reconnecting" })),
    ).toEqual({ kind: "status", text: "Reconnecting" });
  });
});

describe("formatInboxAge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T14:32:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is compact", () => {
    expect(formatInboxAge("2026-10-02T14:31:40.000Z")).toBe("now");
    expect(formatInboxAge("2026-10-02T14:26:00.000Z")).toBe("6m");
    expect(formatInboxAge("2026-10-02T11:32:00.000Z")).toBe("3h");
    expect(formatInboxAge("2026-09-29T14:32:00.000Z")).toBe("3d");
  });
});

describe("row hints", () => {
  const hintRow = {
    state: "idle" as const,
    attention: null,
    errorDetail: null,
    statusLabel: "Idle",
    runningSince: null,
    latestTurnCompletedAt: null,
  };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T14:32:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("names the state and the fact behind the glyph", () => {
    expect(
      inboxGlyphHint(
        { ...hintRow, state: "error", statusLabel: "Error", errorDetail: "Exited (1)" },
        false,
      ),
    ).toBe("Error · Exited (1)");
    expect(inboxGlyphHint({ ...hintRow, state: "needs-input", attention: "approval" }, false)).toBe(
      "Needs approval · open the thread to respond",
    );
    expect(
      inboxGlyphHint({ ...hintRow, latestTurnCompletedAt: "2026-10-02T14:26:00.000Z" }, true),
    ).toBe("Completed 6m ago · not opened yet");
    expect(inboxGlyphHint(hintRow, false)).toBe("Idle · nothing running");
    const started = "2026-10-02T14:28:00.000Z";
    expect(
      inboxGlyphHint(
        { ...hintRow, state: "working", statusLabel: "Working", runningSince: started },
        false,
      ),
    ).toBe(`Working · started ${formatInboxDayTime(started)}`);
  });

  it("names the exact moment behind the compact time", () => {
    const at = "2026-10-01T09:00:00.000Z";
    const base = { runningSince: null, settled: false, snoozedUntil: null };
    expect(inboxTimeHint(base, at)).toBe(`Last activity ${formatInboxDayTime(at)}`);
    expect(inboxTimeHint({ ...base, settled: true }, at)).toBe(`Settled ${formatInboxDayTime(at)}`);
    expect(inboxTimeHint({ ...base, snoozedUntil: at }, at)).toBe(
      `Snoozed until ${formatInboxDayTime(at)}`,
    );
    expect(inboxTimeHint({ ...base, runningSince: at }, at)).toBe(
      `Running since ${formatInboxDayTime(at)}`,
    );
  });
});

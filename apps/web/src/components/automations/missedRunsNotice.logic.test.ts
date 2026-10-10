import type { MissedAutomationRun } from "@ryco/client-runtime/state/agentControl";
import { describe, expect, it } from "vite-plus/test";

import { missedRunsNoticeView } from "./missedRunsNotice.logic";

const NOW = new Date(2026, 9, 7, 9, 0).getTime();

const run = (
  title: string,
  overrides: Partial<Pick<MissedAutomationRun, "state" | "laterOccurrences">> = {},
) =>
  ({
    title,
    scheduledFor: new Date(2026, 9, 7, 3, 0).toISOString(),
    laterOccurrences: 0,
    state: "waiting",
    ...overrides,
  }) as MissedAutomationRun;

describe("missedRunsNoticeView", () => {
  it("offers to run one waiting catch-up now", () => {
    expect(
      missedRunsNoticeView([run("Nightly review")], { deviceLabel: null, nowMs: NOW }),
    ).toEqual({
      title: "Missed run · Nightly review",
      description: "Due today 03:00 while Ryco was offline. Run it now?",
      canRunNow: true,
    });
  });

  it("names the device and the occurrences folded into the run", () => {
    const view = missedRunsNoticeView([run("Digest", { laterOccurrences: 2 })], {
      deviceLabel: "Mac mini",
      nowMs: NOW,
    });
    expect(view.description).toBe(
      "Due today 03:00 (and 2 later times, folded into one run) while Mac mini was offline. Run it now?",
    );
  });

  it("explains an expired catch-up and leaves it to review", () => {
    const view = missedRunsNoticeView([run("Digest", { state: "expired" })], {
      deviceLabel: null,
      nowMs: NOW,
    });
    expect(view.canRunNow).toBe(false);
    expect(view.description).toBe(
      "Due today 03:00 while Ryco was offline. Its catch-up run wasn't approved within 15 min.",
    );
  });

  it("summarizes several missed runs", () => {
    const view = missedRunsNoticeView(
      [run("A"), run("B", { state: "expired" }), run("C"), run("D", { state: "expired" })],
      { deviceLabel: null, nowMs: NOW },
    );
    expect(view).toEqual({
      title: "4 automations missed their runs",
      description:
        "Ryco was offline when A, B and 2 more came due. 2 catch-up runs waiting for approval.",
      canRunNow: false,
    });
    expect(
      missedRunsNoticeView([run("A", { state: "expired" }), run("B", { state: "expired" })], {
        deviceLabel: null,
        nowMs: NOW,
      }).description,
    ).toBe("Ryco was offline when A and B came due.");
  });
});

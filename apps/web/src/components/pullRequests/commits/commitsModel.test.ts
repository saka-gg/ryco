import type { ChangeRequestTimelineItem } from "@ryco/contracts";
import { DateTime } from "effect";
import { describe, expect, it } from "vitest";

import { fixtureActivity, fixtureDetail } from "../testing/pullRequestFixtures";
import { buildCommitDays, formatCommitDay } from "./commitsModel";

const at = (iso: string) => DateTime.makeUnsafe(iso);

describe("buildCommitDays", () => {
  it("lists the fixture's commits newest first with the force-push in sequence", () => {
    const detail = fixtureDetail(703);
    const days = buildCommitDays({
      commits: detail.commits,
      timeline: fixtureActivity(703).timeline,
      headSha: detail.headSha ?? null,
      headChecks: "failing",
    });
    const items = days.flatMap((day) => day.items);
    expect(items.filter((item) => item.kind === "commit")).toHaveLength(8);
    expect(items[0]).toMatchObject({ kind: "commit", shortOid: "8e5d1c6", isHead: true });
    expect(items[0]?.kind === "commit" && items[0].checks).toBe("failing");
    const kinds = items.map((item) =>
      item.kind === "commit" ? item.shortOid : `force-push ${item.afterOid?.slice(0, 7)}`,
    );
    // The force-push two days ago sits between yesterday's commit and the older ones.
    expect(kinds.indexOf("force-push 19be4f7")).toBe(kinds.indexOf("4e1d0b2") + 1);
    // Days run newest first.
    const dayStarts = days.map((day) => day.dayMs ?? 0);
    expect(dayStarts).toEqual(dayStarts.toSorted((left, right) => right - left));
  });

  it("falls back to the timeline when the detail has no commit list", () => {
    const timeline: ReadonlyArray<ChangeRequestTimelineItem> = [
      {
        id: "c1",
        kind: "commit",
        createdAt: at("2026-10-01T10:00:00Z"),
        actor: { login: "ann", avatarUrl: "https://avatars.test/ann" },
        oid: "aaaaaaa1",
        shortOid: "aaaaaaa",
        messageHeadline: "First",
        checkState: "success",
      },
      {
        id: "c2",
        kind: "commit",
        createdAt: at("2026-10-02T10:00:00Z"),
        actor: { login: "ann" },
        oid: "bbbbbbb1",
        shortOid: "bbbbbbb",
        messageHeadline: "Second",
      },
    ];
    const days = buildCommitDays({
      commits: undefined,
      timeline,
      headSha: "bbbbbbb1",
      headChecks: "pending",
    });
    const commits = days.flatMap((day) => day.items);
    expect(commits.map((item) => item.kind === "commit" && item.headline)).toEqual([
      "Second",
      "First",
    ]);
    expect(commits[0]).toMatchObject({ checks: "pending", isHead: true });
    expect(commits[1]).toMatchObject({
      checks: "passing",
      author: "ann",
      avatarUrl: "https://avatars.test/ann",
    });
  });

  it("puts undated commits last, in their original order", () => {
    const days = buildCommitDays({
      commits: [
        { oid: "a1", shortOid: "a1", messageHeadline: "Undated A" },
        {
          oid: "b1",
          shortOid: "b1",
          messageHeadline: "Dated",
          committedDate: "2026-10-01T10:00:00Z",
        },
        { oid: "c1", shortOid: "c1", messageHeadline: "Undated B" },
      ],
      timeline: [],
      headSha: null,
      headChecks: null,
    });
    expect(days.map((day) => day.key).at(-1)).toBe("undated");
    expect(days.at(-1)?.items.map((item) => item.kind === "commit" && item.headline)).toEqual([
      "Undated B",
      "Undated A",
    ]);
  });
});

describe("formatCommitDay", () => {
  const formats = {
    weekday: new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" }),
    withYear: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }),
  };
  const now = new Date(2026, 9, 3, 15, 0).getTime();

  it("names today and yesterday, then dates", () => {
    expect(formatCommitDay(new Date(2026, 9, 3).getTime(), now, formats)).toBe("Today");
    expect(formatCommitDay(new Date(2026, 9, 2).getTime(), now, formats)).toBe("Yesterday");
    expect(formatCommitDay(new Date(2026, 8, 29).getTime(), now, formats)).toBe("Tue, Sep 29");
    expect(formatCommitDay(new Date(2025, 11, 30).getTime(), now, formats)).toBe("Dec 30, 2025");
    expect(formatCommitDay(null, now, formats)).toBe("Undated");
  });
});

import { Option } from "effect";
import { describe, expect, it } from "vite-plus/test";
import type { SourceControlIssueSummary } from "@ryco/contracts";
import { searchSourceControlSummaries } from "./sourceControlSearch.ts";

const summaries: SourceControlIssueSummary[] = [
  {
    provider: "github",
    number: 42 as any,
    title: "Remove stale todos_manager.html" as any,
    url: "u" as any,
    state: "open",
    updatedAt: Option.none(),
  },
  {
    provider: "github",
    number: 41 as any,
    title: "remote-install.sh shows wrong port" as any,
    url: "u" as any,
    state: "open",
    updatedAt: Option.none(),
  },
  {
    provider: "github",
    number: 40 as any,
    title: "AK-47 keychain canvas position not calibrated" as any,
    url: "u" as any,
    state: "open",
    updatedAt: Option.none(),
  },
];

describe("searchSourceControlSummaries", () => {
  it("returns all when query is empty", () => {
    expect(searchSourceControlSummaries(summaries, "")).toEqual(summaries);
  });
  it("matches by number", () => {
    const result = searchSourceControlSummaries(summaries, "42");
    expect(result[0]?.number).toBe(42);
  });
  it("matches title substring", () => {
    const result = searchSourceControlSummaries(summaries, "todos_manager");
    expect(result[0]?.number).toBe(42);
  });
  it("ranks prefix matches above substring matches", () => {
    const more = [
      ...summaries,
      {
        provider: "github" as const,
        number: 1 as any,
        title: "ak-47 followup" as any,
        url: "u" as any,
        state: "open" as const,
        updatedAt: Option.none(),
      },
    ];
    const result = searchSourceControlSummaries(more, "ak-47");
    expect(result[0]?.number).toBe(1);
  });
});

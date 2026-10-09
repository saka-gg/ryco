import { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { InboxSidebarEnvironment } from "../inboxSidebar/inboxSidebarModel";
import { nextSidebarFoldState, sidebarRestHeaderHeight } from "./sidebarFold";
import {
  buildOmnifieldSuggestions,
  omnifieldListQuery,
  omnifieldMachines,
  type OmnifieldSuggestionInput,
  parseOmnifieldInput,
  rankByTerm,
  removeTypedToken,
  splitLabelAtTerm,
} from "./sidebarOmnifield.logic";

const MBP = EnvironmentId.make("macbook-pro");
const STUDIO = EnvironmentId.make("mac-studio");
const BOX = EnvironmentId.make("build-box");

function environment(
  environmentId: EnvironmentId,
  label: string,
  connectionState: InboxSidebarEnvironment["connectionState"],
): InboxSidebarEnvironment {
  return {
    environmentId,
    label,
    connectionState,
    stale: false,
    role: null,
    trust: "not-required",
  } as InboxSidebarEnvironment;
}

const machines = omnifieldMachines(
  [
    environment(MBP, "MacBook Pro", "connected"),
    environment(STUDIO, "Mac Studio", "connected"),
    environment(BOX, "build-box", "offline"),
  ],
  MBP,
);

function suggestions(overrides: Partial<OmnifieldSuggestionInput>) {
  return buildOmnifieldSuggestions({
    mode: "inbox",
    value: "",
    showAllFilters: false,
    machines,
    statusCounts: { "needs-input": 3, pinned: 2 },
    matchCount: 0,
    paletteShortcutLabel: "⌘K",
    ...overrides,
  });
}

const optionLabels = (rows: ReturnType<typeof suggestions>) =>
  rows.flatMap((row) => (row.type === "option" ? [row.label] : []));

describe("parseOmnifieldInput", () => {
  it("reads a trailing @ or is: as a token being typed", () => {
    expect(parseOmnifieldInput("@st", "inbox")).toEqual({ kind: "machine", term: "st", cut: 3 });
    expect(parseOmnifieldInput("relay is:Ne", "inbox")).toEqual({
      kind: "status",
      term: "ne",
      cut: 6,
    });
  });

  it("treats anything else as text, and nothing as idle", () => {
    expect(parseOmnifieldInput("  relay ", "inbox")).toEqual({ kind: "text", term: "relay" });
    expect(parseOmnifieldInput("me@host", "inbox")).toEqual({ kind: "text", term: "me@host" });
    expect(parseOmnifieldInput("   ", "inbox")).toEqual({ kind: "idle" });
  });

  it("has no tokens in Projects mode", () => {
    expect(parseOmnifieldInput("@st", "projects")).toEqual({ kind: "text", term: "@st" });
  });
});

describe("omnifieldListQuery", () => {
  it("narrows the list by text but not by a half-typed token", () => {
    expect(omnifieldListQuery("relay")).toBe("relay");
    expect(omnifieldListQuery("relay @st")).toBe("");
  });
});

describe("removeTypedToken", () => {
  it("drops the token and the space before it", () => {
    expect(removeTypedToken("relay @st", 4)).toBe("relay");
    expect(removeTypedToken("@st", 3)).toBe("");
  });
});

describe("rankByTerm", () => {
  it("keeps matches only, prefix matches first, otherwise in order", () => {
    const ranked = rankByTerm(machines, "st", (machine) => [machine.label]);
    expect(ranked.map((machine) => machine.label)).toEqual(["Mac Studio"]);
    const byB = rankByTerm(machines, "b", (machine) => [machine.label]);
    expect(byB.map((machine) => machine.label)).toEqual(["build-box", "MacBook Pro"]);
  });
});

describe("splitLabelAtTerm", () => {
  it("splits around the first case-insensitive match", () => {
    expect(splitLabelAtTerm("Mac Studio", "stu")).toEqual({
      before: "Mac ",
      match: "Stu",
      after: "dio",
    });
    expect(splitLabelAtTerm("Mac Studio", "")).toBeNull();
    expect(splitLabelAtTerm("Mac Studio", "x")).toBeNull();
  });
});

describe("omnifieldMachines", () => {
  it("names this machine and offline ones", () => {
    expect(machines.map((machine) => [machine.label, machine.online, machine.meta])).toEqual([
      ["MacBook Pro", true, "this machine"],
      ["Mac Studio", true, null],
      ["build-box", false, "offline"],
    ]);
  });
});

describe("buildOmnifieldSuggestions", () => {
  it("offers @ and is: when the field is empty", () => {
    const rows = suggestions({});
    expect(optionLabels(rows)).toEqual(["Machine", "Status"]);
    expect(rows.at(-1)).toEqual({
      type: "hint",
      parts: ["⌘K search everywhere", "⌫ remove token"],
    });
  });

  it("lists every machine and status when the funnel is pressed", () => {
    const rows = suggestions({ showAllFilters: true });
    expect(optionLabels(rows)).toEqual([
      "MacBook Pro",
      "Mac Studio",
      "build-box",
      "Pinned",
      "Focus",
      "Active now",
      "Needs input",
      "Recent",
      "Snoozed",
      "Settled",
    ]);
  });

  it("shows status counts from the list, and none while a status filter hides them", () => {
    const counted = suggestions({ value: "is:ne" });
    expect(counted.find((row) => row.type === "option")).toMatchObject({
      label: "Needs input",
      meta: "3",
    });
    expect(suggestions({ value: "is:foc" }).find((row) => row.type === "option")).toMatchObject({
      label: "Focus",
      meta: "0",
    });
    const hidden = suggestions({ value: "is:ne", statusCounts: null });
    expect(hidden.find((row) => row.type === "option")).toMatchObject({ meta: null });
  });

  it("says when no machine or status matches", () => {
    expect(suggestions({ value: "@zzz" })).toEqual([
      { type: "group", label: "Machine" },
      { type: "hint", parts: ["No machine matches"] },
    ]);
  });

  it("counts matches here and escalates text to the palette", () => {
    const rows = suggestions({ value: "relay", matchCount: 1 });
    expect(rows[0]).toEqual({ type: "hint", parts: ["1 thread here matches “relay”"] });
    expect(rows[1]).toMatchObject({ option: { kind: "everywhere", query: "relay" } });
  });

  it("only searches in Projects mode", () => {
    expect(suggestions({ mode: "projects", value: "@st" })).toEqual([
      expect.objectContaining({ option: { kind: "everywhere", query: "@st" } }),
    ]);
    expect(suggestions({ mode: "projects" })).toEqual([
      { type: "hint", parts: ["Type to search threads, projects and commands"] },
    ]);
  });
});

describe("nextSidebarFoldState", () => {
  const metrics = {
    scrollTop: 0,
    scrollHeight: 2000,
    clientHeight: 600,
    foldGain: sidebarRestHeaderHeight(3) - 36,
    busy: false,
  };
  const rest = { folded: false, anchor: null };
  const folded = { folded: true, anchor: null };

  it("folds past the threshold and unfolds at the top", () => {
    expect(nextSidebarFoldState(rest, { ...metrics, scrollTop: 24 })).toEqual(rest);
    expect(nextSidebarFoldState(rest, { ...metrics, scrollTop: 25 })).toEqual(folded);
    expect(nextSidebarFoldState(folded, { ...metrics, scrollTop: 2 })).toEqual(rest);
  });

  it("never folds while the field is in use", () => {
    expect(nextSidebarFoldState(rest, { ...metrics, scrollTop: 300, busy: true })).toEqual(rest);
  });

  it("stays unfolded by hand until the list moves another threshold", () => {
    const anchored = { folded: false, anchor: 300 };
    expect(nextSidebarFoldState(anchored, { ...metrics, scrollTop: 320 })).toEqual(anchored);
    expect(nextSidebarFoldState(anchored, { ...metrics, scrollTop: 270 })).toEqual(folded);
  });

  it("does not fold a list too short to stay scrolled once the header folds", () => {
    const short = { ...metrics, scrollTop: 40, scrollHeight: 700 };
    expect(nextSidebarFoldState(rest, short)).toEqual(rest);
  });

  it("sizes the resting header by its destinations", () => {
    expect(sidebarRestHeaderHeight(3)).toBe(126);
    expect(sidebarRestHeaderHeight(0)).toBe(42);
  });
});

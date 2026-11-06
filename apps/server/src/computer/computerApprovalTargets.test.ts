import { describe, expect, it } from "vitest";

import {
  COMPUTER_APPROVAL_UNNAMED_APP,
  collectComputerApprovalTargets,
  computerApprovalAppsFor,
  computerApprovalTargetsEmpty,
} from "./computerApprovalTargets.ts";
import { ComputerDenylistError } from "./computerDenylist.ts";

describe("collectComputerApprovalTargets", () => {
  it("collects windows, refs, pids and apps from the call, drag ends and batch steps", () => {
    const refs = new Map([[7, "w-ref"]]);
    expect(
      collectComputerApprovalTargets(
        {
          window_id: "w1",
          from: { window_id: "w2" },
          to: { ref: 7 },
          steps: [{ type: "click", windowId: "w3" }, { app: " Notes " }, { pid: 42 }, { ref: 8 }],
          pid: -1,
        },
        (ref) => refs.get(ref),
      ),
    ).toEqual({ windowIds: ["w1", "w2", "w-ref", "w3"], pids: [42], apps: ["Notes"] });
  });

  it("names nothing for a coordinate-only call", () => {
    expect(collectComputerApprovalTargets({ x: 10, y: 20 })).toEqual({
      windowIds: [],
      pids: [],
      apps: [],
    });
  });
});

describe("computerApprovalAppsFor", () => {
  it("names each app once by its normalized name", () => {
    expect(
      computerApprovalAppsFor({
        names: ["Safari", "/Applications/Safari.app", "Notes"],
        unresolved: false,
      }),
    ).toEqual([
      { key: "safari", name: "Safari", canAlwaysAllow: true },
      { key: "notes", name: "Notes", canAlwaysAllow: true },
    ]);
  });

  it("asks about the unnamed target when a target cannot be named", () => {
    expect(computerApprovalAppsFor({ names: [], unresolved: false })).toEqual([
      COMPUTER_APPROVAL_UNNAMED_APP,
    ]);
    expect(computerApprovalAppsFor({ names: ["Safari"], unresolved: true })).toEqual([
      { key: "safari", name: "Safari", canAlwaysAllow: true },
      COMPUTER_APPROVAL_UNNAMED_APP,
    ]);
  });

  it("names a browser by its canonical identity, so its app and browser routes share an approval", () => {
    expect(
      computerApprovalAppsFor({
        names: ["Google Chrome", "com.google.Chrome", "/Applications/Microsoft Edge.app", "brave"],
        unresolved: false,
      }),
    ).toEqual([
      { key: "google chrome", name: "Google Chrome", canAlwaysAllow: true },
      { key: "microsoft edge", name: "Microsoft Edge", canAlwaysAllow: true },
      { key: "brave browser", name: "Brave Browser", canAlwaysAllow: true },
    ]);
  });

  it("treats a call that names nothing as empty", () => {
    expect(computerApprovalTargetsEmpty({ windowIds: [], pids: [], apps: [] })).toBe(true);
    expect(computerApprovalTargetsEmpty({ windowIds: [], pids: [4], apps: [] })).toBe(false);
  });

  it("refuses a denylisted app before any dialog", () => {
    expect(() =>
      computerApprovalAppsFor({ names: ["Safari", "System Settings"], unresolved: false }),
    ).toThrow(ComputerDenylistError);
    expect(() => computerApprovalAppsFor({ names: ["1Password 8"], unresolved: false })).toThrow(
      ComputerDenylistError,
    );
  });
});

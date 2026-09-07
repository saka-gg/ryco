import { MessageId, TurnId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  getRightPanelMode,
  isRightPanelOpen,
  parseRightPanelRouteSearch,
} from "./rightPanelRouteSearch";

describe("parseRightPanelRouteSearch", () => {
  it("keeps preview search when preview is the only open legacy panel", () => {
    expect(parseRightPanelRouteSearch({ preview: "1" })).toEqual({
      workspaceOpen: "1",
      workspaceTab: "files",
      preview: "1",
    });
  });

  it("canonicalizes conflicting legacy search state to the review panel", () => {
    expect(
      parseRightPanelRouteSearch({
        diff: "1",
        diffTurnId: "turn-1",
        diffFilePath: "src/app.ts",
        preview: "1",
      }),
    ).toEqual({
      workspaceOpen: "1",
      workspaceTab: "review",
      diff: "1",
      diffTurnId: TurnId.make("turn-1"),
      diffFilePath: "src/app.ts",
    });
  });

  it("keeps workspace files search compatible with the preview panel", () => {
    expect(parseRightPanelRouteSearch({ workspaceTab: "files" })).toEqual({
      workspaceOpen: "1",
      workspaceTab: "files",
      preview: "1",
    });
  });

  it("keeps workspace review search compatible with the diff panel", () => {
    expect(parseRightPanelRouteSearch({ workspaceTab: "review", diffTurnId: "turn-1" })).toEqual({
      workspaceOpen: "1",
      workspaceTab: "review",
      diff: "1",
    });
  });

  it("parses workspace terminal tabs without legacy panel state", () => {
    expect(parseRightPanelRouteSearch({ workspaceTab: "terminal", preview: "1" })).toEqual({
      workspaceOpen: "1",
      workspaceTab: "terminal",
    });
  });

  it("keeps launcher-only workspace search open without selecting a panel mode", () => {
    expect(parseRightPanelRouteSearch({ workspaceOpen: "1" })).toEqual({
      workspaceOpen: "1",
    });
  });

  it("parses keyed agent workspace tabs", () => {
    expect(
      parseRightPanelRouteSearch({
        workspaceTab: "agent",
        workspaceAgentKey: "subagent:hilbert",
        diff: "1",
      }),
    ).toEqual({
      workspaceOpen: "1",
      workspaceTab: "agent",
      workspaceAgentKey: "subagent:hilbert",
    });
  });

  it("drops invalid agent workspace tabs", () => {
    expect(parseRightPanelRouteSearch({ workspaceTab: "agent" })).toEqual({});
  });

  it("preserves message jump search with and without panel state", () => {
    expect(parseRightPanelRouteSearch({ messageId: "message-1" })).toEqual({
      messageId: MessageId.make("message-1"),
    });
    expect(parseRightPanelRouteSearch({ workspaceTab: "files", messageId: "message-1" })).toEqual({
      workspaceOpen: "1",
      workspaceTab: "files",
      preview: "1",
      messageId: MessageId.make("message-1"),
    });
  });
});

describe("getRightPanelMode", () => {
  it("returns the active panel mode", () => {
    expect(getRightPanelMode({ diff: "1" })).toBe("review");
    expect(getRightPanelMode({ preview: "1" })).toBe("files");
    expect(getRightPanelMode({ workspaceTab: "terminal" })).toBe("terminal");
    expect(getRightPanelMode({ workspaceTab: "agent", workspaceAgentKey: "subagent:1" })).toBe(
      "agent",
    );
    expect(getRightPanelMode({ workspaceOpen: "1" })).toBeNull();
    expect(getRightPanelMode({})).toBeNull();
  });
});

describe("isRightPanelOpen", () => {
  it("returns true for launcher and concrete panel states", () => {
    expect(isRightPanelOpen({ workspaceOpen: "1" })).toBe(true);
    expect(isRightPanelOpen({ diff: "1" })).toBe(true);
    expect(isRightPanelOpen({ preview: "1" })).toBe(true);
    expect(isRightPanelOpen({ workspaceTab: "terminal" })).toBe(true);
    expect(isRightPanelOpen({})).toBe(false);
  });
});

it("preserves an agent selection within Agents and reports the shared panel mode", () => {
  const search = parseRightPanelRouteSearch({
    workspaceTab: "agents",
    workspaceAgentKey: "subagent:child",
  });
  expect(search).toEqual({
    workspaceOpen: "1",
    workspaceTab: "agents",
    workspaceAgentKey: "subagent:child",
  });
  expect(getRightPanelMode(search)).toBe("agents");
});

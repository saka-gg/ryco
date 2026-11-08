import { describe, expect, it } from "vite-plus/test";

import type { ThreadId } from "@ryco/contracts";
import type { AgentControlCompletionReturn } from "@ryco/contracts/agent-control";
import type { ThreadLineage } from "@ryco/contracts/orchestration";

import {
  buildThreadOriginBreadcrumbModel,
  threadOriginResult,
} from "./threadOriginBreadcrumbModel";

const PARENT = "parent" as ThreadId;

function lineage(relationship: string): ThreadLineage {
  return { parentThreadId: PARENT, rootThreadId: PARENT, relationship } as ThreadLineage;
}

function returnWith(status: AgentControlCompletionReturn["status"]): AgentControlCompletionReturn {
  return { status } as AgentControlCompletionReturn;
}

function build(overrides: Partial<Parameters<typeof buildThreadOriginBreadcrumbModel>[0]> = {}) {
  return buildThreadOriginBreadcrumbModel({
    lineage: lineage("delegated"),
    parentTitle: "Fix login redirect loop",
    parentAvailability: "available",
    ownReturn: null,
    ...overrides,
  });
}

describe("thread origin breadcrumb", () => {
  it("shows nothing for a root thread or a relationship this app does not know", () => {
    expect(build({ lineage: null })).toBeNull();
    expect(build({ lineage: undefined })).toBeNull();
    expect(build({ lineage: lineage("future-kind") })).toBeNull();
  });

  it("leads a delegated child back to its parent, with its own result return", () => {
    expect(build({ ownReturn: returnWith("delivered") })).toEqual({
      kind: "delegated",
      lead: "From",
      parentTitle: "Fix login redirect loop",
      parentThreadId: PARENT,
      result: { text: "Result returned", tone: "success" },
      accessibilityLabel: "Delegated from Fix login redirect loop. Result returned",
    });
    expect(build()).toMatchObject({
      result: null,
      accessibilityLabel: "Delegated from Fix login redirect loop",
    });
  });

  it("names a fork's source, which gets no result from it", () => {
    expect(build({ lineage: lineage("forked"), ownReturn: returnWith("waiting") })).toMatchObject({
      kind: "forked",
      lead: "Forked from",
      result: null,
      accessibilityLabel: "Forked from Fix login redirect loop",
    });
  });

  it("links only to a parent on this node, and names an unknown one plainly", () => {
    expect(build({ parentAvailability: "missing", parentTitle: "  " })).toMatchObject({
      parentTitle: "another chat",
      parentThreadId: null,
    });
    expect(build({ parentAvailability: "unknown" })?.parentThreadId).toBeNull();
  });

  it("says the child's return from its own side", () => {
    expect(
      (
        ["waiting", "ready", "dispatching", "delivered", "blocked", "failed", "cancelled"] as const
      ).map((status) => threadOriginResult(returnWith(status))),
    ).toEqual([
      { text: "Returns when done", tone: "muted" },
      { text: "Result ready", tone: "info" },
      { text: "Returning…", tone: "info" },
      { text: "Result returned", tone: "success" },
      { text: "Return blocked", tone: "danger" },
      { text: "Return failed", tone: "danger" },
      { text: "Return cancelled", tone: "muted" },
    ]);
    expect(threadOriginResult(null)).toBeNull();
  });
});

import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

// The fold invoked as a plain function with react-native mocked (no React renderer exists in
// this suite): where the agent's latest thought sits among the working fold's rows.

vi.mock("react-native", () => ({ Pressable: "Pressable", View: "View" }));
vi.mock("../../components/AppText", () => ({ AppText: "Text" }));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: "SymbolView" }));
vi.mock("../../lib/useThemeColor", () => ({ useThemeColor: () => "#888888" }));
vi.mock("../../rpc/useActivityPayloadOutput", () => ({
  useActivityPayloadOutput: () => ({ status: "idle" }),
}));

import { ThreadActivityFoldRow } from "./ThreadActivityFoldRow";
import type { ActivityFold, ActivityRow } from "./threadActivityFold";

function elements(node: unknown): ReactElement<Record<string, unknown>>[] {
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, unknown>>;
  return [element, ...[element.props.children].flat(Infinity).flatMap(elements)];
}

function activityRow(id: string): ActivityRow {
  return {
    id,
    heading: `Step ${id}`,
    detail: null,
    command: null,
    output: null,
    outputPreviewActivityId: null,
    exitCode: null,
    changedFiles: [],
    tone: "tool",
    completed: id !== "b",
  };
}

function fold(liveThought: ActivityFold["liveThought"], expanded = true): ActivityFold {
  return {
    kind: "activity-fold",
    id: "fold:turn-1:a",
    turnId: "turn-1",
    status: "running",
    label: "Working…",
    rows: [activityRow("a"), activityRow("b")],
    expanded,
    liveThought,
  };
}

/** The fold's rows in order: a step's id, or the thought's text. */
function order(target: ActivityFold): string[] {
  return elements(
    ThreadActivityFoldRow({
      fold: target,
      environmentId: "env" as EnvironmentId,
      threadId: "thread" as ThreadId,
      onToggle: () => undefined,
    }),
  ).flatMap((node) => {
    const props = node.props as { row?: ActivityRow; thought?: { text: string } };
    if (props.row) return [props.row.id];
    if (props.thought) return [`thought: ${props.thought.text}`];
    return [];
  });
}

describe("thread activity fold live thought", () => {
  it("sits above the running step", () => {
    expect(order(fold({ text: "The retry never backs off.", beforeRowId: "b" }))).toEqual([
      "a",
      "thought: The retry never backs off.",
      "b",
    ]);
  });

  it("closes the rows when no step runs after it", () => {
    expect(order(fold({ text: "Next, both clients.", beforeRowId: null }))).toEqual([
      "a",
      "b",
      "thought: Next, both clients.",
    ]);
  });

  it("is not shown without a thought, or while the fold is collapsed", () => {
    expect(order(fold(null))).toEqual(["a", "b"]);
    expect(order(fold({ text: "Hidden.", beforeRowId: "b" }, false))).toEqual([]);
  });
});

import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Pressable: "Pressable",
  View: "View",
}));
vi.mock("../../components/AppText", () => ({ AppText: "Text" }));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: "SymbolView" }));
vi.mock("../../lib/useThemeColor", () => ({ useThemeColor: () => "#000" }));
import { NewTaskLaunchCard } from "./NewTaskLaunchCard";
import type { NewTaskLaunchView } from "./newTaskLaunch";

type Element = ReactElement<Record<string, unknown>>;

function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children)];
}

function textOf(element: Element): string {
  return elements(element)
    .filter((child) => child.type === "Text")
    .map((child) => {
      const children = child.props.children;
      return (Array.isArray(children) ? children : [children]).join("");
    })
    .join(" ");
}

function buttons(tree: Element): Map<string, () => void> {
  return new Map(
    elements(tree)
      .filter((element) => element.type === "Pressable")
      .map((element) => [textOf(element), element.props.onPress as () => void]),
  );
}

const FAILED: NewTaskLaunchView = {
  queued: false,
  title: "Fix the header",
  prompt: "Fix the header",
  attachmentCount: 0,
  statusLabel: "Not started",
  steps: [
    { id: "thread", label: "Create task", status: "failed", percent: null },
    { id: "turn", label: "Start agent", status: "pending", percent: null },
  ],
  failureMessage: "This project is archived.",
  canRetry: true,
  canEdit: true,
  canRemove: true,
};

const noop = () => undefined;

describe("NewTaskLaunchCard", () => {
  it("shows the task as sent, its steps and the failure, with Retry, Edit task and Remove", () => {
    const onRetry = vi.fn();
    const onEdit = vi.fn();
    const onRemove = vi.fn();
    const tree = NewTaskLaunchCard({ view: FAILED, onRetry, onEdit, onRemove }) as Element;
    const copy = textOf(tree);
    expect(copy).toContain("Fix the header");
    expect(copy).toContain("Create task");
    expect(copy).toContain("This project is archived.");

    const actions = buttons(tree);
    expect([...actions.keys()]).toEqual(["Retry", "Edit task", "Remove"]);
    actions.get("Retry")?.();
    actions.get("Edit task")?.();
    actions.get("Remove")?.();
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("offers only Retry when the task may already be on the node", () => {
    const tree = NewTaskLaunchCard({
      view: { ...FAILED, canEdit: false, canRemove: false },
      onRetry: noop,
      onEdit: noop,
      onRemove: noop,
    }) as Element;
    expect([...buttons(tree).keys()]).toEqual(["Retry"]);
  });

  it("offers nothing to press while the node is still starting it", () => {
    const tree = NewTaskLaunchCard({
      view: {
        ...FAILED,
        statusLabel: "Setting up a worktree",
        steps: [{ id: "checkout", label: "Check out files", status: "running", percent: 40 }],
        failureMessage: null,
        canRetry: false,
        canEdit: false,
        canRemove: false,
      },
      onRetry: noop,
      onEdit: noop,
      onRemove: noop,
    }) as Element;
    expect(buttons(tree).size).toBe(0);
    expect(textOf(tree)).toContain("Check out files · 40%");
  });

  it("offers Edit task and Remove for a task waiting for its machine", () => {
    const tree = NewTaskLaunchCard({
      view: {
        ...FAILED,
        queued: true,
        statusLabel: "Queued: starts when Studio Mac is back",
        failureMessage: null,
        canRetry: false,
      },
      onRetry: noop,
      onEdit: noop,
      onRemove: noop,
    }) as Element;
    expect([...buttons(tree).keys()]).toEqual(["Edit task", "Remove"]);
    expect(textOf(tree)).toContain("Queued: starts when Studio Mac is back");
  });
});

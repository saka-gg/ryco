import type { ReactElement } from "react";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId, UserActionRequestId } from "@ryco/contracts";
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (value: unknown) => [value, vi.fn()],
}));
vi.mock("react-native", () => ({ Pressable: "Pressable", View: "View" }));
vi.mock("../../components/AppText", () => ({ AppText: "Text" }));
vi.mock("../../lib/copyTextWithHaptic", () => ({ copyTextWithHaptic: vi.fn() }));
vi.mock("../../connection/environmentApi", () => ({ ensureEnvironmentApi: vi.fn(() => ({})) }));
const navigate = vi.fn();
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate }) }));
import { UserActionRequestCard } from "./UserActionRequestCard";

function elements(node: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, unknown>>;
  const children = element.props.children;
  return [element, ...(Array.isArray(children) ? children : [children]).flatMap(elements)];
}

const texts = (tree: ReturnType<typeof elements>) =>
  tree.flatMap((entry) =>
    typeof entry.props.children === "string" ? [entry.props.children as string] : [],
  );

const buttonLabelled = (tree: ReturnType<typeof elements>, label: string) =>
  tree.find(
    (entry) =>
      entry.type === "Pressable" &&
      elements(entry.props.children).some((child) => child.props.children === label),
  );

const props = {
  environmentId: EnvironmentId.make("fixture"),
  threadId: ThreadId.make("fixture"),
  request: {
    requestId: UserActionRequestId.make(`user-action-${"e".repeat(32)}`),
    surface: "browser" as const,
    need: "sign-in" as const,
    message: "Sign in to GitHub in the tab.",
    target: "tab-1",
    remoteView: false,
    requestedAt: "2026-11-21T08:00:00.000Z",
    expiresAt: "2026-11-21T08:10:00.000Z",
    turnId: null,
    status: "pending" as const,
  },
  disabledReason: null,
};

it("native user action cards show the label, the agent's message and where to continue", () => {
  const tree = elements(UserActionRequestCard(props));
  expect(texts(tree)).toEqual(
    expect.arrayContaining([
      "Login required in browser",
      "Sign in to GitHub in the tab.",
      "Continue on your desktop: the tab is in Ryco's Browser panel there.",
    ]),
  );
  // Done and Won't do; the phone cannot show the desktop's tab, so no Show.
  expect(buttonLabelled(tree, "Done")?.props.disabled).toBe(false);
  expect(buttonLabelled(tree, "Won't do")?.props.disabled).toBe(false);
  expect(buttonLabelled(tree, "Show")).toBeUndefined();
});

it("native user action cards are read-only for a session that cannot answer", () => {
  const reason = "Only the node's owner can answer this request.";
  const tree = elements(UserActionRequestCard({ ...props, disabledReason: reason }));
  expect(buttonLabelled(tree, "Done")?.props.disabled).toBe(true);
  expect(buttonLabelled(tree, "Won't do")?.props.disabled).toBe(true);
  expect(texts(tree)).toContain(reason);
});

it("native user action cards open a remote-view tab in the browser screen", () => {
  const request = { ...props.request, remoteView: true };
  const tree = elements(UserActionRequestCard({ ...props, request }));
  expect(texts(tree)).toContain("Open the tab here and sign in; the agent can't use it meanwhile.");
  expect(texts(tree)).not.toContain(
    "Continue on your desktop: the tab is in Ryco's Browser panel there.",
  );
  const open = buttonLabelled(tree, "Open tab");
  (open?.props.onPress as () => void)();
  expect(navigate).toHaveBeenCalledWith("ThreadBrowser", {
    environmentId: props.environmentId,
    threadId: props.threadId,
    tabId: `handoff-${"e".repeat(32)}`,
  });
  // Done and Won't do stay.
  expect(buttonLabelled(tree, "Done")?.props.disabled).toBe(false);
  expect(buttonLabelled(tree, "Won't do")?.props.disabled).toBe(false);
});

it("native user action cards offer no Open tab to a session that cannot answer", () => {
  const request = { ...props.request, remoteView: true };
  const tree = elements(
    UserActionRequestCard({ ...props, request, disabledReason: "Reconnect to answer." }),
  );
  expect(buttonLabelled(tree, "Open tab")).toBeUndefined();
  expect(texts(tree)).toContain(
    "Continue on your desktop: the tab is in Ryco's Browser panel there.",
  );
});

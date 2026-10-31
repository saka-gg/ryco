import type { ReactElement } from "react";
import { expect, it, vi } from "vite-plus/test";
import { ApprovalRequestId, EnvironmentId, ThreadId } from "@ryco/contracts";
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (value: unknown) => [value, vi.fn()],
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}));
vi.mock("react-native", () => ({ Pressable: "Pressable", TextInput: "TextInput", View: "View" }));
vi.mock("../../components/AppText", () => ({ AppText: "Text" }));
vi.mock("../../connection/environmentApi", () => ({ ensureEnvironmentApi: vi.fn(() => ({})) }));
vi.mock("./sessionActions", () => ({ respondToThreadUserInput: vi.fn(async () => {}) }));
import { PendingUserInputCard } from "./PendingUserInputCard";
import { respondToThreadUserInput } from "./sessionActions";
function elements(node: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, unknown>>;
  const children = element.props.children;
  return [element, ...(Array.isArray(children) ? children : [children]).flatMap(elements)];
}
let fixture = 0;
const props = {
  environmentId: EnvironmentId.make("fixture"),
  threadId: ThreadId.make("fixture"),
  userInput: {
    requestId: ApprovalRequestId.make("optional:fixture"),
    nonBlocking: true,
    createdAt: "2026-09-27T00:00:00.000Z",
    questions: [
      { id: "0", header: "Question", question: "Audience?", options: [], multiSelect: false },
    ],
  },
};
it("native optional questions expose free text and local dismissal without pre-answering", async () => {
  const tree = elements(PendingUserInputCard(props));
  expect(
    tree.find((entry) => entry.props.accessibilityLabel === "Custom answer: Audience?")?.props
      .editable,
  ).toBe(true);
  const dismiss = tree.find(
    (entry) =>
      (entry.props.children as ReactElement<{ children: string }>)?.props?.children === "Dismiss",
  )!;
  (dismiss.props.onPress as () => void)();
  await vi.waitFor(() =>
    expect(respondToThreadUserInput).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "optional:fixture", answers: {} }),
    ),
  );
});
it("native cached cards disable editing and dismissal", () => {
  const tree = elements(PendingUserInputCard({ ...props, disabled: true }));
  expect(
    tree.find((entry) => entry.props.accessibilityLabel === "Custom answer: Audience?")?.props
      .editable,
  ).toBe(false);
  const dismiss = tree.find(
    (entry) =>
      (entry.props.children as ReactElement<{ children: string }>)?.props?.children === "Dismiss",
  )!;
  expect(dismiss.props.disabled).toBe(true);
});

function findByChild(tree: ReactElement<Record<string, unknown>>[], text: string) {
  return tree.find(
    (entry) =>
      (entry.props.children as ReactElement<{ children: string }>)?.props?.children === text,
  )!;
}

it("native optional questions answered after their turn start a new message and keep the draft until then", async () => {
  fixture += 1;
  const lateProps = {
    ...props,
    threadId: ThreadId.make(`late-${fixture}`),
    route: "message" as const,
    onSendAsMessage: vi.fn(async () => {}),
  };
  const field = () =>
    elements(PendingUserInputCard(lateProps)).find(
      (entry) => entry.props.accessibilityLabel === "Custom answer: Audience?",
    )!;
  (field().props.onChangeText as (text: string) => void)("Engineers");
  // A new render (a remount after a thread switch or reconnect) reads the kept draft.
  expect(field().props.value).toBe("Engineers");
  const tree = elements(PendingUserInputCard(lateProps));
  expect(tree.some((entry) => entry.props.children === "Optional question · turn ended")).toBe(
    true,
  );
  (findByChild(tree, "Submit").props.onPress as () => void)();
  await vi.waitFor(() =>
    expect(lateProps.onSendAsMessage).toHaveBeenCalledWith(lateProps.userInput, {
      "0": "Engineers",
    }),
  );
  expect(respondToThreadUserInput).not.toHaveBeenCalledWith(
    expect.objectContaining({ answers: { "0": "Engineers" } }),
  );
  await vi.waitFor(() => expect(field().props.value).toBe(""));
});

it("native optional questions wait while another turn runs", () => {
  fixture += 1;
  const waitProps = {
    ...props,
    threadId: ThreadId.make(`wait-${fixture}`),
    route: "wait" as const,
  };
  const field = () =>
    elements(PendingUserInputCard(waitProps)).find(
      (entry) => entry.props.accessibilityLabel === "Custom answer: Audience?",
    )!;
  (field().props.onChangeText as (text: string) => void)("Engineers");
  expect(field().props.value).toBe("Engineers");
  const tree = elements(PendingUserInputCard(waitProps));
  expect(
    tree.some((entry) => entry.props.children === "You can answer once the current turn ends."),
  ).toBe(true);
  expect(findByChild(tree, "Submit").props.disabled).toBe(true);
  expect(findByChild(tree, "Dismiss").props.disabled).toBe(false);
});

import type { ReactElement } from "react";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, SecretRequestId, ThreadId } from "@ryco/contracts";
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (value: unknown) => [value, vi.fn()],
}));
vi.mock("react-native", () => ({ Pressable: "Pressable", TextInput: "TextInput", View: "View" }));
vi.mock("../../components/AppText", () => ({ AppText: "Text" }));
vi.mock("../../connection/environmentApi", () => ({ ensureEnvironmentApi: vi.fn(() => ({})) }));
import { SecretRequestCard } from "./SecretRequestCard";

function elements(node: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, unknown>>;
  const children = element.props.children;
  return [element, ...(Array.isArray(children) ? children : [children]).flatMap(elements)];
}

const props = {
  environmentId: EnvironmentId.make("fixture"),
  threadId: ThreadId.make("fixture"),
  request: {
    requestId: SecretRequestId.make(`secret-request-${"e".repeat(32)}`),
    key: "SUPABASE_KEY",
    purpose: "Read the database",
    file: ".env",
    requestedAt: "2026-10-31T08:00:00.000Z",
    expiresAt: "2026-11-01T08:00:00.000Z",
    checkoutId: "c".repeat(32),
    turnId: null,
    status: "pending" as const,
  },
  disabledReason: null,
};

const field = (tree: ReturnType<typeof elements>) =>
  tree.find((entry) => entry.props.accessibilityLabel === "Value for SUPABASE_KEY")!;

it("native secret cards mask the value and keep it out of autofill and the keyboard's memory", () => {
  const input = field(elements(SecretRequestCard(props)));
  expect(input.props).toMatchObject({
    secureTextEntry: true,
    autoCorrect: false,
    autoComplete: "off",
    importantForAutofill: "no",
    textContentType: "none",
    editable: true,
  });
});

it("native secret cards are read-only for a session that cannot answer", () => {
  const tree = elements(
    SecretRequestCard({ ...props, disabledReason: "Only the node's owner can answer." }),
  );
  expect(field(tree).props.editable).toBe(false);
  const decline = tree.find(
    (entry) =>
      (entry.props.children as ReactElement<{ children: string }>)?.props?.children === "Decline",
  )!;
  expect(decline.props.disabled).toBe(true);
});

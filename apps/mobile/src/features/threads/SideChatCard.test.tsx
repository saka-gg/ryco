import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { ProviderInstanceId } from "@ryco/contracts";

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (value: unknown) => [value, vi.fn()],
}));
vi.mock("react-native", () => ({ Pressable: "Pressable", ScrollView: "ScrollView", View: "View" }));
vi.mock("../../components/AppText", () => ({ AppText: "Text" }));
vi.mock("../../native/ComposerEditor", () => ({ ComposerEditor: "ComposerEditor" }));
vi.mock("./ModelPickerSheet", () => ({ ModelPickerSheet: "ModelPickerSheet" }));
vi.mock("./modelPickerModel", () => ({
  buildModelPickerModel: () => ({ pillLabel: "Side model", pillReasoningLabel: "Medium" }),
  applyModelOption: vi.fn(),
  resolveModelPickerSelection: vi.fn(),
}));
import { SideChatCard } from "./SideChatCard";

function elements(node: unknown): ReactElement<Record<string, unknown>>[] {
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, unknown>>;
  const children = element.props.children;
  return [element, ...(Array.isArray(children) ? children : [children]).flatMap(elements)];
}
function props() {
  return {
    open: true,
    draft: "Why?",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
    exchanges: [{ requestId: "earlier", question: "Earlier question", answer: "Completed answer" }],
    pending: null,
    error: null,
    serverConfig: null,
    disabled: false,
    onOpen: vi.fn(),
    onClose: vi.fn(),
    onDraftChange: vi.fn(),
    onModelChange: vi.fn(),
    onSend: vi.fn(),
    onCancel: vi.fn(),
    onClear: vi.fn(),
  };
}
function control(tree: ReactElement, label: string) {
  return elements(tree).find((element) => element.props.accessibilityLabel === label)!.props;
}
describe("native side chat presentation", () => {
  it("routes send and stop to the side callbacks, keeping stop available offline", () => {
    const input = props();
    const send = control(SideChatCard(input), "Send side question");
    expect(send.disabled).toBe(false);
    (send.onPress as () => void)();
    expect(input.onSend).toHaveBeenCalledOnce();
    const stop = control(
      SideChatCard({ ...input, pending: { question: "Working" }, disabled: true }),
      "Stop side answer",
    );
    expect(stop.disabled).toBe(false);
    (stop.onPress as () => void)();
    expect(input.onCancel).toHaveBeenCalledOnce();
  });
  it("blocks new requests while disconnected and preserves the reopen affordance", () => {
    const input = props();
    expect(control(SideChatCard({ ...input, disabled: true }), "Send side question").disabled).toBe(
      true,
    );
    const minimized = SideChatCard({ ...input, open: false });
    (control(minimized, "Reopen side chat").onPress as () => void)();
    expect(input.onOpen).toHaveBeenCalledOnce();
    expect(
      elements(minimized).some(
        (element) => element.props.accessibilityLabel === "Send side question",
      ),
    ).toBe(false);
  });
  it("minimizing does not cancel and new conversation explicitly clears history", () => {
    const input = props();
    const tree = SideChatCard(input);
    (control(tree, "Minimize side chat").onPress as () => void)();
    expect(input.onClose).toHaveBeenCalledOnce();
    expect(input.onCancel).not.toHaveBeenCalled();
    (control(tree, "New side chat").onPress as () => void)();
    expect(input.onClear).toHaveBeenCalledOnce();
  });
});

import type { ReactElement } from "react";
import {
  CWD_RELOCATION_HANDOFF_COPY,
  type ContextHandoffTimelineEntry,
} from "@ryco/client-runtime/state/session";
import {
  ContextHandoffId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({ View: "View" }));
vi.mock("../../components/AppText", () => ({ AppText: "Text" }));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: "SymbolView" }));
vi.mock("../../lib/useThemeColor", () => ({ useThemeColor: () => "#888888" }));
vi.mock("./ContextHandoffEndpointLabel", () => ({
  ContextHandoffEndpointLabel: "ContextHandoffEndpointLabel",
}));
import { ContextHandoffMarkerRow } from "./ContextHandoffMarkerRow";

function elements(node: unknown): ReactElement<Record<string, unknown>>[] {
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, unknown>>;
  const children = element.props.children;
  return [element, ...(Array.isArray(children) ? children : [children]).flatMap(elements)];
}

function texts(tree: ReactElement): string[] {
  return elements(tree)
    .filter((element) => element.type === "Text")
    .map((element) => [element.props.children].flat().join(""));
}

const endpoint = {
  providerInstanceId: ProviderInstanceId.make("claude-work"),
  driverKind: ProviderDriverKind.make("claudeAgent"),
  modelSlug: "claude-opus-5",
};

function marker(overrides: Partial<ContextHandoffTimelineEntry> = {}): ContextHandoffTimelineEntry {
  return {
    id: "context-handoff:activity-1",
    activityId: "activity-1",
    handoffId: ContextHandoffId.make("handoff-1"),
    createdAt: "2026-10-08T10:00:00.000Z",
    turnId: null,
    status: "consumed",
    targetMessageId: MessageId.make("message-1"),
    targetTurnId: null,
    sources: [endpoint],
    target: endpoint,
    ...overrides,
  };
}

describe("native context handoff divider", () => {
  it("reads a working-folder relocation as a fresh session, never as a model transition", () => {
    const tree = ContextHandoffMarkerRow({ marker: marker({ reason: "cwd-relocation" }) });
    expect(texts(tree)).toEqual([CWD_RELOCATION_HANDOFF_COPY.continued]);
    expect(tree.props.accessibilityLabel).toBe(CWD_RELOCATION_HANDOFF_COPY.continued);
    expect(tree.props.accessibilityHint).toBe(CWD_RELOCATION_HANDOFF_COPY.explanation);
    // No `<model> → <model>` endpoints for a handoff that kept its model.
    expect(elements(tree).some((element) => typeof element.type === "function")).toBe(false);
    expect(elements(tree).find((element) => element.type === "SymbolView")?.props.name).toBe(
      "folder",
    );
  });

  it("tells the user to send again after a failed relocation", () => {
    const tree = ContextHandoffMarkerRow({
      marker: marker({ reason: "cwd-relocation", status: "failed", error: "Provider exited" }),
    });
    expect(texts(tree)).toEqual([
      CWD_RELOCATION_HANDOFF_COPY.attempted,
      "Failed",
      CWD_RELOCATION_HANDOFF_COPY.retryHint,
    ]);
    expect(tree.props.accessibilityLabel).toBe(
      "Fresh session in the new folder. Failed: Provider exited. Send your message again to retry",
    );
  });

  it("keeps the model transition for model changes, including historical ones", () => {
    for (const reason of [undefined, "model-change" as const]) {
      const tree = ContextHandoffMarkerRow({ marker: marker(reason ? { reason } : {}) });
      expect(texts(tree)).toEqual(["Context handoff"]);
      expect(tree.props.accessibilityHint).toBeUndefined();
      expect(elements(tree).some((element) => typeof element.type === "function")).toBe(true);
    }
  });
});

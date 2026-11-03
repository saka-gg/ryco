import type { ReactElement } from "react";
import {
  CWD_RELOCATION_HANDOFF_COPY,
  FORK_HANDOFF_COPY,
  NATIVE_HISTORY_UNAVAILABLE_HANDOFF_COPY,
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

  it("says why a fresh session got the conversation when the provider lost its history", () => {
    const tree = ContextHandoffMarkerRow({
      marker: marker({ reason: "native-history-unavailable" }),
    });
    expect(texts(tree)).toEqual([NATIVE_HISTORY_UNAVAILABLE_HANDOFF_COPY.continued]);
    expect(tree.props.accessibilityLabel).toBe(NATIVE_HISTORY_UNAVAILABLE_HANDOFF_COPY.continued);
    expect(tree.props.accessibilityHint).toBe(NATIVE_HISTORY_UNAVAILABLE_HANDOFF_COPY.explanation);
    expect(elements(tree).some((element) => typeof element.type === "function")).toBe(false);
    expect(elements(tree).find((element) => element.type === "SymbolView")?.props.name).toBe(
      "clock.arrow.circlepath",
    );

    const failed = ContextHandoffMarkerRow({
      marker: marker({ reason: "native-history-unavailable", status: "failed" }),
    });
    expect(texts(failed)).toEqual([
      NATIVE_HISTORY_UNAVAILABLE_HANDOFF_COPY.attempted,
      "Failed",
      NATIVE_HISTORY_UNAVAILABLE_HANDOFF_COPY.retryHint,
    ]);
  });

  it("reads a fork's first session as the inherited conversation reaching a fresh session", () => {
    const tree = ContextHandoffMarkerRow({
      marker: marker({ reason: "fork", target: { ...endpoint, modelDisplayName: "Opus 5" } }),
    });
    expect(texts(tree)).toEqual(["Sent the inherited conversation to a fresh Opus 5 session"]);
    expect(tree.props.accessibilityLabel).toBe(
      "Sent the inherited conversation to a fresh Opus 5 session",
    );
    expect(tree.props.accessibilityHint).toBe(FORK_HANDOFF_COPY.explanation);
    // The fork keeps its model: no `<model> → <model>` endpoints.
    expect(elements(tree).some((element) => typeof element.type === "function")).toBe(false);
    expect(elements(tree).find((element) => element.type === "SymbolView")?.props.name).toBe(
      "arrow.triangle.branch",
    );
  });

  it("names the model a fork switched from when its first message changed provider", () => {
    const codex = {
      providerInstanceId: ProviderInstanceId.make("codex-work"),
      driverKind: ProviderDriverKind.make("codex"),
      modelSlug: "gpt-5.6",
      modelDisplayName: "GPT-5.6",
    };
    const tree = ContextHandoffMarkerRow({
      marker: marker({
        reason: "fork",
        sources: [codex],
        target: { ...endpoint, modelDisplayName: "Opus 5" },
        changedFrom: codex,
      }),
    });
    expect(texts(tree)).toEqual([
      "Sent the inherited conversation to a fresh Claude Opus 5 session, switching from Codex GPT-5.6",
    ]);
    expect(tree.props.accessibilityLabel).toBe(
      "Sent the inherited conversation to a fresh Claude Opus 5 session, switching from Codex GPT-5.6",
    );
  });

  it("says a failed fork delivery is retried by the next send, without a second status tag", () => {
    const tree = ContextHandoffMarkerRow({
      marker: marker({ reason: "fork", status: "failed", error: "Provider exited" }),
    });
    expect(texts(tree)).toEqual([FORK_HANDOFF_COPY.failed, FORK_HANDOFF_COPY.retryHint]);
    expect(tree.props.accessibilityLabel).toBe(
      "Couldn't send the inherited conversation to a fresh session. Failed: Provider exited. Send your message again to retry",
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

import type { ReactElement } from "react";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import {
  AgentControlActionPlan,
  AgentControlProposalId,
  AgentControlRequestId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type AgentControlProposalView,
} from "@ryco/contracts";
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (value: unknown) => [value, vi.fn()],
}));
vi.mock("react-native", () => ({ Pressable: "Pressable", View: "View" }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: vi.fn() }) }));
vi.mock("../../components/AppText", () => ({ AppText: "Text" }));
vi.mock("../../connection/environmentApi", () => ({ ensureEnvironmentApi: vi.fn(() => ({})) }));
vi.mock("./agentControlActions", () => ({
  acceptAgentControlProposal: vi.fn(async () => {}),
  rejectAgentControlProposal: vi.fn(async () => {}),
}));
import { AgentControlProposalCard } from "./AgentControlProposalCard";
import { acceptAgentControlProposal } from "./agentControlActions";

function elements(node: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, unknown>>;
  const children = element.props.children;
  return [element, ...(Array.isArray(children) ? children : [children]).flatMap(elements)];
}
const texts = (tree: ReactElement<Record<string, unknown>>[]) =>
  tree.flatMap((entry) => {
    const children = entry.props.children;
    return typeof children === "string" ? [children] : [];
  });

function proposal(plan: AgentControlProposalView["plan"]): AgentControlProposalView {
  return {
    proposalId: AgentControlProposalId.make("proposal-1"),
    requestId: AgentControlRequestId.make("request-1"),
    principal: {
      kind: "provider-session",
      threadId: ThreadId.make("thread-1"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    planVersion: 1,
    plan,
    planDigest: "a".repeat(64),
    riskTags: [],
    promptSummary: null,
    status: "pending-user-approval",
    createdAt: "2026-10-22T00:00:00.000Z",
    updatedAt: "2026-10-22T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    decidedAt: null,
    result: null,
  };
}
const render = (plan: AgentControlProposalView["plan"]) =>
  elements(
    AgentControlProposalCard({
      environmentId: EnvironmentId.make("env"),
      proposal: proposal(plan),
    }),
  );

it("native cards offer only Reject for a request this build cannot read", () => {
  const tree = render({ kind: "unsupported", originalKind: "mirrorRepository" });
  const labels = texts(tree);
  expect(labels).toContain("Update Ryco to review this request.");
  expect(labels).toContain("Reject");
  expect(labels).not.toContain("Approve");
});

it("native cards send a client-executed copy to a computer connected to its target", () => {
  const tree = render(
    Schema.decodeUnknownSync(AgentControlActionPlan)({
      kind: "copyProjectToNode",
      source: { kind: "repository", remoteUrl: "https://github.com/example/ryco", title: "ryco" },
      target: { environmentId: "env-mac-mini", label: "Mac mini" },
      destination: { kind: "default" },
      bringCommits: false,
      bringChanges: false,
      copySettings: false,
      setup: null,
      followUpThread: null,
    }),
  );
  const labels = texts(tree);
  expect(labels).toContain("Approve in Ryco on a computer connected to Mac mini");
  expect(labels).toContain("Reject");
  expect(labels).not.toContain("Approve");
  expect(acceptAgentControlProposal).not.toHaveBeenCalled();
});

it("native cards keep Approve for plans this app can decide", () => {
  const labels = texts(render({ kind: "interruptThread", threadId: ThreadId.make("thread-2") }));
  expect(labels).toContain("Approve");
  expect(labels).toContain("Reject");
});

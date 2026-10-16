import "../../index.css";

import { useAgentControlStore } from "@ryco/client-runtime/state/agentControl";
import {
  AgentControlProposal,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
  type ThreadLineage,
} from "@ryco/contracts";
import { Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { syncServerShellSnapshot, useStore } from "../../store";
import { DelegationDock } from "./DelegationDock";

const fixture = vi.hoisted(() => ({
  acceptProposal: vi.fn().mockResolvedValue(undefined),
  rejectProposal: vi.fn().mockResolvedValue(undefined),
  dispatchCommand: vi.fn().mockResolvedValue(undefined),
}));
const ENV = EnvironmentId.make("delegation-dock-env");
const PROJECT_ID = ProjectId.make("delegation-dock-project");
const COORDINATOR = ThreadId.make("coordinator");
const REVIEWER = ThreadId.make("reviewer");

const delegatedFrom = (parent: ThreadId, root: ThreadId = parent): ThreadLineage => ({
  parentThreadId: parent,
  rootThreadId: root,
  relationship: "delegated",
});

function shell(
  id: string,
  title: string,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  return {
    id: ThreadId.make(id),
    projectId: PROJECT_ID,
    title,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    goal: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function seed(threads: ReadonlyArray<OrchestrationThreadShell>) {
  const snapshot: OrchestrationShellSnapshot = {
    snapshotSequence: 1,
    projects: [
      {
        id: PROJECT_ID,
        title: "Project",
        workspaceRoot: "/repo",
        projectMetadataDir: ".ryco",
        defaultModelSelection: null,
        customAvatarContentHash: null,
        preferredRemoteName: null,
        scripts: [],
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
      },
    ],
    threads,
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
  useStore.setState(
    syncServerShellSnapshot({ activeEnvironmentId: ENV, environmentStateById: {} }, snapshot, ENV),
  );
}

function proposal(id: string, overrides: Record<string, unknown> = {}): AgentControlProposal {
  return Schema.decodeUnknownSync(AgentControlProposal)({
    proposalId: id,
    requestId: `request-${id}`,
    principal: { kind: "provider-session", threadId: COORDINATOR, providerInstanceId: "codex" },
    planVersion: 1,
    plan: {
      kind: "sendMessage",
      threadId: "first-worker",
      text: "Hidden message prompt",
      delivery: "queue",
    },
    planDigest: "a".repeat(64),
    riskTags: [],
    promptSummary: "Send a message",
    status: "completed",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:05.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    decidedAt: "2026-10-01T00:00:01.000Z",
    result: null,
    ...overrides,
  });
}

const completionReturn = (child: string, status: string) => ({
  revision: 1,
  childThreadId: child,
  initialMessageId: `initial-${child}`,
  parentThreadId: COORDINATOR,
  parentTurnId: "origin-turn",
  childTurnId: null,
  status,
  detail: `${status} detail`,
  updatedAt: "2026-10-01T00:00:05.000Z",
});

function seedQueue(active: ReadonlyArray<AgentControlProposal>) {
  useAgentControlStore.getState().applyStreamEvent(ENV, {
    version: 1,
    type: "snapshot",
    queue: { revision: 0, active: [...active], recent: [] },
  });
}

const workers = [
  shell("coordinator", "Coordinator"),
  shell("later-worker", "Later worker", {
    createdAt: "2026-10-01T00:00:05.000Z",
    lineage: delegatedFrom(COORDINATOR),
    hasPendingUserInput: true,
  }),
  shell("first-worker", "First worker", {
    createdAt: "2026-10-01T00:00:01.000Z",
    lineage: delegatedFrom(COORDINATOR),
    latestTurn: {
      turnId: TurnId.make("running"),
      state: "running",
      requestedAt: "2026-10-01T00:00:02.000Z",
      startedAt: "2026-10-01T00:00:02.000Z",
      completedAt: null,
      assistantMessageId: MessageId.make("first-reply"),
    },
  }),
  shell("grandchild", "Grandchild worker", {
    lineage: delegatedFrom(ThreadId.make("first-worker"), COORDINATOR),
  }),
];

const rowTitles = () =>
  [...document.querySelectorAll('[data-testid="delegation-dock"] button[aria-expanded] .truncate')]
    .map((node) => node.textContent)
    .filter(
      (text) => text === "First worker" || text === "Later worker" || text === "Grandchild worker",
    );

describe("DelegationDock", () => {
  beforeEach(() => {
    __setEnvironmentApiOverrideForTests(ENV, {
      agentControl: {
        acceptProposal: fixture.acceptProposal,
        rejectProposal: fixture.rejectProposal,
      },
      orchestration: { dispatchCommand: fixture.dispatchCommand },
    } as never);
  });
  afterEach(() => {
    __resetEnvironmentApiOverridesForTests();
    useStore.setState({ activeEnvironmentId: null, environmentStateById: {} });
    useAgentControlStore.getState().clearEnvironment(ENV);
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("renders nothing for a thread without delegation or Agent Control", async () => {
    seed([shell("coordinator", "Coordinator")]);
    const onPresenceChange = vi.fn();
    const mounted = await render(
      <DelegationDock
        environmentId={ENV}
        threadId={COORDINATOR}
        onPresenceChange={onPresenceChange}
      />,
    );
    try {
      expect(document.querySelector('[data-testid="delegation-dock"]')).toBeNull();
      expect(onPresenceChange).toHaveBeenLastCalledWith(false);
    } finally {
      await mounted.unmount();
    }
  });

  it("is one line until opened, then lists direct children in creation order", async () => {
    seed(workers);
    seedQueue([
      proposal("create", {
        completionReturns: [
          completionReturn("first-worker", "waiting"),
          completionReturn("later-worker", "delivered"),
        ],
      }),
    ]);
    const mounted = await render(<DelegationDock environmentId={ENV} threadId={COORDINATOR} />);
    try {
      const header = page.getByRole("button", { name: /2 delegated/ });
      await expect.element(header).toHaveAttribute("aria-expanded", "false");
      await expect
        .element(header)
        .toMatchTextContent(/2 delegated\s*1 working · 1 needs you · 1 of 2 returned/);
      expect(rowTitles()).toEqual([]);

      await header.click();
      await expect.element(header).toHaveAttribute("aria-expanded", "true");
      // Direct children only (spec D8): the grandchild belongs to its own parent's dock.
      expect(rowTitles()).toEqual(["First worker", "Later worker"]);
      await expect.element(page.getByText("Result pending")).toBeVisible();
      await expect.element(page.getByText("Returned", { exact: true })).toBeVisible();
      await expect.element(page.getByText("Needs your answer").first()).toBeVisible();
      await expect.element(page.getByText(/Agent Control activity · 1/)).toBeVisible();
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps a pending approval actionable on one line with its full card behind Details", async () => {
    seed([shell("coordinator", "Coordinator")]);
    const pending = proposal("remove", {
      status: "pending-user-approval",
      decidedAt: null,
      plan: {
        kind: "removeProject",
        projectId: "project-1",
        expected: {
          title: "Project one",
          workspaceRoot: "/workspace/project-one",
          repositoryIdentityKey: null,
          updatedAt: "2026-10-01T00:00:00.000Z",
        },
        expectedThreadIds: [],
        force: false,
      },
      riskTags: ["removes-project"],
      promptSummary: "Unlink the old project",
    });
    seedQueue([pending]);
    const mounted = await render(<DelegationDock environmentId={ENV} threadId={COORDINATOR} />);
    try {
      const row = page.getByTestId("delegation-dock-approval");
      await expect.element(row).toMatchTextContent(/Unlink project.*Destructive/);
      await expect.element(page.getByTestId("agent-control-proposal-card")).not.toBeInTheDocument();
      await page.getByRole("button", { name: "Details" }).click();
      await expect.element(page.getByTestId("agent-control-proposal-card")).toBeVisible();
      await expect.element(page.getByText("Destructive · Ryco records only")).toBeVisible();
      // One decision set: the card's own buttons stay hidden in the dock.
      expect(page.getByRole("button", { name: "Approve", exact: true }).elements()).toHaveLength(1);
      await page.getByRole("button", { name: "Approve", exact: true }).click();
      expect(fixture.acceptProposal).toHaveBeenCalledWith({ proposalId: "remove" });

      seedQueue([{ ...pending, status: "approved", decidedAt: "2026-10-01T00:00:06.000Z" }]);
      await expect.element(page.getByText(/You approved Unlink project/)).toBeVisible();
      await expect.element(page.getByTestId("delegation-dock-approval")).not.toBeInTheDocument();
    } finally {
      await mounted.unmount();
    }
  });

  it("tells a delegated thread who created and who manages it", async () => {
    const child = ThreadId.make("child");
    seed([
      shell("coordinator", "Coordinator"),
      shell("reviewer", "Reviewer"),
      shell("child", "Clarify size metrics", { lineage: delegatedFrom(COORDINATOR) }),
      shell("sibling", "Count lines", { lineage: delegatedFrom(COORDINATOR) }),
    ]);
    seedQueue([
      proposal("create", { completionReturns: [completionReturn("child", "waiting")] }),
      proposal("steer", {
        principal: { kind: "provider-session", threadId: REVIEWER, providerInstanceId: "codex" },
        plan: { kind: "sendMessage", threadId: "child", text: "Hidden", delivery: "steer" },
        decidedAt: "2026-10-01T00:00:09.000Z",
      }),
    ]);
    const mounted = await render(<DelegationDock environmentId={ENV} threadId={child} />);
    try {
      const origin = page.getByRole("button", { name: /Delegated from/ });
      await expect
        .element(origin)
        .toMatchTextContent(
          /Delegated from\s*Coordinator\s*·\s*Managed by\s*Reviewer\s*· result returns when you finish/,
        );
      await origin.click();
      await expect
        .element(page.getByRole("link", { name: "Open Coordinator ↗" }))
        .toHaveAttribute("href", "/delegation-dock-env/coordinator");
      await expect.element(page.getByText(/1 sibling thread/)).toBeVisible();
    } finally {
      await mounted.unmount();
    }
  });

  it("previews a child's reply and answers its question for the child's own thread", async () => {
    seed(workers);
    useStore.setState((state) => {
      const environmentState = state.environmentStateById[ENV]!;
      return {
        environmentStateById: {
          ...state.environmentStateById,
          [ENV]: {
            ...environmentState,
            messageIdsByThreadId: {
              ...environmentState.messageIdsByThreadId,
              [ThreadId.make("first-worker")]: [MessageId.make("first-reply")],
            },
            messageByThreadId: {
              ...environmentState.messageByThreadId,
              [ThreadId.make("first-worker")]: {
                [MessageId.make("first-reply")]: {
                  id: MessageId.make("first-reply"),
                  role: "assistant",
                  text: "Walking 214 import edges across apps/ and packages/.",
                  createdAt: "2026-10-01T00:00:03.000Z",
                  streaming: true,
                },
              } as never,
            },
            activityIdsByThreadId: {
              ...environmentState.activityIdsByThreadId,
              [ThreadId.make("later-worker")]: ["question"],
            },
            activityByThreadId: {
              ...environmentState.activityByThreadId,
              [ThreadId.make("later-worker")]: {
                question: {
                  id: EventId.make("question"),
                  tone: "info",
                  kind: "user-input.requested",
                  summary: "Question",
                  payload: {
                    requestId: "size-question",
                    questions: [
                      {
                        id: "scope",
                        header: "Scope",
                        question: "Should size include generated files?",
                        options: [
                          { label: "Source only", description: "Skip generated files" },
                          { label: "Everything", description: "Count all files" },
                        ],
                      },
                    ],
                  },
                  turnId: null,
                  createdAt: "2026-10-01T00:00:06.000Z",
                },
              },
            },
          },
        },
      };
    });
    // The dock lives inside the composer's form: answering must never submit it.
    const composerSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    const mounted = await render(
      <form onSubmit={composerSubmit}>
        <DelegationDock environmentId={ENV} threadId={COORDINATOR} />
      </form>,
    );
    try {
      expect(document.querySelectorAll("form form")).toHaveLength(0);
      await page.getByRole("button", { name: /2 delegated/ }).click();
      const firstRow = page.getByRole("button", { name: /First worker/ });
      await firstRow.click();
      await expect
        .element(page.getByText("Walking 214 import edges across apps/ and packages/."))
        .toBeVisible();
      await firstRow.click();
      await expect.element(page.getByTestId("delegation-dock-peek")).not.toBeInTheDocument();

      await page.getByRole("button", { name: /Later worker/ }).click();
      await expect.element(page.getByText("Should size include generated files?")).toBeVisible();
      await page.getByRole("button", { name: "Source only" }).click();
      expect(document.querySelectorAll("form form")).toHaveLength(0);
      await page.getByRole("textbox", { name: /^Answer:/ }).click();
      await userEvent.keyboard("{Enter}");
      await vi.waitFor(() => expect(fixture.dispatchCommand).toHaveBeenCalled());
      expect(composerSubmit).not.toHaveBeenCalled();
      expect(fixture.dispatchCommand.mock.calls[0]?.[0]).toMatchObject({
        type: "thread.user-input.respond",
        threadId: "later-worker",
        requestId: "size-question",
        answers: { scope: "Source only" },
      });
    } finally {
      await mounted.unmount();
    }
  });
});

import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ClientOrchestrationCommand,
  type EnvironmentApi,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildImplementationThreadCreate,
  buildImplementPlanTurn,
  implementPlanHere,
  implementPlanInNewThread,
  planMarkdownExport,
  resolvePlanSavePath,
  type PlanSource,
} from "./proposedPlanActions";

const plan: PlanSource = {
  threadId: ThreadId.make("thread-plan"),
  planId: "plan-1",
  planMarkdown: "# Add goals to the phone\n\n- Parse /goal\n- Show it in the sheet\n",
};
const settings = {
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
  runtimeMode: "full-access" as const,
  tokenMode: "balanced" as const,
};

function ids() {
  let next = 0;
  return {
    newCommandId: () => CommandId.make(`command-${++next}`),
    newMessageId: () => MessageId.make(`message-${next}`),
  };
}

describe("proposed plan actions", () => {
  it("implements a plan in build mode, naming the plan it implements", () => {
    const turn = buildImplementPlanTurn({
      plan,
      threadId: plan.threadId,
      titleSeed: "Goals",
      settings,
      commandId: CommandId.make("command-turn"),
      messageId: MessageId.make("message-turn"),
      createdAt: "2026-11-09T02:00:00.000Z",
    });
    expect(turn).toMatchObject({
      type: "thread.turn.start",
      threadId: plan.threadId,
      interactionMode: "default",
      sourceProposedPlan: { threadId: plan.threadId, planId: "plan-1" },
    });
    expect(turn.message.text.startsWith("PLEASE IMPLEMENT THIS PLAN:\n# Add goals")).toBe(true);
  });

  it("switches a chat in plan mode to build mode before it implements the plan", async () => {
    const sent: ClientOrchestrationCommand[] = [];
    const api = {
      orchestration: {
        dispatchCommand: async (command: ClientOrchestrationCommand) => {
          sent.push(command);
          return { sequence: 1 };
        },
      },
    } as unknown as EnvironmentApi;
    await implementPlanHere({
      api,
      plan,
      titleSeed: "Goals",
      interactionMode: "plan",
      setInteractionMode: async (mode) => {
        sent.push({
          type: "thread.interaction-mode.set",
          interactionMode: mode,
        } as unknown as ClientOrchestrationCommand);
      },
      settings,
      ids: ids(),
    });
    expect(sent.map((command) => command.type)).toEqual([
      "thread.interaction-mode.set",
      "thread.turn.start",
    ]);
    expect(sent[0]).toMatchObject({ interactionMode: "default" });

    sent.length = 0;
    await implementPlanHere({
      api,
      plan,
      titleSeed: "Goals",
      interactionMode: "default",
      setInteractionMode: () => Promise.reject(new Error("not called")),
      settings,
      ids: ids(),
    });
    expect(sent.map((command) => command.type)).toEqual(["thread.turn.start"]);
  });

  it("titles the new chat after the plan and keeps its checkout", () => {
    const create = buildImplementationThreadCreate({
      plan,
      threadId: ThreadId.make("thread-new"),
      projectId: ProjectId.make("project"),
      branch: "feat/goals",
      worktreePath: "/code/ryco-goals",
      settings,
      commandId: CommandId.make("command-create"),
      createdAt: "2026-11-09T02:00:00.000Z",
    });
    expect(create).toMatchObject({
      title: "Implement Add goals to the phone",
      branch: "feat/goals",
      worktreePath: "/code/ryco-goals",
      interactionMode: "default",
    });
  });

  it("removes the new chat again when its turn does not start", async () => {
    const sent: ClientOrchestrationCommand[] = [];
    const api = {
      orchestration: {
        dispatchCommand: async (command: ClientOrchestrationCommand) => {
          sent.push(command);
          if (command.type === "thread.turn.start") throw new Error("refused");
          return { sequence: 1 };
        },
      },
    } as unknown as EnvironmentApi;
    await expect(
      implementPlanInNewThread({
        api,
        plan,
        newThreadId: ThreadId.make("thread-new"),
        projectId: ProjectId.make("project"),
        branch: null,
        worktreePath: null,
        settings,
        ids: ids(),
      }),
    ).rejects.toThrow("refused");
    expect(sent.map((command) => command.type)).toEqual([
      "thread.create",
      "thread.turn.start",
      "thread.delete",
    ]);
  });

  it("exports the plan as Markdown and saves it only inside the checkout", () => {
    expect(planMarkdownExport(plan.planMarkdown)).toEqual({
      filename: "add-goals-to-the-phone.md",
      contents: `${plan.planMarkdown.trimEnd()}\n`,
    });
    expect(resolvePlanSavePath(" docs/plans/goals.md ")).toBe("docs/plans/goals.md");
    expect(resolvePlanSavePath("./goals.md")).toBe("goals.md");
    expect(resolvePlanSavePath("/etc/goals.md")).toBeNull();
    expect(resolvePlanSavePath("../goals.md")).toBeNull();
    expect(resolvePlanSavePath("C:\\goals.md")).toBeNull();
    expect(resolvePlanSavePath("   ")).toBeNull();
  });
});

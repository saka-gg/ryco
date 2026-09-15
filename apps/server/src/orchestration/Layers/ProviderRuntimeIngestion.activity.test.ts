import {
  EventId,
  ProviderDriverKind,
  RuntimeTaskId,
  RuntimeSessionId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { runtimeEventToActivities } from "./ProviderRuntimeIngestion.ts";

const base = {
  provider: ProviderDriverKind.make("codex"),
  createdAt: "2026-08-06T00:00:00.000Z",
  threadId: ThreadId.make("thread-1"),
};

describe("runtimeEventToActivities task progress", () => {
  it("persists usage independently from replaceable activity", () => {
    const taskId = RuntimeTaskId.make("agent-1");
    const usageOnly = {
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-usage"),
      payload: {
        taskId,
        description: "Agent one",
        typedUsage: { totalTokens: 73_700_000 },
      },
    } satisfies ProviderRuntimeEvent;
    const command = {
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-command"),
      payload: {
        taskId,
        description: "Agent one",
        summary: "Running tests",
        lastToolName: "exec_command",
      },
    } satisfies ProviderRuntimeEvent;

    const usageActivities = runtimeEventToActivities(usageOnly);
    const commandActivities = runtimeEventToActivities(command);

    expect(usageActivities.map((activity) => activity.id)).toEqual(["task-usage:thread-1:agent-1"]);
    expect(commandActivities.map((activity) => activity.id)).toEqual([
      "task-progress:thread-1:agent-1",
    ]);
    const usagePayload = usageActivities[0]?.payload as Record<string, unknown> | undefined;
    expect(usagePayload?.typedUsage).toEqual({ totalTokens: 73_700_000 });
    expect(usagePayload?.usageSnapshot).toBe(true);
  });

  it("splits combined progress and usage into independent snapshots", () => {
    const event = {
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-combined"),
      payload: {
        taskId: RuntimeTaskId.make("agent-2"),
        taskType: "local_agent",
        role: "reviewer",
        description: "Agent two",
        summary: "Inspecting the panel",
        typedUsage: { totalTokens: 4_200, toolUses: 7 },
        status: "running",
      },
    } satisfies ProviderRuntimeEvent;

    const activities = runtimeEventToActivities(event);
    const progressPayload = activities[0]?.payload as Record<string, unknown>;
    const usagePayload = activities[1]?.payload as Record<string, unknown>;

    expect(activities.map((activity) => activity.id)).toEqual([
      "task-progress:thread-1:agent-2",
      "task-usage:thread-1:agent-2",
    ]);
    expect(progressPayload.summary).toBe("Inspecting the panel");
    expect(progressPayload.status).toBe("running");
    expect(progressPayload.role).toBe("reviewer");
    expect(progressPayload.agentKind).toBe("agent");
    expect(progressPayload).not.toHaveProperty("typedUsage");
    expect(usagePayload.typedUsage).toEqual({ totalTokens: 4_200, toolUses: 7 });
    expect(usagePayload.usageSnapshot).toBe(true);
    expect(usagePayload.role).toBe("reviewer");
    expect(usagePayload.agentKind).toBe("agent");
    expect(usagePayload).not.toHaveProperty("status");
  });
});

describe("runtimeEventToActivities tool streaming persistence", () => {
  const accumulatedStdout = (lineCount: number) =>
    [
      "first line of output",
      ...Array.from({ length: lineCount }, (_, index) => `Capturing frame ${index}/9028`),
    ].join("\n");

  const streamingData = (lineCount: number) => {
    const stdout = accumulatedStdout(lineCount);
    return {
      toolCallId: "tool-call-1",
      kind: "execute",
      command: "blender --render",
      rawOutput: { stdout },
      content: [{ type: "content", content: { type: "text", text: stdout } }],
    };
  };

  it("keeps cumulative tool.updated payloads bounded as output grows", () => {
    const projectedPayloads = [50, 500, 2_000].map((lineCount, index) => {
      const event = {
        ...base,
        type: "item.updated",
        eventId: EventId.make(`evt-tool-streaming-updated-${index}`),
        payload: {
          itemType: "command_execution",
          status: "inProgress",
          title: "Render",
          detail: accumulatedStdout(lineCount),
          data: streamingData(lineCount),
        },
      } satisfies ProviderRuntimeEvent;

      const activities = runtimeEventToActivities(event);
      expect(activities).toHaveLength(1);
      return activities[0]?.payload as Record<string, unknown>;
    });

    for (const payload of projectedPayloads) {
      const data = payload.data as Record<string, unknown>;
      expect(payload.status).toBe("inProgress");
      expect(data.toolCallId).toBe("tool-call-1");
      expect(data.kind).toBe("execute");
      expect(data.command).toBe("blender --render");
      expect(data.rawOutput).toEqual({ content: "first line of output" });
      expect(data.content).toBeUndefined();
      expect(JSON.stringify(payload).length).toBeLessThan(1_000);
    }
  });

  it("persists tool.completed data with oversized strings capped to head and tail", () => {
    const data = streamingData(2_000);
    const event = {
      ...base,
      type: "item.completed",
      eventId: EventId.make("evt-tool-streaming-completed"),
      payload: {
        itemType: "command_execution",
        status: "completed",
        title: "Render",
        data,
      },
    } satisfies ProviderRuntimeEvent;

    const activities = runtimeEventToActivities(event);

    expect(activities).toHaveLength(1);
    const payload = activities[0]?.payload as Record<string, unknown>;
    // Structure is preserved so client folds keep working, but every string
    // is bounded: completed rows are persisted forever in the event log and
    // the activity projection, so unbounded terminal output is elided to a
    // head + tail around a truncation marker.
    const cappedData = payload.data as {
      rawOutput: { stdout: string };
      content: Array<{ content: { text: string } }>;
    };
    expect(Object.keys(cappedData)).toEqual(Object.keys(data));
    const stdout = cappedData.rawOutput.stdout;
    expect(stdout.length).toBeLessThan(20_000);
    expect(stdout.startsWith("first line of output")).toBe(true);
    expect(stdout).toContain("chars truncated");
    expect(stdout.trimEnd().endsWith("Capturing frame 1999/9028")).toBe(true);
    expect(cappedData.content[0]!.content.text).toContain("chars truncated");
  });
});

describe("background work projection", () => {
  it("preserves explicit background state, stop capability and runtime identity", () => {
    const [row] = runtimeEventToActivities({
      ...base,
      type: "task.started",
      eventId: EventId.make("background-start"),
      runtimeSessionId: RuntimeSessionId.make("epoch"),
      payload: {
        taskId: RuntimeTaskId.make("bash"),
        taskType: "local_bash",
        isBackgrounded: true,
        canStop: true,
      },
    });
    expect(row?.payload).toMatchObject({
      agentKind: "background",
      isBackgrounded: true,
      canStop: true,
      runtimeSessionId: "epoch",
    });
    const [foreground] = runtimeEventToActivities({
      ...base,
      type: "task.updated",
      eventId: EventId.make("foreground"),
      payload: {
        taskId: RuntimeTaskId.make("bash"),
        taskType: "local_bash",
        isBackgrounded: false,
      },
    });
    expect(foreground?.payload).toMatchObject({ isBackgrounded: false });
  });
  it("persists real process boundaries without settling background work on ready or turn completion", () => {
    for (const event of [
      { type: "session.started", payload: { message: "Started" } },
      { type: "session.exited", payload: { exitKind: "graceful" } },
      { type: "session.state.changed", payload: { state: "stopped" } },
    ] as const) {
      expect(
        runtimeEventToActivities({
          ...base,
          ...event,
          eventId: EventId.make(event.type),
        } satisfies ProviderRuntimeEvent)[0]?.kind,
      ).toBe("background-work.session-boundary");
    }
    expect(
      runtimeEventToActivities({
        ...base,
        type: "session.state.changed",
        eventId: EventId.make("ready"),
        payload: { state: "ready" },
      }),
    ).toEqual([]);
  });
});

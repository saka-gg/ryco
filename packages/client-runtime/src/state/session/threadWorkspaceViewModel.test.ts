import { EventId, TurnId, type OrchestrationThreadActivity } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveAgentTimeline } from "./agentActivity";
import { deriveWorkLogEntries } from "./session-logic";
import { deriveThreadSubagents, findThreadSubagent } from "./threadWorkspaceViewModel";

function makeActivity(overrides: {
  id?: string;
  createdAt?: string;
  kind?: string;
  summary?: string;
  tone?: OrchestrationThreadActivity["tone"];
  payload?: Record<string, unknown>;
  turnId?: string;
  sequence?: number;
}): OrchestrationThreadActivity {
  return {
    id: EventId.make(overrides.id ?? crypto.randomUUID()),
    createdAt: overrides.createdAt ?? "2026-06-04T10:00:00.000Z",
    kind: overrides.kind ?? "tool.started",
    summary: overrides.summary ?? "Subagent task",
    tone: overrides.tone ?? "tool",
    payload: overrides.payload ?? {},
    turnId: overrides.turnId ? TurnId.make(overrides.turnId) : null,
    ...(overrides.sequence !== undefined ? { sequence: overrides.sequence } : {}),
  };
}

describe("deriveThreadSubagents", () => {
  it("groups subagent lifecycle activities, infers a role, and assigns a codename", () => {
    const activities = [
      makeActivity({
        id: "agent-start",
        kind: "tool.started",
        createdAt: "2026-06-04T10:00:00.000Z",
        payload: {
          itemType: "collab_agent_tool_call",
          status: "inProgress",
          title: "Subagent task",
          detail: "Hilbert: inspect the retry flow",
        },
      }),
      makeActivity({
        id: "agent-done",
        kind: "tool.completed",
        createdAt: "2026-06-04T10:00:03.000Z",
        payload: {
          itemType: "collab_agent_tool_call",
          status: "completed",
          title: "Subagent task",
          detail: "Hilbert: inspect the retry flow",
        },
      }),
    ];

    const subagents = deriveThreadSubagents(activities);
    expect(subagents).toHaveLength(1);
    expect(subagents[0]).toMatchObject({
      role: "Hilbert",
      status: "finished",
      detail: "Hilbert: inspect the retry flow",
    });
    // The primary name is always an abstract codename, never the inferred role.
    expect(subagents[0]?.name).toMatch(/^[A-Z][A-Za-z]+( \d+)?$/);
    expect(subagents[0]?.name).not.toBe("Hilbert");
  });

  it("uses structured subagent metadata when available", () => {
    const activities = [
      makeActivity({
        id: "agent-start",
        kind: "tool.started",
        payload: {
          itemType: "collab_agent_tool_call",
          status: "inProgress",
          title: "Subagent task",
          detail: "Find failing checks",
          data: {
            input: {
              subagent_type: "code-reviewer",
              description: "Find failing checks",
            },
          },
        },
      }),
    ];

    expect(deriveThreadSubagents(activities)[0]).toMatchObject({
      role: "Code Reviewer",
      status: "running",
      detail: "Find failing checks",
    });
  });

  it("uses Codex collab metadata and attaches child agent messages", () => {
    const activities = [
      makeActivity({
        id: "agent-start",
        kind: "tool.started",
        createdAt: "2026-06-04T10:00:00.000Z",
        payload: {
          itemType: "collab_agent_tool_call",
          status: "inProgress",
          providerItemId: "collab-1",
          data: {
            item: {
              type: "collabAgentToolCall",
              id: "collab-1",
              tool: "spawnAgent",
              prompt: "You are a researcher. Inspect the retry flow.",
              receiverThreadIds: ["child-thread-1"],
              senderThreadId: "parent-thread",
              status: "inProgress",
              agentsStates: {
                "child-thread-1": {
                  status: "running",
                  message: "Inspecting retry paths",
                },
              },
            },
          },
        },
      }),
      makeActivity({
        id: "child-message",
        kind: "agent.message",
        createdAt: "2026-06-04T10:00:04.000Z",
        payload: {
          itemType: "assistant_message",
          providerThreadId: "child-thread-1",
          providerItemId: "msg-child-1",
          text: "The retry flow drops partial stream state.",
        },
      }),
    ];

    expect(deriveThreadSubagents(activities)[0]).toMatchObject({
      key: "subagent:collab-1",
      role: "Researcher",
      status: "running",
      tool: "spawnAgent",
      detail: "You are a researcher. Inspect the retry flow.",
      providerThreadIds: ["child-thread-1"],
      messages: [
        {
          id: "agent-start:child-thread-1",
          text: "Inspecting retry paths",
          providerThreadId: "child-thread-1",
        },
        {
          id: "msg-child-1",
          text: "The retry flow drops partial stream state.",
          providerThreadId: "child-thread-1",
        },
      ],
    });
  });

  it("projects Codex spawn/wait events as one labeled child, not tool-call duplicates", () => {
    const spawnRows = [
      makeActivity({
        id: "spawn-start",
        kind: "tool.started",
        createdAt: "2026-06-04T10:00:00.000Z",
        payload: {
          itemType: "collab_agent_tool_call",
          status: "inProgress",
          providerItemId: "call-explorer",
          detail: "Role: explorer.\nTask: Inspect the provider event path.",
          data: {
            item: {
              type: "collabAgentToolCall",
              id: "call-explorer",
              tool: "spawnAgent",
              prompt: "Role: explorer.\nTask: Inspect the provider event path.",
              receiverThreadIds: [],
              status: "inProgress",
              agentsStates: {},
            },
          },
        },
      }),
      makeActivity({
        id: "spawn-complete",
        kind: "tool.completed",
        createdAt: "2026-06-04T10:00:01.000Z",
        payload: {
          itemType: "collab_agent_tool_call",
          status: "completed",
          providerItemId: "call-explorer",
          detail: "Role: explorer.\nTask: Inspect the provider event path.",
          data: {
            item: {
              type: "collabAgentToolCall",
              id: "call-explorer",
              tool: "spawnAgent",
              prompt: "Role: explorer.\nTask: Inspect the provider event path.",
              receiverThreadIds: ["child-explorer"],
              status: "completed",
              agentsStates: {
                "child-explorer": { status: "pendingInit", message: null },
              },
            },
          },
        },
      }),
    ];

    expect(deriveThreadSubagents(spawnRows)).toMatchObject([
      {
        key: "subagent:call-explorer",
        role: "Explorer",
        status: "running",
        tool: "spawnAgent",
        detail: "Inspect the provider event path.",
        providerThreadIds: ["child-explorer"],
        entries: [{ id: "spawn-complete" }],
      },
    ]);

    const coordinated = deriveThreadSubagents([
      ...spawnRows,
      makeActivity({
        id: "wait-start",
        kind: "tool.started",
        createdAt: "2026-06-04T10:00:02.000Z",
        payload: {
          itemType: "collab_agent_tool_call",
          status: "inProgress",
          providerItemId: "call-wait",
          data: {
            item: {
              type: "collabAgentToolCall",
              id: "call-wait",
              tool: "wait",
              prompt: null,
              receiverThreadIds: ["child-explorer"],
              status: "inProgress",
              agentsStates: {},
            },
          },
        },
      }),
      makeActivity({
        id: "wait-complete",
        kind: "tool.completed",
        createdAt: "2026-06-04T10:00:05.000Z",
        payload: {
          itemType: "collab_agent_tool_call",
          status: "completed",
          providerItemId: "call-wait",
          data: {
            item: {
              type: "collabAgentToolCall",
              id: "call-wait",
              tool: "wait",
              prompt: null,
              receiverThreadIds: ["child-explorer"],
              status: "completed",
              agentsStates: {
                "child-explorer": {
                  status: "completed",
                  message: "The event path is stable.",
                },
              },
            },
          },
        },
      }),
    ]);

    expect(coordinated).toHaveLength(1);
    expect(coordinated[0]).toMatchObject({
      key: "subagent:call-explorer",
      role: "Explorer",
      status: "finished",
      messages: [
        {
          id: "wait-complete:child-explorer",
          text: "The event path is stable.",
          providerThreadId: "child-explorer",
        },
      ],
    });
  });

  it("does not resurrect a transcript-only child after its parent turn is interrupted", () => {
    const activities = [
      makeActivity({
        id: "orphaned-spawn",
        kind: "tool.started",
        payload: {
          itemType: "collab_agent_tool_call",
          status: "inProgress",
          providerItemId: "call-orphaned",
          detail: "Role: verifier.\nTask: Check reconnect behavior.",
        },
      }),
    ];

    expect(deriveThreadSubagents(activities)[0]?.status).toBe("running");
    expect(
      deriveThreadSubagents(activities, {
        sessionLive: true,
        parentTurnState: "interrupted",
      })[0]?.status,
    ).toBe("interrupted");
  });

  it("groups canonical subagent lifecycle activities and attaches message deltas", () => {
    const activities = [
      makeActivity({
        id: "subagent-start",
        kind: "subagent.started",
        createdAt: "2026-06-04T10:00:00.000Z",
        payload: {
          itemType: "subagent",
          subagent: {
            subagentId: "managed-1",
            origin: "native",
            capability: "transcript",
            label: "Cache Inspector",
            description: "Inspect the cache eviction path.",
            providerThreadId: "provider-child-1",
            providerSessionId: "session-child-1",
          },
          status: "running",
        },
      }),
      makeActivity({
        id: "subagent-progress",
        kind: "subagent.updated",
        createdAt: "2026-06-04T10:00:03.000Z",
        payload: {
          itemType: "subagent",
          subagent: {
            subagentId: "managed-1",
            origin: "native",
            capability: "transcript",
          },
          status: "running",
          summary: "Reading cache invalidation code.",
          lastToolName: "read",
        },
      }),
      makeActivity({
        id: "subagent-message",
        kind: "subagent.message.delta",
        createdAt: "2026-06-04T10:00:04.000Z",
        payload: {
          subagentId: "managed-1",
          providerThreadId: "provider-child-1",
          providerItemId: "message-1",
          text: "The eviction path skips stale keys.",
        },
      }),
      makeActivity({
        id: "subagent-complete",
        kind: "subagent.completed",
        createdAt: "2026-06-04T10:00:05.000Z",
        payload: {
          itemType: "subagent",
          subagent: {
            subagentId: "managed-1",
            origin: "native",
            capability: "transcript",
          },
          status: "completed",
          summary: "Found stale-key eviction risk.",
        },
      }),
    ];

    expect(deriveThreadSubagents(activities)[0]).toMatchObject({
      key: "subagent:managed-1",
      role: "Cache Inspector",
      status: "finished",
      origin: "native",
      capability: "transcript",
      tool: "read",
      detail: "Found stale-key eviction risk.",
      providerThreadIds: ["provider-child-1"],
      providerSessionIds: ["session-child-1"],
      messages: [
        {
          id: "message-1",
          text: "The eviction path skips stale keys.",
          providerThreadId: "provider-child-1",
        },
      ],
    });
  });

  it("uses canonical provider-neutral subagent metadata and messages", () => {
    const activities = [
      makeActivity({
        id: "subagent-started",
        kind: "subagent.started",
        createdAt: "2026-06-04T10:00:00.000Z",
        payload: {
          itemType: "collab_agent_tool_call",
          status: "running",
          subagent: {
            subagentId: "opencode:session:child-1",
            origin: "native",
            capability: "transcript",
            label: "OpenCode reviewer",
            model: "openai/gpt-5.4",
            effort: "high",
            providerThreadId: "child-1",
            providerSessionId: "child-1",
          },
        },
      }),
      makeActivity({
        id: "subagent-message",
        kind: "agent.message",
        createdAt: "2026-06-04T10:00:04.000Z",
        payload: {
          itemType: "assistant_message",
          subagentId: "opencode:session:child-1",
          providerThreadId: "child-1",
          providerItemId: "message-1",
          text: "The retry flow drops partial stream state.",
        },
      }),
      makeActivity({
        id: "subagent-completed",
        kind: "subagent.completed",
        createdAt: "2026-06-04T10:00:05.000Z",
        payload: {
          itemType: "collab_agent_tool_call",
          status: "completed",
          subagent: {
            subagentId: "opencode:session:child-1",
            origin: "native",
            capability: "transcript",
            label: "OpenCode reviewer",
            providerThreadId: "child-1",
            providerSessionId: "child-1",
          },
        },
      }),
    ];

    expect(deriveThreadSubagents(activities)[0]).toMatchObject({
      key: "subagent:opencode:session:child-1",
      role: "OpenCode Reviewer",
      status: "finished",
      origin: "native",
      capability: "transcript",
      model: "openai/gpt-5.4",
      effort: "high",
      providerThreadIds: ["child-1"],
      providerSessionIds: ["child-1"],
      messages: [
        {
          id: "message-1",
          text: "The retry flow drops partial stream state.",
          providerThreadId: "child-1",
        },
      ],
    });
  });

  it("builds persistent transcript tabs from native task activities", () => {
    const activities = [
      makeActivity({
        id: "task-start",
        kind: "task.started",
        createdAt: "2026-06-04T10:00:00.000Z",
        payload: {
          taskId: "native-agent-1",
          agentKind: "agent",
          role: "code-reviewer",
          title: "Review reconnect handling",
          detail: "Inspect session recovery and queued turns",
          status: "running",
        },
      }),
      makeActivity({
        id: "task-usage",
        kind: "task.progress",
        createdAt: "2026-06-04T10:00:02.000Z",
        summary: "Task usage updated",
        payload: {
          taskId: "native-agent-1",
          agentKind: "agent",
          role: "code-reviewer",
          usageSnapshot: true,
          typedUsage: { totalTokens: 900 },
        },
      }),
      makeActivity({
        id: "task-complete",
        kind: "task.completed",
        createdAt: "2026-06-04T10:00:04.000Z",
        payload: {
          taskId: "native-agent-1",
          agentKind: "agent",
          status: "completed",
          summary: "Reconnect path verified",
        },
      }),
      makeActivity({
        id: "task-late-progress",
        kind: "task.progress",
        createdAt: "2026-06-04T10:00:05.000Z",
        payload: {
          taskId: "native-agent-1",
          agentKind: "agent",
          status: "running",
          summary: "Late replayed progress",
        },
      }),
    ];

    const [subagent] = deriveThreadSubagents(activities);
    expect(subagent).toMatchObject({
      key: "subagent:native-agent-1",
      role: "Code Reviewer",
      status: "finished",
      detail: "Late replayed progress",
    });
    expect(subagent?.name).toMatch(/^[A-Z][A-Za-z]+( \d+)?$/);
  });

  it("recovers a running transcript tab from a retained native usage snapshot", () => {
    const [subagent] = deriveThreadSubagents([
      makeActivity({
        id: "retained-task-usage",
        kind: "task.progress",
        payload: {
          taskId: "retained-agent",
          taskType: "local_agent",
          agentKind: "agent",
          role: "verifier",
          usageSnapshot: true,
          typedUsage: { totalTokens: 1_200 },
        },
      }),
    ]);

    expect(subagent).toMatchObject({
      key: "subagent:retained-agent",
      role: "Verifier",
      status: "running",
    });
  });

  it("does not attach unrelated agent messages to a subagent", () => {
    const activities = [
      makeActivity({
        id: "agent-start",
        kind: "tool.started",
        payload: {
          itemType: "collab_agent_tool_call",
          data: {
            item: {
              type: "collabAgentToolCall",
              id: "collab-1",
              tool: "spawnAgent",
              prompt: "Investigate failures",
              receiverThreadIds: ["child-thread-1"],
              senderThreadId: "parent-thread",
              status: "completed",
              agentsStates: {},
            },
          },
        },
      }),
      makeActivity({
        id: "main-message",
        kind: "agent.message",
        payload: {
          itemType: "assistant_message",
          providerThreadId: "parent-thread",
          providerItemId: "msg-main",
          text: "Main assistant answer.",
        },
      }),
    ];

    expect(deriveThreadSubagents(activities)[0]?.messages).toEqual([]);
  });

  it("keeps the child running when only the Codex spawn tool has completed", () => {
    const activities = [
      makeActivity({
        id: "agent-done",
        kind: "tool.completed",
        payload: {
          itemType: "collab_agent_tool_call",
          status: "completed",
          data: {
            item: {
              type: "collabAgentToolCall",
              id: "collab-1",
              tool: "spawnAgent",
              prompt: "You are a researcher. Inspect the retry flow.",
              receiverThreadIds: ["child-thread-1"],
              status: "inProgress",
              agentsStates: {
                "child-thread-1": {
                  status: "running",
                },
              },
            },
          },
        },
      }),
    ];

    expect(deriveThreadSubagents(activities)[0]).toMatchObject({
      status: "running",
    });
  });

  it("attaches collapsed work-log entries back to lifecycle rows", () => {
    const activities = [
      makeActivity({
        id: "agent-start",
        kind: "tool.started",
        createdAt: "2026-06-04T10:00:00.000Z",
        payload: {
          itemType: "collab_agent_tool_call",
          status: "inProgress",
          detail: "Hilbert: inspect the retry flow",
          data: {
            toolCallId: "toolu-1",
          },
        },
      }),
      makeActivity({
        id: "agent-done",
        kind: "tool.completed",
        createdAt: "2026-06-04T10:00:05.000Z",
        payload: {
          itemType: "collab_agent_tool_call",
          status: "completed",
          detail: "Hilbert: inspect the retry flow",
          data: {
            toolCallId: "toolu-1",
          },
        },
      }),
    ];

    const [subagent] = deriveThreadSubagents(activities);

    expect(subagent?.entries).toHaveLength(1);
    expect(subagent?.entries[0]?.detail).toBe("Hilbert: inspect the retry flow");
  });

  it("assigns stable, unique abstract codenames when no role can be inferred", () => {
    const activities = [
      makeActivity({
        id: "agent-a",
        kind: "tool.started",
        createdAt: "2026-06-04T10:00:00.000Z",
        payload: {
          itemType: "collab_agent_tool_call",
          status: "inProgress",
          detail: "Investigate the failing checks",
          data: { toolCallId: "call-a" },
        },
      }),
      makeActivity({
        id: "agent-b",
        kind: "tool.started",
        createdAt: "2026-06-04T10:00:01.000Z",
        payload: {
          itemType: "collab_agent_tool_call",
          status: "inProgress",
          detail: "Trace the retry path",
          data: { toolCallId: "call-b" },
        },
      }),
    ];

    const subagents = deriveThreadSubagents(activities);
    expect(subagents).toHaveLength(2);

    for (const subagent of subagents) {
      // A memorable codename, never the old "Subagent 1, 2, 3…" counter.
      expect(subagent.name).toMatch(/^[A-Z][A-Za-z]+$/);
      expect(subagent.name).not.toMatch(/^Subagent\b/);
      // No inferable role, so the subtitle stays empty.
      expect(subagent.role).toBeNull();
    }
    expect(subagents[0]?.name).not.toBe(subagents[1]?.name);

    // Codenames are seeded from the stable subagent key, so they do not drift
    // between renders of the same activity stream.
    const second = deriveThreadSubagents(activities);
    expect(second.map((subagent) => subagent.name)).toEqual(
      subagents.map((subagent) => subagent.name),
    );
  });

  it("resolves codename collisions independently of insertion order", () => {
    // "subagent:c3" and "subagent:c7" prefer the same first codename, forcing a
    // collision. The resolved names must depend only on the keys, not on which
    // subagent arrived (or was backfilled) first — otherwise a subagent's label
    // and avatar could silently change on refresh.
    const startActivity = (subagentId: string, createdAt: string) =>
      makeActivity({
        id: `start-${subagentId}-${createdAt}`,
        kind: "subagent.started",
        createdAt,
        payload: {
          itemType: "subagent",
          subagent: { subagentId },
          status: "running",
        },
      });

    const codenamesByKey = (activities: OrchestrationThreadActivity[]) =>
      Object.fromEntries(
        deriveThreadSubagents(activities).map((subagent) => [subagent.key, subagent.name]),
      );

    const c3First = codenamesByKey([
      startActivity("c3", "2026-06-04T10:00:00.000Z"),
      startActivity("c7", "2026-06-04T10:00:01.000Z"),
    ]);
    const c7First = codenamesByKey([
      startActivity("c7", "2026-06-04T10:00:00.000Z"),
      startActivity("c3", "2026-06-04T10:00:01.000Z"),
    ]);

    expect(Object.keys(c3First).toSorted()).toEqual(["subagent:c3", "subagent:c7"]);
    expect(c7First).toEqual(c3First);
    expect(c3First["subagent:c3"]).not.toBe(c3First["subagent:c7"]);
  });
});

describe("findThreadSubagent", () => {
  it("returns the keyed subagent", () => {
    const subagents = deriveThreadSubagents([
      makeActivity({
        id: "agent",
        payload: {
          itemType: "collab_agent_tool_call",
          detail: "Hilbert: inspect the retry flow",
        },
      }),
    ]);

    expect(findThreadSubagent(subagents, subagents[0]?.key)).toBe(subagents[0]);
    expect(findThreadSubagent(subagents, "missing")).toBeNull();
  });
});

it("keeps child tool details out of the parent and folds tool lifecycle at its original position", () => {
  const activities = [
    makeActivity({
      id: "spawn",
      kind: "task.started",
      sequence: 1,
      payload: { taskId: "child", agentKind: "agent", status: "running" },
    }),
    makeActivity({
      id: "start",
      kind: "tool.started",
      sequence: 2,
      payload: {
        agentId: "child",
        data: { toolCallId: "cmd", command: "cat README.md", output: "Readme contents" },
        itemType: "command_execution",
        title: "Bash",
        command: "cat README.md",
        status: "inProgress",
      },
    }),
    makeActivity({
      id: "end",
      kind: "tool.completed",
      sequence: 4,
      payload: {
        agentId: "child",
        data: { toolCallId: "cmd", command: "cat README.md", output: "Readme contents" },
        itemType: "command_execution",
        title: "Bash",
        command: "cat README.md",
        output: "Readme contents",
        status: "completed",
      },
    }),
    makeActivity({
      id: "other",
      kind: "tool.completed",
      sequence: 5,
      payload: {
        agentId: "another-child",
        toolCallId: "other",
        itemType: "command_execution",
        command: "pwd",
        status: "completed",
      },
    }),
  ];
  const child = deriveThreadSubagents(activities)[0]!;
  expect(child.entries).toHaveLength(1);
  expect(child.entries[0]).toMatchObject({
    id: "start",
    command: "cat README.md",
    output: "Readme contents",
    sequence: 2,
  });
  expect(deriveWorkLogEntries(activities).some((entry) => entry.command === "cat README.md")).toBe(
    false,
  );
  const timeline = deriveAgentTimeline({
    ...child,
    messages: [
      {
        id: "message",
        text: "Reading documentation",
        createdAt: activities[0]!.createdAt,
        sequence: 3,
      },
    ],
  });
  expect(timeline.map((row) => row.kind)).toEqual(["tool", "message"]);
  expect(deriveThreadSubagents(activities.slice(0, 2))[0]?.entries).toHaveLength(1);
});

it("collapses interleaved provider item lifecycles without merging distinct child commands", () => {
  const activities = [
    makeActivity({
      kind: "task.started",
      payload: { taskId: "child", agentKind: "agent", status: "running" },
    }),
    ...[
      ["tool.started", "a", 1],
      ["tool.started", "b", 2],
      ["tool.completed", "a", 3],
      ["tool.completed", "b", 4],
    ].map(([kind, id, sequence]) =>
      makeActivity({
        kind: String(kind),
        sequence: Number(sequence),
        payload: {
          agentId: "child",
          providerItemId: String(id),
          itemType: "command_execution",
          data: { state: { input: { command: `echo ${id}` }, output: `result ${id}` } },
        },
      }),
    ),
  ];
  const entries = deriveThreadSubagents(activities)[0]!.entries;
  expect(entries.map((entry) => [entry.command, entry.sequence, entry.completed])).toEqual([
    ["echo a", 1, true],
    ["echo b", 2, true],
  ]);
});

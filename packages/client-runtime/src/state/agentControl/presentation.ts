/**
 * Pure presentation model for Agent Control proposal cards.
 *
 * Renders only what the server published: origin, exact action and target,
 * risk, runtime/worktree conditions, expiry, and terminal outcome. The
 * audit-safe prompt summary is the default text; full prompts appear only
 * in `detailSections`, which the card reveals through deliberate expansion.
 */
import {
  AGENT_CONTROL_AUTOMATION_MAX_ACTIVE_PER_PROJECT,
  AGENT_CONTROL_AUTOMATION_MAX_HORIZON_MS,
  AGENT_CONTROL_AUTOMATION_MIN_INTERVAL_MS,
  AGENT_CONTROL_AUTOMATION_RUN_HISTORY_MAX,
  type AgentControlProposal,
  type AgentControlProposalId,
  type AgentControlProposalStatus,
  type ThreadId,
} from "@ryco/contracts";

export type AgentControlStatusTone = "pending" | "info" | "success" | "danger" | "muted";

export interface AgentControlDetailSection {
  readonly heading: string;
  readonly lines: ReadonlyArray<string>;
}

export interface AgentControlProposalCardModel {
  readonly proposalId: AgentControlProposalId;
  readonly status: AgentControlProposalStatus;
  readonly statusLabel: string;
  readonly statusTone: AgentControlStatusTone;
  readonly originLabel: string;
  readonly originThreadId: ThreadId | null;
  readonly actionLabel: string;
  readonly targetLabel: string;
  readonly runtimeLabel: string | null;
  readonly riskLabels: ReadonlyArray<string>;
  readonly isDestructive: boolean;
  readonly warningLabel: string | null;
  readonly summary: string | null;
  readonly expiresAt: string;
  readonly isPending: boolean;
  readonly outcomeLabel: string | null;
  readonly executionLabel: string | null;
  readonly affectedThreadIds: ReadonlyArray<ThreadId>;
  readonly affectedProjectIds: ReadonlyArray<string>;
  readonly detailSections: ReadonlyArray<AgentControlDetailSection>;
}

const STATUS_PRESENTATION: Record<
  AgentControlProposalStatus,
  { readonly label: string; readonly tone: AgentControlStatusTone }
> = {
  "pending-user-approval": { label: "Awaiting approval", tone: "pending" },
  approved: { label: "Approved · awaiting executor", tone: "info" },
  executing: { label: "Executing", tone: "info" },
  completed: { label: "Completed", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  rejected: { label: "Rejected", tone: "muted" },
  expired: { label: "Expired", tone: "muted" },
  cancelled: { label: "Cancelled", tone: "muted" },
};

const shortId = (value: string): string => (value.length > 10 ? `${value.slice(0, 8)}…` : value);

const riskLabelFromTag = (tag: string): string => tag.replaceAll("-", " ");

function originPresentation(proposal: AgentControlProposal): {
  readonly label: string;
  readonly threadId: ThreadId | null;
} {
  const principal = proposal.principal;
  if (principal.kind === "provider-session") {
    return {
      label: `Agent in thread ${shortId(principal.threadId)} (${principal.providerInstanceId})`,
      threadId: principal.threadId,
    };
  }
  return {
    label: `External integration ${principal.label ?? shortId(principal.integrationId)}`,
    threadId: null,
  };
}

function planPresentation(proposal: AgentControlProposal): {
  readonly actionLabel: string;
  readonly targetLabel: string;
  readonly runtimeLabel: string | null;
  readonly detailSections: ReadonlyArray<AgentControlDetailSection>;
} {
  const scheduleLines = (
    schedule: Extract<
      AgentControlProposal["plan"],
      { kind: "createAutomation" }
    >["definition"]["schedule"],
  ) =>
    schedule.kind === "once"
      ? [`Schedule: one-shot`, `Next run: ${schedule.runAt}`]
      : [
          `Schedule: every ${schedule.intervalMs}ms`,
          `Next run: ${schedule.startsAt}`,
          `Ends: ${schedule.endsAt}`,
          "Missed intervals coalesce into at most one pending run.",
        ];
  const scheduleLimitLines = [
    `Limits: ${AGENT_CONTROL_AUTOMATION_MAX_ACTIVE_PER_PROJECT} active schedules per project; minimum interval ${AGENT_CONTROL_AUTOMATION_MIN_INTERVAL_MS}ms.`,
    `Horizon: ${AGENT_CONTROL_AUTOMATION_MAX_HORIZON_MS}ms; retained run history: ${AGENT_CONTROL_AUTOMATION_RUN_HISTORY_MAX}.`,
  ];
  const executionLines = (
    execution: Extract<AgentControlProposal["plan"], { kind: "automationRun" }>["execution"],
  ) => [
    `Project: ${execution.projectId}`,
    `Provider: ${execution.modelSelection.instanceId} · ${execution.modelSelection.model}`,
    `Runtime: ${execution.runtimeMode} · ${execution.envMode}`,
    ...(execution.baseRef === undefined ? [] : [`Base ref: ${execution.baseRef}`]),
    `Intended work: ${execution.title}`,
    `Prompt: ${execution.prompt}`,
  ];
  const plan = proposal.plan;
  const deviceDetails = (
    devicePlan: Extract<AgentControlProposal["plan"], { kind: `device${string}` }>,
    actionLines: ReadonlyArray<string>,
  ): ReadonlyArray<AgentControlDetailSection> => [
    {
      heading: "Exact governed Simulator action",
      lines: [
        `Device UDID: ${devicePlan.udid}`,
        `Thread: ${devicePlan.threadId}`,
        `Project: ${devicePlan.projectId}`,
        `Expected project revision: ${devicePlan.expectedProjectUpdatedAt}`,
        `Provider instance: ${devicePlan.providerInstanceId}`,
        `Expected attachment version: ${devicePlan.expectedThreadDeviceVersion}`,
        `Expected attached device: ${devicePlan.expectedAttachedDeviceUdid ?? "none"}`,
        `Expected lifecycle: ${devicePlan.expectedDeviceState}`,
        `Expected boot owner: ${devicePlan.expectedDeviceBootSource}`,
        `Expected recording: ${devicePlan.expectedRecording ? "yes" : "no"}`,
        ...actionLines,
        "Execution stops if the device, attachment, thread, project, provider, or owner authority changes.",
      ],
    },
  ];
  switch (plan.kind) {
    case "createThreads": {
      const count = plan.entries.length;
      const projectIds = [...new Set(plan.entries.map((entry) => String(entry.projectId)))];
      const runtimes = [
        ...new Set(plan.entries.map((entry) => `${entry.runtimeMode} · ${entry.envMode}`)),
      ];
      return {
        actionLabel: count === 1 ? "Create 1 thread" : `Create ${count} threads`,
        targetLabel:
          projectIds.length === 1
            ? `project ${shortId(projectIds[0]!)}`
            : `${projectIds.length} projects`,
        runtimeLabel: runtimes.length === 1 ? runtimes[0]! : "mixed runtime modes",
        detailSections: plan.entries.map((entry, index) => ({
          heading: `Thread ${index + 1}: ${entry.title}`,
          lines: [
            `Project: ${entry.projectId}`,
            `Model: ${entry.modelSelection.instanceId} · ${entry.modelSelection.model}`,
            `Runtime: ${entry.runtimeMode} · ${entry.envMode}`,
            ...(entry.baseRef !== undefined ? [`Base ref: ${entry.baseRef}`] : []),
            `Prompt: ${entry.prompt}`,
          ],
        })),
      };
    }
    case "sendMessage":
      return {
        actionLabel: plan.delivery === "steer" ? "Steer thread" : "Queue message",
        targetLabel: `thread ${shortId(plan.threadId)}`,
        runtimeLabel: null,
        detailSections: [{ heading: "Message", lines: [`Thread: ${plan.threadId}`, plan.text] }],
      };
    case "interruptThread":
      return {
        actionLabel: "Interrupt thread",
        targetLabel: `thread ${shortId(plan.threadId)}`,
        runtimeLabel: null,
        detailSections: [
          {
            heading: "Interrupt",
            lines: [
              `Thread: ${plan.threadId}`,
              ...(plan.turnId !== undefined ? [`Only turn: ${plan.turnId}`] : []),
            ],
          },
        ],
      };
    case "updateThread": {
      const changes: string[] = [];
      if (plan.title !== undefined) changes.push(`Title: ${plan.title}`);
      if (plan.modelSelection !== undefined)
        changes.push(`Model: ${JSON.stringify(plan.modelSelection)}`);
      if (plan.runtimeMode !== undefined) changes.push(`Runtime permissions: ${plan.runtimeMode}`);
      if (plan.interactionMode !== undefined) changes.push(`Interaction: ${plan.interactionMode}`);
      if (plan.tokenMode !== undefined) changes.push(`Token mode: ${plan.tokenMode}`);
      if (plan.archived !== undefined) {
        changes.push(plan.archived ? "Archive thread" : "Unarchive thread");
      }
      if (plan.persistentGoal !== undefined) {
        changes.push(
          plan.persistentGoal === null ? "Clear persistent goal" : `Goal: ${plan.persistentGoal}`,
        );
      }
      return {
        actionLabel: "Update thread",
        targetLabel: `thread ${shortId(plan.threadId)}`,
        runtimeLabel: null,
        detailSections: [{ heading: "Changes", lines: [`Thread: ${plan.threadId}`, ...changes] }],
      };
    }
    case "createProject":
      return {
        actionLabel: "Create project",
        targetLabel: `project ${shortId(plan.projectId)}`,
        runtimeLabel: null,
        detailSections: [
          { heading: "Before", lines: ["No Ryco project record with this ID."] },
          {
            heading: "After",
            lines: [
              `Project ID: ${plan.projectId}`,
              `Display name: ${plan.title}`,
              `Workspace path: ${plan.workspaceRoot}`,
              `Metadata directory: ${plan.projectMetadataDir}`,
              `Repository identity: ${plan.repositoryIdentityKey ?? "none"}`,
              "Workspace must already exist; no directory is created by this action.",
            ],
          },
        ],
      };
    case "updateProject":
      return {
        actionLabel: "Update project metadata",
        targetLabel: `project ${shortId(plan.projectId)}`,
        runtimeLabel: null,
        detailSections: [
          {
            heading: "Before",
            lines: [
              `Display name: ${plan.before.title}`,
              `Workspace path: ${plan.before.workspaceRoot}`,
              `Repository identity: ${plan.before.repositoryIdentityKey ?? "none"}`,
              `Expected revision: ${plan.before.updatedAt}`,
              ...projectPreferenceLines(plan.before),
            ],
          },
          {
            heading: "After",
            lines: [
              `Display name: ${plan.after.title}`,
              `Workspace path: ${plan.after.workspaceRoot}`,
              `Repository identity: ${plan.after.repositoryIdentityKey ?? "none"}`,
              ...projectPreferenceLines(plan.after),
            ],
          },
        ],
      };
    case "removeProject":
      return {
        actionLabel: "Unlink project",
        targetLabel: `project ${shortId(plan.projectId)}`,
        runtimeLabel: null,
        detailSections: [
          {
            heading: "Before · destructive Ryco record removal",
            lines: [
              `Project ID: ${plan.projectId}`,
              `Display name: ${plan.expected.title}`,
              `Workspace path: ${plan.expected.workspaceRoot}`,
              `Expected revision: ${plan.expected.updatedAt}`,
              `Force removal: ${plan.force ? "yes" : "no"}`,
              ...(plan.expectedThreadIds.length === 0
                ? ["Ryco thread records removed: none"]
                : plan.expectedThreadIds.map(
                    (threadId) => `Ryco thread record removed: ${threadId}`,
                  )),
              "Workspace files and repository contents will be retained.",
            ],
          },
          {
            heading: "After",
            lines: [
              "The Ryco project record and the exact listed Ryco thread records are unlinked.",
              "The workspace directory and repository are unchanged.",
            ],
          },
        ],
      };
    case "changeSettings":
      return {
        actionLabel: "Change setting",
        targetLabel: plan.change.kind,
        runtimeLabel: null,
        detailSections: [
          {
            heading: "Exact setting change",
            lines: [
              `Setting: ${plan.change.kind}`,
              `Before: ${String(plan.change.before)}`,
              `After: ${String(plan.change.after)}`,
              "Fresh owner reauthentication is required at approval and execution.",
            ],
          },
        ],
      };
    case "createAutomation":
      return {
        actionLabel: "Create schedule definition",
        targetLabel: `automation ${shortId(plan.automationId)}`,
        runtimeLabel: `${plan.definition.execution.runtimeMode} · ${plan.definition.execution.envMode}`,
        detailSections: [
          {
            heading: "Schedule definition approval",
            lines: [
              ...scheduleLines(plan.definition.schedule),
              ...scheduleLimitLines,
              `Enabled: ${plan.definition.enabled ? "yes" : "no"}`,
              ...executionLines(plan.definition.execution),
              "This approval authorizes only the schedule definition.",
              "Every due run creates a fresh exact proposal and waits for user approval.",
              "At most one pending or executing run is allowed for this automation.",
            ],
          },
        ],
      };
    case "updateAutomation":
      return {
        actionLabel: "Update schedule definition",
        targetLabel: `automation ${shortId(plan.automationId)}`,
        runtimeLabel: `${plan.after.execution.runtimeMode} · ${plan.after.execution.envMode}`,
        detailSections: [
          {
            heading: `Before · revision ${plan.before.revision}`,
            lines: [
              ...scheduleLines(plan.before.definition.schedule),
              `Enabled: ${plan.before.definition.enabled ? "yes" : "no"}`,
              `Last changed: ${plan.before.updatedAt}`,
            ],
          },
          {
            heading: "After · schedule approval only",
            lines: [
              ...scheduleLines(plan.after.schedule),
              ...scheduleLimitLines,
              `Enabled: ${plan.after.enabled ? "yes" : "no"}`,
              ...executionLines(plan.after.execution),
              "Pending, unaccepted runs from the old definition are cancelled.",
              "Already accepted or executing runs are not interrupted.",
              "Future runs still require separate approval.",
            ],
          },
        ],
      };
    case "cancelAutomation":
      return {
        actionLabel: "Cancel future scheduled runs",
        targetLabel: `automation ${shortId(plan.automationId)}`,
        runtimeLabel: null,
        detailSections: [
          {
            heading: `Expected revision ${plan.expected.revision}`,
            lines: [
              ...scheduleLines(plan.expected.definition.schedule),
              `Project: ${plan.expected.definition.execution.projectId}`,
              `Provider: ${plan.expected.definition.execution.modelSelection.instanceId}`,
              "Cancellation prevents future run proposals and cancels a pending, unaccepted run.",
              "It does not delete project/thread data or interrupt an accepted/executing run.",
            ],
          },
        ],
      };
    case "automationRun":
      return {
        actionLabel: "Approve one scheduled run",
        targetLabel: `run ${shortId(plan.runId)}`,
        runtimeLabel: `${plan.execution.runtimeMode} · ${plan.execution.envMode}`,
        detailSections: [
          {
            heading: "Fresh run approval",
            lines: [
              `Automation: ${plan.automationId} · revision ${plan.automationRevision}`,
              `Scheduled for: ${plan.scheduledFor}`,
              `Missed intervals coalesced: ${plan.coalescedOccurrences}`,
              ...executionLines(plan.execution),
              "Approving the schedule did not approve this run; this exact proposal does.",
            ],
          },
        ],
      };
    case "deviceBoot":
      return {
        actionLabel: "Boot iOS Simulator",
        targetLabel: `device ${shortId(plan.udid)}`,
        runtimeLabel: "explicit approval required",
        detailSections: deviceDetails(plan, ["Action: boot this exact Simulator."]),
      };
    case "deviceAttach":
      return {
        actionLabel: "Attach iOS Simulator",
        targetLabel: `device ${shortId(plan.udid)}`,
        runtimeLabel: "explicit approval required",
        detailSections: deviceDetails(plan, ["Action: attach this device to the exact thread."]),
      };
    case "deviceDetach":
      return {
        actionLabel: "Detach iOS Simulator",
        targetLabel: `device ${shortId(plan.udid)}`,
        runtimeLabel: "explicit approval required",
        detailSections: deviceDetails(plan, ["Action: detach this device from the exact thread."]),
      };
    case "deviceInstall":
      return {
        actionLabel: "Install Simulator application",
        targetLabel: `device ${shortId(plan.udid)}`,
        runtimeLabel: "explicit approval required",
        detailSections: deviceDetails(plan, [
          `Workspace-relative artifact: ${plan.artifactPath}`,
          "The canonical artifact path is revalidated inside the project workspace at execution.",
        ]),
      };
    case "deviceLaunch":
      return {
        actionLabel: "Launch Simulator application",
        targetLabel: `device ${shortId(plan.udid)}`,
        runtimeLabel: "explicit approval required",
        detailSections: deviceDetails(plan, [
          `Installed bundle ID: ${plan.bundleId}`,
          "Launch arguments are not permitted through Agent Control.",
        ]),
      };
    case "deviceOpenUrl":
      return {
        actionLabel: "Open URL on iOS Simulator",
        targetLabel: `device ${shortId(plan.udid)}`,
        runtimeLabel: "high risk · open world",
        detailSections: deviceDetails(plan, [
          `Exact URL/deep link: ${plan.url}`,
          "Credentials, file URLs, and unsafe schemes are rejected again at execution.",
        ]),
      };
    case "deviceTap":
      return {
        actionLabel: "Tap iOS Simulator",
        targetLabel: `device ${shortId(plan.udid)}`,
        runtimeLabel: "explicit approval required",
        detailSections: deviceDetails(plan, [`Point: (${String(plan.x)}, ${String(plan.y)})`]),
      };
    case "deviceSwipe":
      return {
        actionLabel: "Swipe iOS Simulator",
        targetLabel: `device ${shortId(plan.udid)}`,
        runtimeLabel: "explicit approval required",
        detailSections: deviceDetails(plan, [
          `From: (${plan.fromX}, ${plan.fromY})`,
          `To: (${plan.toX}, ${plan.toY})`,
          `Duration: ${plan.durationMs}ms`,
        ]),
      };
    case "devicePressButton":
      return {
        actionLabel: "Press Simulator hardware control",
        targetLabel: `device ${shortId(plan.udid)}`,
        runtimeLabel: "explicit approval required",
        detailSections: deviceDetails(plan, [`Button: ${plan.button}`]),
      };
    case "deviceStartRecording":
    case "deviceStopRecording":
      return {
        actionLabel:
          plan.kind === "deviceStartRecording"
            ? "Start Simulator recording"
            : "Stop Simulator recording",
        targetLabel: `device ${shortId(plan.udid)}`,
        runtimeLabel: "explicit approval required",
        detailSections: deviceDetails(plan, [
          `Action: ${plan.kind === "deviceStartRecording" ? "start" : "stop"} recording.`,
          "Recording paths and frame content are excluded from proposals and audit.",
        ]),
      };
    case "deviceShutdown":
      return {
        actionLabel: "Shut down iOS Simulator",
        targetLabel: `device ${shortId(plan.udid)}`,
        runtimeLabel: "explicit approval required",
        detailSections: deviceDetails(plan, ["Action: shut down this exact Simulator."]),
      };
  }
}

function outcomeLabel(proposal: AgentControlProposal): string | null {
  const result = proposal.result;
  if (result === null) return null;
  if (result.outcome === "completed") {
    const created = result.createdThreadIds?.length ?? 0;
    const createdProjects = result.createdProjectIds?.length ?? 0;
    const detail = result.detail !== undefined ? ` · ${result.detail}` : "";
    return createdProjects > 0
      ? `Completed · created ${createdProjects} project${createdProjects === 1 ? "" : "s"}${detail}`
      : created > 0
        ? `Completed · created ${created} thread${created === 1 ? "" : "s"}${detail}`
        : `Completed${detail}`;
  }
  return `${result.error.code}: ${result.error.message}`;
}

function executionPresentation(proposal: AgentControlProposal): {
  readonly label: string | null;
  readonly affectedThreadIds: ReadonlyArray<ThreadId>;
  readonly affectedProjectIds: ReadonlyArray<string>;
} {
  const execution = proposal.result?.execution;
  if (execution === undefined) {
    return { label: null, affectedThreadIds: [], affectedProjectIds: [] };
  }
  const parts = [
    `Operation ${shortId(execution.operationId)}`,
    `${execution.commands.length} command${execution.commands.length === 1 ? "" : "s"}`,
  ];
  if (execution.worktreeIds.length > 0) {
    parts.push(
      `${execution.worktreeIds.length} worktree${execution.worktreeIds.length === 1 ? "" : "s"}`,
    );
  }
  if (execution.delivery !== undefined) parts.push(`delivery: ${execution.delivery}`);
  if (execution.interrupt !== undefined) {
    parts.push(`interrupt settled: ${execution.interrupt.settledStatus}`);
  }
  if (execution.compensation !== undefined) {
    parts.push(execution.compensation.completed ? "cleanup completed" : "cleanup needs attention");
  }
  return {
    label: parts.join(" · "),
    affectedThreadIds: execution.affectedThreadIds,
    affectedProjectIds: execution.affectedProjectIds ?? [],
  };
}

export function buildAgentControlProposalCardModel(
  proposal: AgentControlProposal,
): AgentControlProposalCardModel {
  const status = STATUS_PRESENTATION[proposal.status];
  const origin = originPresentation(proposal);
  const plan = planPresentation(proposal);
  const execution = executionPresentation(proposal);
  return {
    proposalId: proposal.proposalId,
    status: proposal.status,
    statusLabel: status.label,
    statusTone: status.tone,
    originLabel: origin.label,
    originThreadId: origin.threadId,
    actionLabel: plan.actionLabel,
    targetLabel: plan.targetLabel,
    runtimeLabel: plan.runtimeLabel,
    riskLabels: proposal.riskTags.map((tag) => riskLabelFromTag(String(tag))),
    isDestructive: proposal.plan.kind === "removeProject",
    warningLabel:
      proposal.plan.kind === "deviceOpenUrl"
        ? "High risk · opens an external URL or deep link"
        : null,
    summary: proposal.promptSummary,
    expiresAt: proposal.expiresAt,
    isPending: proposal.status === "pending-user-approval",
    outcomeLabel: outcomeLabel(proposal),
    executionLabel: execution.label,
    affectedThreadIds: execution.affectedThreadIds,
    affectedProjectIds: execution.affectedProjectIds,
    detailSections: plan.detailSections,
  };
}

function projectPreferenceLines(
  value: import("@ryco/contracts").AgentControlProjectPreferences,
): string[] {
  return Object.entries(value)
    .filter(([key]) =>
      ["defaultModelSelection", "customSystemPrompt", "scripts", "preferredRemoteName"].includes(
        key,
      ),
    )
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
}

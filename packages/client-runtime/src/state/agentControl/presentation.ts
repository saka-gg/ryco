/**
 * Pure presentation model for Agent Control proposal cards.
 *
 * Renders only what the server published: origin, exact action and target,
 * risk, runtime/worktree conditions, expiry, and terminal outcome. The
 * audit-safe prompt summary is the default text; full prompts appear only
 * in `detailSections`, which the card reveals through deliberate expansion.
 *
 * Proposals are the tolerant wire view. A plan this build cannot read
 * (`unsupported`) and a plan the approving client runs itself
 * (`requiresClientExecutor`) are presented, but `agentControlCardDecisions`
 * decides whether this client may offer Approve for them.
 */
import type { ThreadId } from "@ryco/contracts";
import {
  AGENT_CONTROL_AUTOMATION_MAX_ACTIVE_PER_PROJECT,
  AGENT_CONTROL_AUTOMATION_UNATTENDED_FAILURES_MAX,
  AGENT_CONTROL_AUTOMATION_MAX_HORIZON_MS,
  AGENT_CONTROL_AUTOMATION_MIN_INTERVAL_MS,
  AGENT_CONTROL_AUTOMATION_RUN_HISTORY_MAX,
  AGENT_CONTROL_CLIENT_EXECUTED_PLAN_KINDS,
  type AgentControlCompletionReturn,
  type AgentControlCopyProjectTarget,
  type AgentControlCopyProjectToNodePlan,
  type AgentControlImportProjectPlan,
  type AgentControlPlanView,
  type AgentControlDeviceActionPlan,
  type AgentControlProposal,
  type AgentControlProposalId,
  type AgentControlProposalStatus,
  type AgentControlProposalView,
} from "@ryco/contracts/agent-control";
import { calendarDaysWords } from "@ryco/shared/automationCalendar";

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
  readonly completionReturns?: AgentControlProposalView["completionReturns"];
  readonly affectedThreadIds: ReadonlyArray<ThreadId>;
  readonly affectedProjectIds: ReadonlyArray<string>;
  readonly detailSections: ReadonlyArray<AgentControlDetailSection>;
  /**
   * The kind the node sent when this build cannot read the plan (`unsupported`
   * in the tolerant view); null otherwise. Such a card is never approved here.
   */
  readonly unsupportedKind: string | null;
  /**
   * The approving client runs the plan itself
   * (`AGENT_CONTROL_CLIENT_EXECUTED_PLAN_KINDS`), against `clientExecutionTarget`.
   */
  readonly requiresClientExecutor: boolean;
  /** The node a client-executed plan runs against; null for every other plan. */
  readonly clientExecutionTarget: AgentControlCopyProjectTarget | null;
}

/**
 * Whether this client can run a client-executed plan against `target` right now:
 * it has the copy coordinator and a connection to that node. Clients without the
 * coordinator (mobile, the web phone tier) pass none.
 */
export type AgentControlClientExecutionCheck = (target: AgentControlCopyProjectTarget) => boolean;

/** What a pending card lets this client do. Reject is offered whenever it is pending. */
export interface AgentControlCardDecisions {
  readonly canApprove: boolean;
  /** Shown in place of Approve when it is not offered. */
  readonly approveUnavailableLabel: string | null;
  /** The plan needs a newer Ryco: the card offers "Update Ryco". */
  readonly offersUpdate: boolean;
}

export const AGENT_CONTROL_UNSUPPORTED_REQUEST_LABEL = "Update Ryco to review this request.";

/** "Approve in Ryco on a computer connected to <target>". */
export function agentControlClientExecutorRequiredLabel(
  target: AgentControlCopyProjectTarget,
): string {
  return `Approve in Ryco on a computer connected to ${target.label}`;
}

const CAN_APPROVE: AgentControlCardDecisions = {
  canApprove: true,
  approveUnavailableLabel: null,
  offersUpdate: false,
};

/**
 * The one rule every client applies before it offers Approve: never for a plan
 * this build cannot read, and for a client-executed plan only when this client
 * can run it against its target. The node refuses such accepts as well; this
 * keeps the button from promising what the client cannot do.
 */
export function agentControlCardDecisions(
  model: Pick<
    AgentControlProposalCardModel,
    "unsupportedKind" | "requiresClientExecutor" | "clientExecutionTarget"
  >,
  canExecuteOnClient: AgentControlClientExecutionCheck | null,
): AgentControlCardDecisions {
  if (model.unsupportedKind !== null) {
    return {
      canApprove: false,
      approveUnavailableLabel: AGENT_CONTROL_UNSUPPORTED_REQUEST_LABEL,
      offersUpdate: true,
    };
  }
  if (!model.requiresClientExecutor) return CAN_APPROVE;
  const target = model.clientExecutionTarget;
  if (target !== null && canExecuteOnClient?.(target) === true) return CAN_APPROVE;
  return {
    canApprove: false,
    approveUnavailableLabel:
      target === null
        ? "Approve in Ryco on a computer connected to the target node"
        : agentControlClientExecutorRequiredLabel(target),
    offersUpdate: false,
  };
}

const CLIENT_EXECUTED_PLAN_KINDS: ReadonlySet<string> = new Set(
  AGENT_CONTROL_CLIENT_EXECUTED_PLAN_KINDS,
);

/** Whether the approving client, not the node, runs the plan. */
export function isClientExecutedAgentControlPlan(plan: AgentControlPlanView): boolean {
  return CLIENT_EXECUTED_PLAN_KINDS.has(plan.kind);
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

export interface AgentControlCompletionReturnPresentation {
  readonly label: string;
  readonly tone: AgentControlStatusTone;
  /** The child's result has not reached its parent yet (the server's pending set). */
  readonly pending: boolean;
}

const COMPLETION_RETURN_PRESENTATION: Record<
  AgentControlCompletionReturn["status"],
  AgentControlCompletionReturnPresentation
> = {
  waiting: { label: "Result pending", tone: "muted", pending: true },
  ready: { label: "Result ready", tone: "info", pending: true },
  dispatching: { label: "Returning…", tone: "info", pending: true },
  delivered: { label: "Returned", tone: "success", pending: false },
  blocked: { label: "Return blocked", tone: "danger", pending: false },
  failed: { label: "Return failed", tone: "danger", pending: false },
  uncertain: { label: "Return uncertain", tone: "danger", pending: false },
  cancelled: { label: "Return cancelled", tone: "muted", pending: false },
};

/** How a delegated thread's result return reads; the server's `detail` explains it. */
export function completionReturnPresentation(
  status: AgentControlCompletionReturn["status"],
): AgentControlCompletionReturnPresentation {
  return COMPLETION_RETURN_PRESENTATION[status];
}

const shortId = (value: string): string => (value.length > 10 ? `${value.slice(0, 8)}…` : value);

const riskLabelFromTag = (tag: string): string => tag.replaceAll("-", " ");

function originPresentation(proposal: AgentControlProposalView): {
  readonly label: string;
  readonly threadId: ThreadId | null;
} {
  const principal = proposal.principal;
  if (principal.kind === "automation-owner") return { label: "You · Automations", threadId: null };
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

function planPresentation(proposal: AgentControlProposalView): PlanPresentation {
  const scheduleLines = (
    schedule: Extract<
      AgentControlProposalView["plan"],
      { kind: "createAutomation" }
    >["definition"]["schedule"],
  ) =>
    schedule.kind === "once"
      ? [`Schedule: one-shot`, `Next run: ${schedule.runAt}`]
      : schedule.kind === "calendar"
        ? [
            `Schedule: ${calendarDaysWords(schedule.weekdays)} at ${schedule.localTime} (${schedule.timeZone})`,
            `Starts: ${schedule.startsAt}`,
            `Ends: ${schedule.endsAt}`,
            "A time a clock change skips is skipped that day; a repeated time runs once.",
            "Missed times coalesce into at most one pending run.",
          ]
        : [
            `Schedule: every ${schedule.intervalMs}ms`,
            `Next run: ${schedule.startsAt}`,
            `Ends: ${schedule.endsAt}`,
            "Missed intervals coalesce into at most one pending run.",
          ];
  const runPolicyLines = (
    runPolicy: Extract<
      AgentControlProposal["plan"],
      { kind: "createAutomation" }
    >["definition"]["runPolicy"],
  ) =>
    runPolicy === "run-without-asking"
      ? [
          "Runs without asking: each due run starts on its own, with exactly this project, provider, model, runtime mode and checkout.",
          `It pauses after ${AGENT_CONTROL_AUTOMATION_UNATTENDED_FAILURES_MAX} failed runs in a row.`,
        ]
      : ["Asks before each run."];
  const scheduleLimitLines = [
    `Limits: ${AGENT_CONTROL_AUTOMATION_MAX_ACTIVE_PER_PROJECT} active schedules per project; minimum interval ${AGENT_CONTROL_AUTOMATION_MIN_INTERVAL_MS}ms.`,
    `Horizon: ${AGENT_CONTROL_AUTOMATION_MAX_HORIZON_MS}ms; retained run history: ${AGENT_CONTROL_AUTOMATION_RUN_HISTORY_MAX}.`,
  ];
  const executionLines = (
    execution: Extract<AgentControlProposalView["plan"], { kind: "automationRun" }>["execution"],
  ) => [
    `Project: ${execution.projectId}`,
    `Provider: ${execution.modelSelection.instanceId} · ${execution.modelSelection.model}`,
    `Runtime: ${execution.runtimeMode} · ${execution.envMode}`,
    ...(execution.target === undefined
      ? []
      : [`Runs in: the follow-up queue of thread ${execution.target.threadId}`]),
    ...(execution.tokenMode === undefined ? [] : [`Token mode: ${execution.tokenMode}`]),
    ...(execution.baseRef === undefined ? [] : [`Base ref: ${execution.baseRef}`]),
    `Intended work: ${execution.title}`,
    `Prompt: ${execution.prompt}`,
  ];
  const plan = proposal.plan;
  const deviceDetails = (
    devicePlan: AgentControlDeviceActionPlan,
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
    case "deleteLocalTask":
      return {
        actionLabel: "Delete task",
        targetLabel: plan.title,
        runtimeLabel: null,
        detailSections: [
          {
            heading: "Before · destructive task removal",
            lines: [
              `Task: ${plan.title}`,
              `Task ID: ${plan.taskId}`,
              `Expected revision: ${plan.expectedRevision}`,
              "Its notes, links and files are deleted; chats started from it are kept.",
              "Execution stops if the task changed after this request was made.",
            ],
          },
        ],
      };
    case "createThreads": {
      const count = plan.entries.length;
      const projectIds = [...new Set(plan.entries.map((entry) => String(entry.projectId)))];
      const runtimes = [
        ...new Set(plan.entries.map((entry) => `${entry.runtimeMode} · ${entry.envMode}`)),
      ];
      const runtime = runtimes.length === 1 ? runtimes[0]! : "mixed runtime modes";
      return {
        actionLabel: count === 1 ? "Create 1 thread" : `Create ${count} threads`,
        targetLabel:
          projectIds.length === 1
            ? `project ${shortId(projectIds[0]!)}`
            : `${projectIds.length} projects`,
        runtimeLabel:
          plan.maxConcurrent === undefined
            ? runtime
            : `${runtime} · at most ${plan.maxConcurrent} run at once`,
        detailSections: plan.entries.map((entry, index) => ({
          heading: `Thread ${index + 1}: ${entry.title}`,
          lines: [
            `Project: ${entry.projectId}`,
            `Model: ${entry.modelSelection.instanceId} · ${entry.modelSelection.model}`,
            `Runtime: ${entry.runtimeMode} · ${entry.envMode}`,
            ...(entry.returnToOrigin
              ? [
                  "Completion return: result or stop notice is sent back to the originating chat automatically, batched with sibling tasks.",
                ]
              : []),
            ...(entry.artifacts && entry.artifacts.length > 0
              ? [
                  `Handed-over artifacts: ${entry.artifacts.length} of the originating chat's pages/files, copied and attached to the first message.`,
                ]
              : []),
            ...(entry.localTaskId !== undefined
              ? [
                  `Task: started as the chat of task ${entry.localTaskId}, with the task's files on its first message.`,
                ]
              : []),
            ...(entry.tokenMode === undefined ? [] : [`Token mode: ${entry.tokenMode}`]),
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
    case "worktreeHandoff":
      return {
        actionLabel: "Move chat into a worktree",
        targetLabel: `thread ${shortId(plan.threadId)}`,
        runtimeLabel: null,
        detailSections: [
          {
            heading: "Worktree",
            lines: [
              `Branch: ${plan.branch}`,
              ...(plan.continuationPrompt === undefined ? [] : [plan.continuationPrompt]),
            ],
          },
        ],
      };
    case "pullRequestWatch":
      return {
        actionLabel: plan.watching ? "Watch pull request" : "Stop watching pull request",
        targetLabel: `thread ${shortId(plan.threadId)}`,
        runtimeLabel: null,
        detailSections: [
          {
            heading: plan.watching ? "Watch" : "Stop watching",
            lines: [
              `Thread: ${plan.threadId}`,
              `Pull request: ${plan.number === undefined ? (plan.url ?? "the chat's own") : `#${plan.number}`}`,
              ...(plan.watching
                ? [
                    "Ryco wakes the chat when a check fails, the required checks pass, someone else comments or reviews, or the branch conflicts.",
                  ]
                : []),
            ],
          },
        ],
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
      if (plan.goalStatus !== undefined) {
        changes.push(plan.goalStatus === "complete" ? "Mark goal complete" : "Mark goal blocked");
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
    case "workspaceLifecycle":
      return {
        actionLabel: `${plan.action} workspace`,
        targetLabel: plan.expected.workspaceId,
        runtimeLabel: null,
        detailSections: [
          {
            heading: "Exact workspace lifecycle plan",
            lines: [
              `Project: ${plan.projectId}`,
              `Workspace record: ${plan.expected.worktreeId}`,
              `Path: ${plan.expected.path}`,
              `Checkout action: ${plan.checkoutMode}`,
              `Branch: ${plan.expected.branch} (${plan.deleteBranch ? "delete" : "retain"})`,
              `Expected branch commit: ${plan.expected.branchHead ?? "missing"}`,
              `Branch merged: ${plan.expected.unmerged === false ? "yes" : "unverified"}`,
              `Expected revision: ${plan.expected.updatedAt}`,
              `Conversations: ${
                plan.sessions === "delete"
                  ? "deletion requested (always refused; conversations are never deleted by workspace actions)"
                  : plan.checkoutMode === "remove-checkout" ||
                      (plan.action !== "restore" && plan.expected.checkout === "missing")
                    ? "archived; history, attachments and terminal history kept"
                    : "unchanged; history kept"
              }`,
              ...plan.expected.sessions.map(
                (session) => `${session.threadId}${session.archived ? " (archived)" : ""}`,
              ),
              "Execution rechecks this plan. Interrupted filesystem steps are never replayed automatically.",
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
              ...runPolicyLines(plan.definition.runPolicy),
              ...executionLines(plan.definition.execution),
              "This approval authorizes only the schedule definition.",
              ...(plan.definition.runPolicy === "run-without-asking"
                ? []
                : ["Every due run creates a fresh exact proposal and waits for user approval."]),
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
              ...runPolicyLines(plan.before.definition.runPolicy),
              `Last changed: ${plan.before.updatedAt}`,
            ],
          },
          {
            heading: "After · schedule approval only",
            lines: [
              ...scheduleLines(plan.after.schedule),
              ...scheduleLimitLines,
              `Enabled: ${plan.after.enabled ? "yes" : "no"}`,
              ...runPolicyLines(plan.after.runPolicy),
              ...executionLines(plan.after.execution),
              "Pending, unaccepted runs from the old definition are cancelled.",
              "Already accepted or executing runs are not interrupted.",
              ...(plan.after.runPolicy === "run-without-asking"
                ? []
                : ["Future runs still require separate approval."]),
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
    case "deviceControlConsent":
      return {
        actionLabel: "Allow Device for this task",
        targetLabel: `device ${shortId(plan.udid)}`,
        runtimeLabel: "this task only",
        detailSections: [
          {
            heading: "Routine device actions until this response ends",
            lines: [
              "The agent may tap, swipe, type, press hardware buttons, scroll, launch installed apps and change simulator settings on this device.",
              "It can type into any app on the device, including its web browser.",
              "Installing apps, opening links directly, booting, attaching and shutting down still ask each time.",
              "Use Stop in chat to end the task. Messages sent while the agent is working continue it; the next task asks again.",
              `Device UDID: ${plan.udid}`,
              `Thread: ${plan.threadId}`,
              `Project: ${plan.projectId}`,
              `Provider instance: ${plan.providerInstanceId}`,
              "Nothing the agent types or taps is stored with this request.",
            ],
          },
        ],
      };
    case "importProject":
      return importProjectPresentation(plan);
    case "copyProjectToNode":
      return copyProjectToNodePresentation(plan);
    case "unsupported":
      return {
        actionLabel: "Unsupported request",
        targetLabel: plan.originalKind,
        runtimeLabel: null,
        detailSections: [
          {
            heading: "Needs a newer Ryco",
            lines: [
              `Request kind: ${plan.originalKind}`,
              "This version of Ryco cannot show what the request would do, so it cannot approve it.",
              "Update Ryco to review it, or reject it.",
            ],
          },
        ],
      };
  }
}

interface PlanPresentation {
  readonly actionLabel: string;
  readonly targetLabel: string;
  readonly runtimeLabel: string | null;
  readonly detailSections: ReadonlyArray<AgentControlDetailSection>;
  /** Used when the server sent no prompt summary. */
  readonly summary?: string;
}

type ProjectFollowUpThread = (
  | AgentControlImportProjectPlan
  | AgentControlCopyProjectToNodePlan
)["followUpThread"];

const projectFollowUpRuntimeLabel = (followUp: ProjectFollowUpThread): string | null =>
  followUp === null ? null : `${followUp.runtimeMode} · ${followUp.envMode}`;

/** The command verbatim, as its own line, so the card shows exactly what runs. */
const projectSetupSections = (
  setup: AgentControlImportProjectPlan["setup"],
  nodeLabel: string,
): ReadonlyArray<AgentControlDetailSection> =>
  setup === null
    ? []
    : [
        {
          heading: `Setup command · runs on ${nodeLabel} in the new project`,
          lines: [
            setup.command,
            setup.saveAsScript
              ? "Also saved as the project's setup script."
              : "Not saved as a project script.",
          ],
        },
      ];

const projectFollowUpSections = (
  followUp: ProjectFollowUpThread,
  defaultModelLabel: string,
): ReadonlyArray<AgentControlDetailSection> =>
  followUp === null
    ? []
    : [
        {
          heading: `Setup thread: ${followUp.title}`,
          lines: [
            followUp.modelSelection === null
              ? `Model: ${defaultModelLabel}`
              : `Model: ${followUp.modelSelection.instanceId} · ${followUp.modelSelection.model}`,
            `Runtime: ${followUp.runtimeMode} · ${followUp.envMode}`,
            "The repository's provider hooks and settings run in that thread.",
            `Prompt: ${followUp.prompt}`,
          ],
        },
      ];

/** Risk rows from the plan itself, so they show even before the server tags them. */
const projectRiskSection = (
  lines: ReadonlyArray<string>,
): ReadonlyArray<AgentControlDetailSection> =>
  lines.length === 0 ? [] : [{ heading: "Risk", lines }];

const projectRunsCommandsLine = (
  plan: AgentControlImportProjectPlan | AgentControlCopyProjectToNodePlan,
  nodeLabel: string,
): ReadonlyArray<string> => {
  const parts = [
    ...(plan.setup === null ? [] : ["a setup command"]),
    ...(plan.followUpThread === null ? [] : ["an agent thread"]),
  ];
  return parts.length === 0
    ? []
    : [`Runs commands: ${parts.join(" and ")} on ${nodeLabel}, in the new project.`];
};

/** Longer or multi-line commands are named only; the details show them whole, never cut. */
const SUMMARY_SETUP_COMMAND_MAX_CHARS = 120;

const projectSummaryExtras = (
  plan: AgentControlImportProjectPlan | AgentControlCopyProjectToNodePlan,
): string => {
  const command = plan.setup?.command;
  return [
    ...(command === undefined
      ? []
      : command.length <= SUMMARY_SETUP_COMMAND_MAX_CHARS && !command.includes("\n")
        ? [`runs \`${command}\``]
        : ["runs a setup command (see details)"]),
    ...(plan.followUpThread === null ? [] : [`starts "${plan.followUpThread.title}"`]),
  ]
    .map((part) => `; ${part}`)
    .join("");
};

function importProjectPresentation(plan: AgentControlImportProjectPlan): PlanPresentation {
  return {
    actionLabel: "Set up project",
    targetLabel: plan.title,
    runtimeLabel: projectFollowUpRuntimeLabel(plan.followUpThread),
    summary: `Clone ${plan.remoteUrl} into ${plan.destinationPath}${projectSummaryExtras(plan)}.`,
    detailSections: [
      {
        heading: "Clone and register on this node",
        lines: [
          `Repository: ${plan.remoteUrl}`,
          `Branch: ${plan.branch ?? "the repository's default branch"}`,
          `Folder: ${plan.destinationPath}`,
          `Project: ${plan.title} (${plan.projectId})`,
          ...(plan.setup === null ? ["Setup command: none"] : []),
          "The folder must be missing or empty; nothing in it is replaced.",
        ],
      },
      ...projectSetupSections(plan.setup, "this node"),
      ...projectFollowUpSections(plan.followUpThread, "this node's default"),
      ...projectRiskSection(projectRunsCommandsLine(plan, "this node")),
    ],
  };
}

/** Where the copy lands on the target, as the approving client resolves it. */
function copyDestinationLabel(plan: AgentControlCopyProjectToNodePlan): string {
  const codeDirectory = `${plan.target.label}'s code directory`;
  switch (plan.destination.kind) {
    case "default":
      return `a folder named after the source in ${codeDirectory}`;
    case "child-of-default":
      return `${plan.destination.name} in ${codeDirectory}`;
    case "path":
      return plan.destination.path;
  }
}

function copyProjectToNodePresentation(plan: AgentControlCopyProjectToNodePlan): PlanPresentation {
  const target = plan.target.label;
  const workspaceContent = [
    ...(plan.bringCommits ? ["unpushed commits"] : []),
    ...(plan.bringChanges ? ["uncommitted changes"] : []),
  ];
  const copied = [...workspaceContent, ...(plan.copySettings ? ["project settings"] : [])];
  return {
    actionLabel: `Copy to ${target}`,
    targetLabel: plan.source.title,
    runtimeLabel: projectFollowUpRuntimeLabel(plan.followUpThread),
    summary: `Copy ${plan.source.title} to ${copyDestinationLabel(plan)}${
      copied.length === 0 ? "" : `, with ${copied.join(", ")}`
    }${projectSummaryExtras(plan)}.`,
    detailSections: [
      {
        heading: `Copy to ${target}`,
        lines: [
          plan.source.kind === "project"
            ? `Source: project ${plan.source.title} (${plan.source.projectId}) on this node`
            : `Source: repository ${plan.source.remoteUrl}`,
          `Target node: ${target} (${plan.target.environmentId})`,
          `Destination: ${plan.destination.kind}`,
          `Folder: ${copyDestinationLabel(plan)}`,
          `Unpushed commits: ${plan.bringCommits ? "copied" : "not copied"}`,
          `Uncommitted changes: ${plan.bringChanges ? "copied" : "not copied"}`,
          `Project settings: ${plan.copySettings ? "copied" : "not copied"}`,
          ...(plan.setup === null ? ["Setup command: none"] : []),
          `Runs in the Ryco app that approves it, which must be connected to ${target}.`,
        ],
      },
      ...projectSetupSections(plan.setup, target),
      ...projectFollowUpSections(plan.followUpThread, `${target}'s default`),
      ...projectRiskSection([
        `Cross-node: creates a project on ${target}, not on the node the agent runs on.`,
        ...(workspaceContent.length === 0
          ? []
          : [`Copies workspace content: ${workspaceContent.join(" and ")} leave this node.`]),
        ...projectRunsCommandsLine(plan, target),
      ]),
    ],
  };
}

function outcomeLabel(proposal: AgentControlProposalView): string | null {
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

function executionPresentation(proposal: AgentControlProposalView): {
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
  proposal: AgentControlProposalView,
  getThreadTitle?: (threadId: ThreadId) => string | undefined,
): AgentControlProposalCardModel {
  const status = STATUS_PRESENTATION[proposal.status];
  const origin = originPresentation(proposal);
  const plan = planPresentation(proposal);
  const execution = executionPresentation(proposal);
  const originTitle = origin.threadId === null ? undefined : getThreadTitle?.(origin.threadId);
  const targetTitle =
    "threadId" in proposal.plan ? getThreadTitle?.(proposal.plan.threadId) : undefined;
  return {
    proposalId: proposal.proposalId,
    status: proposal.status,
    statusLabel: status.label,
    statusTone: status.tone,
    originLabel:
      originTitle && proposal.principal.kind === "provider-session"
        ? `Agent in ${originTitle} (${proposal.principal.providerInstanceId})`
        : origin.label,
    originThreadId: origin.threadId,
    actionLabel: plan.actionLabel,
    targetLabel:
      targetTitle &&
      "threadId" in proposal.plan &&
      plan.targetLabel === `thread ${shortId(proposal.plan.threadId)}`
        ? targetTitle
        : plan.targetLabel,
    runtimeLabel: plan.runtimeLabel,
    riskLabels: proposal.riskTags.map((tag) => riskLabelFromTag(String(tag))),
    isDestructive:
      proposal.plan.kind === "removeProject" ||
      proposal.plan.kind === "deleteLocalTask" ||
      (proposal.plan.kind === "workspaceLifecycle" && proposal.plan.action !== "restore"),
    warningLabel:
      proposal.plan.kind === "deviceOpenUrl"
        ? "High risk · opens an external URL or deep link"
        : null,
    summary: proposal.promptSummary ?? plan.summary ?? null,
    expiresAt: proposal.expiresAt,
    isPending: proposal.status === "pending-user-approval",
    outcomeLabel: outcomeLabel(proposal),
    executionLabel: execution.label,
    completionReturns: proposal.completionReturns,
    affectedThreadIds: execution.affectedThreadIds,
    affectedProjectIds: execution.affectedProjectIds,
    detailSections: plan.detailSections,
    unsupportedKind: proposal.plan.kind === "unsupported" ? proposal.plan.originalKind : null,
    requiresClientExecutor: isClientExecutedAgentControlPlan(proposal.plan),
    clientExecutionTarget: proposal.plan.kind === "copyProjectToNode" ? proposal.plan.target : null,
  };
}

function projectPreferenceLines(
  value: import("@ryco/contracts").AgentControlProjectPreferences,
): string[] {
  return Object.entries(value)
    .filter(([key]) => ["customSystemPrompt", "scripts", "preferredRemoteName"].includes(key))
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
}

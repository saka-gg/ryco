import { useState } from "react";
import {
  AgentControlAutomationId,
  type AgentControlAutomation,
  type AutomationCentreCommand,
  type AutomationCentreSnapshot,
  type EnvironmentId,
  type ProjectId,
  type ServerProvider,
} from "@ryco/contracts";
import {
  automationRunStatusLabel,
  filterAutomationRuns,
  type AutomationRunFilter,
} from "@ryco/client-runtime/state/agentControl";
import { Button } from "../ui/button";
import { AutomationEditor } from "./AutomationEditor";
import { AgentControlProposalCard } from "../agent-control/AgentControlProposalCard";
import { buildAgentControlProposalCardModel } from "@ryco/client-runtime/state/agentControl";
import type { AgentControlProposalId } from "@ryco/contracts";

type WithoutRequest<T> = T extends unknown ? Omit<T, "requestId"> : never;
export type AutomationCommandDraft = WithoutRequest<AutomationCentreCommand>;
export interface AutomationCentreViewProps {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  snapshot: AutomationCentreSnapshot | null;
  providers: ReadonlyArray<ServerProvider>;
  busy: boolean;
  error: string | null;
  disabledReason: string | null;
  onDecision: (proposalId: AgentControlProposalId, decision: "accept" | "reject") => Promise<void>;
  onRefresh: () => void;
  onCommand: (input: AutomationCommandDraft) => Promise<boolean>;
}
export function AutomationCentreView(props: AutomationCentreViewProps) {
  const [tab, setTab] = useState<"schedules" | "runs">("schedules");
  const [filter, setFilter] = useState<AutomationRunFilter>("unread");
  const [editor, setEditor] = useState<{
    id: AgentControlAutomationId;
    automation: AgentControlAutomation | null;
  } | null>(null);
  const disabled = props.busy || props.disabledReason !== null || props.snapshot === null;
  return (
    <section className="space-y-5" aria-label="Automation centre">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold">Automations</h2>
          <Button size="xs" variant="outline" onClick={props.onRefresh}>
            Refresh
          </Button>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Schedule a task, approve each occurrence, then follow its thread. The server must be
          running when work is due.
        </p>
      </header>
      {props.disabledReason && (
        <p role="status" className="text-xs text-muted-foreground">
          {props.disabledReason}
        </p>
      )}
      {props.error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 p-3 text-xs text-destructive"
        >
          {props.error}
        </p>
      )}
      {(props.snapshot?.unavailableRecords ?? 0) > 0 && (
        <p role="status" className="text-xs text-amber-600">
          {props.snapshot!.unavailableRecords} unavailable records were isolated. Other automations
          remain usable.
        </p>
      )}
      <div className="flex gap-1 border-b border-border pb-2" aria-label="Automation views">
        <Button
          size="sm"
          variant={tab === "schedules" ? "secondary" : "ghost"}
          aria-pressed={tab === "schedules"}
          onClick={() => setTab("schedules")}
        >
          Schedules
        </Button>
        <Button
          size="sm"
          variant={tab === "runs" ? "secondary" : "ghost"}
          aria-pressed={tab === "runs"}
          onClick={() => setTab("runs")}
        >
          Runs
          {props.snapshot ? ` · ${props.snapshot.runs.filter((r) => r.unread).length} unread` : ""}
        </Button>
      </div>
      {tab === "schedules" ? (
        <>
          {editor ? (
            <AutomationEditor
              key={editor.id}
              projectId={props.projectId}
              automationId={editor.id}
              automation={editor.automation}
              providers={props.providers}
              disabled={disabled}
              onCancel={() => setEditor(null)}
              onSave={async (definition) => {
                if (
                  await props.onCommand({
                    kind: "save",
                    projectId: props.projectId,
                    automationId: editor.id,
                    expectedRevision: editor.automation?.revision ?? null,
                    definition,
                  })
                )
                  setEditor(null);
              }}
            />
          ) : (
            <Button
              size="sm"
              disabled={disabled}
              onClick={() =>
                setEditor({
                  id: AgentControlAutomationId.make(crypto.randomUUID()),
                  automation: null,
                })
              }
            >
              New schedule
            </Button>
          )}
          {props.snapshot?.automations.length === 0 && (
            <p className="py-4 text-sm text-muted-foreground">
              No schedules yet. Create a one-time task or a bounded recurring task.
            </p>
          )}
          <ul className="divide-y divide-border">
            {props.snapshot?.automations.map((automation) => (
              <li key={automation.automationId} className="space-y-2 py-4">
                <div className="flex items-start justify-between gap-3">
                  <h3 className="min-w-0 break-words text-sm font-medium">
                    {automation.definition.execution.title}
                  </h3>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {automation.cancelled
                      ? "Cancelled"
                      : automation.enabled
                        ? "Scheduled"
                        : "Inactive"}
                  </span>
                </div>
                <p className="break-words text-xs text-muted-foreground">
                  {automation.definition.execution.modelSelection.instanceId} ·{" "}
                  {automation.definition.execution.modelSelection.model}
                </p>
                <p className="text-xs">
                  {automation.definition.schedule.kind === "once"
                    ? "Once"
                    : `Every ${automation.definition.schedule.intervalMs / 60000} minutes`}
                  {automation.nextRunAt
                    ? ` · Next ${new Date(automation.nextRunAt).toLocaleString()}`
                    : " · No future occurrence"}
                </p>
                <div className="flex gap-2">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={disabled || automation.cancelled}
                    onClick={() => setEditor({ id: automation.automationId, automation })}
                  >
                    Edit
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={disabled || automation.cancelled}
                    onClick={() =>
                      void props.onCommand({
                        kind: "cancel",
                        projectId: props.projectId,
                        automationId: automation.automationId,
                        expectedRevision: automation.revision,
                      })
                    }
                  >
                    Cancel schedule…
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Saving or cancelling creates a proposal for review below. Cancelling a schedule leaves
            already accepted work running.
          </p>
        </>
      ) : (
        <>
          <div className="flex gap-1">
            {(["unread", "failed", "all"] as const).map((value) => (
              <Button
                key={value}
                size="xs"
                variant={filter === value ? "secondary" : "ghost"}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {value === "unread" ? "Unread" : value === "failed" ? "Failed" : "All"}
              </Button>
            ))}
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            <strong className="font-medium text-foreground">
              Completion policy: dispatch only.
            </strong>{" "}
            Dispatched means the thread-start request completed. It does not mean the agent finished
            or succeeded. Open the thread to review progress or stop work.
          </p>
          <ul className="divide-y divide-border">
            {props.snapshot &&
              filterAutomationRuns(props.snapshot, filter).map(
                ({ run, execution, threadIds, unread, retryOfRunId }) => (
                  <li key={run.runId} className="space-y-2 py-4">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="break-words text-sm font-medium">
                        {execution?.title ?? "Execution details unavailable"}
                      </h3>
                      <span className="shrink-0 text-xs">
                        {automationRunStatusLabel[run.status]}
                      </span>
                    </div>
                    <p className="break-all font-mono text-[10px] text-muted-foreground">
                      Run {run.runId} · revision {run.automationRevision}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(run.scheduledFor).toLocaleString()}
                      {execution
                        ? ` · ${execution.modelSelection.instanceId} / ${execution.modelSelection.model}`
                        : ""}
                    </p>
                    {retryOfRunId && (
                      <p className="break-all text-xs text-muted-foreground">
                        Retry of {retryOfRunId}
                      </p>
                    )}
                    {run.safeFailureDetail && (
                      <p className="text-xs text-destructive">{run.safeFailureDetail}</p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={disabled}
                        onClick={() =>
                          void props.onCommand({
                            kind: "read",
                            projectId: props.projectId,
                            runId: run.runId,
                            expectedUpdatedAt: run.updatedAt,
                            unread: !unread,
                          })
                        }
                      >
                        {unread ? "Mark read" : "Mark unread"}
                      </Button>
                      {(["expired", "rejected"].includes(run.status) ||
                        (run.status === "cancelled" && run.proposalId === null)) &&
                        threadIds.length === 0 && (
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={disabled}
                            onClick={() =>
                              void props.onCommand({
                                kind: "retry",
                                projectId: props.projectId,
                                runId: run.runId,
                              })
                            }
                          >
                            Retry with approval
                          </Button>
                        )}
                      {threadIds.map((id) => (
                        <a
                          key={id}
                          className="text-xs text-primary underline"
                          href={`/${encodeURIComponent(props.environmentId)}/${encodeURIComponent(id)}`}
                        >
                          Open thread
                        </a>
                      ))}
                    </div>
                  </li>
                ),
              )}
          </ul>
          {props.snapshot && filterAutomationRuns(props.snapshot, filter).length === 0 && (
            <p className="py-4 text-sm text-muted-foreground">
              No {filter === "all" ? "" : `${filter} `}runs in the retained history.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Showing up to 50 recent project runs. Each schedule retains at most 50 outcomes. Quiet
            monitoring is unavailable without a proven unchanged result.
          </p>
        </>
      )}
      {props.snapshot?.proposals.map((proposal) => (
        <AgentControlProposalCard
          key={proposal.proposalId}
          model={buildAgentControlProposalCardModel(proposal)}
          environmentId={props.environmentId}
          isSubmitting={props.busy}
          decisionError={null}
          disabledReason={props.disabledReason}
          onAccept={() => void props.onDecision(proposal.proposalId, "accept")}
          onReject={() => void props.onDecision(proposal.proposalId, "reject")}
        />
      ))}
    </section>
  );
}

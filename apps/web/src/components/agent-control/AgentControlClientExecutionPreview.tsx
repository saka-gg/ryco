import type { AgentControlPlanFact } from "@ryco/client-runtime/state/agentControl";
import type { AgentControlProposalView, EnvironmentId } from "@ryco/contracts";

import { cn } from "../../lib/utils";
import { TruncatedPath, WrappingPath } from "../ui/path-text";
import { Spinner } from "../ui/spinner";
import {
  useAgentControlClientExecutionPreview,
  type AgentControlClientExecutor,
} from "./agentControlClientExecutor";

/** How the folder is tagged, as the copy dialog tags it: a taken name warns. */
function DestinationTag(props: { readonly tag: string }) {
  return (
    <span
      className={cn(
        "whitespace-nowrap rounded-full bg-muted px-1.5 py-px font-medium text-[10.5px]",
        props.tag === "renamed, folder exists"
          ? "text-warning-foreground"
          : props.tag === "unavailable"
            ? "text-destructive-foreground"
            : "text-muted-foreground",
      )}
    >
      {props.tag}
    </span>
  );
}

/** One plan fact's value: commands and paths verbatim, wrapping, never cut. */
function PlanFactValue(props: { readonly fact: AgentControlPlanFact }) {
  const { fact } = props;
  if (fact.format === "path") {
    return <WrappingPath path={fact.value} className="font-mono text-foreground select-text" />;
  }
  if (fact.format === "code") {
    return (
      <code className="whitespace-pre-wrap wrap-break-word rounded bg-muted px-1 py-px font-mono text-[11.5px] text-foreground select-text">
        {fact.value}
      </code>
    );
  }
  return <span className="text-foreground">{fact.value}</span>;
}

/** The facts as rows of the preview's grid (`dt` / `dd` pairs). */
function PlanFactRows(props: { readonly facts: ReadonlyArray<AgentControlPlanFact> }) {
  return props.facts.map((fact) => <PlanFactRow key={fact.label} fact={fact} />);
}

function PlanFactRow(props: { readonly fact: AgentControlPlanFact }) {
  return (
    <>
      <dt className="text-muted-foreground">{props.fact.label}</dt>
      <dd className="min-w-0">
        <PlanFactValue fact={props.fact} />
      </dd>
    </>
  );
}

/**
 * What a project request runs and carries (`AgentControlProposalCardModel.keyFacts`), shown
 * without expanding the plan: `card` as a small grid, `row` as the setup command alone under
 * the delegation dock's approval row. Renders nothing without facts.
 */
export function AgentControlPlanFacts(props: {
  readonly facts: ReadonlyArray<AgentControlPlanFact>;
  readonly variant: "card" | "row";
}) {
  const { facts, variant } = props;
  if (facts.length === 0) return null;
  if (variant === "row") {
    const command = facts.find((fact) => fact.format === "code");
    if (command === undefined) return null;
    return (
      <p
        data-testid="agent-control-plan-facts"
        className="flex min-w-0 items-baseline gap-1.5 px-3 pb-1.5 text-[11.5px] text-muted-foreground"
        title={command.value}
      >
        <span className="shrink-0">{command.label}</span>
        <code className="truncate font-mono text-foreground">{command.value}</code>
      </p>
    );
  }
  return (
    <dl
      data-testid="agent-control-plan-facts"
      className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-md border border-border/50 bg-background/60 px-3 py-2 text-xs"
    >
      <PlanFactRows facts={facts} />
    </dl>
  );
}

/**
 * What approving a client-executed proposal does on its target, before
 * Approve: the folder the copy lands in and the setup thread's model, as the
 * executor resolved them there, or why approving can't run it now, next to
 * the plan's own facts (`facts`: what it carries and the setup command it
 * runs). `card` lists them under the plan; `row` is one line under the
 * delegation dock's approval row. Without a preview the card still shows the
 * facts; the row then shows nothing.
 */
export function AgentControlClientExecutionPreview(props: {
  readonly executor: AgentControlClientExecutor | null;
  readonly environmentId: EnvironmentId;
  readonly proposal: AgentControlProposalView;
  /** A pending proposal this client can approve; otherwise nothing is resolved. */
  readonly enabled: boolean;
  readonly variant: "card" | "row";
  readonly facts?: ReadonlyArray<AgentControlPlanFact>;
}) {
  const { executor, environmentId, proposal, enabled, variant } = props;
  const facts = props.facts ?? [];
  const state = useAgentControlClientExecutionPreview(
    executor,
    { environmentId, proposal },
    enabled,
  );
  if (state === null || proposal.plan.kind !== "copyProjectToNode") {
    return variant === "card" ? <AgentControlPlanFacts facts={facts} variant="card" /> : null;
  }
  const targetLabel = proposal.plan.target.label;

  if (variant === "row") {
    if (state.status === "loading") {
      return (
        <p
          data-testid="agent-control-execution-preview"
          className="flex items-center gap-1.5 px-3 pb-1.5 text-[11.5px] text-muted-foreground"
        >
          <Spinner aria-hidden className="size-3" />
          Checking {targetLabel}…
        </p>
      );
    }
    const { preview } = state;
    return (
      <div
        data-testid="agent-control-execution-preview"
        className="px-3 pb-1.5 text-[11.5px] text-muted-foreground"
      >
        {preview.destination !== null ? (
          <p className="flex min-w-0 items-baseline gap-1.5">
            <span className="shrink-0">To</span>
            <TruncatedPath
              path={preview.destination.path}
              monospace
              className="font-mono text-foreground"
            />
            <span className="shrink-0">
              on {preview.targetLabel} · {preview.destination.tag}
            </span>
          </p>
        ) : null}
        {preview.sends !== undefined ? <p className="truncate">Sends: {preview.sends}</p> : null}
        {preview.followUpModel !== null ? (
          <p className="truncate">Setup thread: {preview.followUpModel}</p>
        ) : null}
        {preview.problem !== null ? (
          <p role="status" className="text-destructive-foreground">
            {preview.problem}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div
      data-testid="agent-control-execution-preview"
      className="mt-2 rounded-md border border-border/50 bg-background/60 px-3 py-2 text-xs"
    >
      <p className="font-medium text-foreground">On {targetLabel}</p>
      {state.status === "loading" ? (
        <>
          <p className="mt-1 flex items-center gap-1.5 text-muted-foreground">
            <Spinner aria-hidden className="size-3" />
            Checking {targetLabel}…
          </p>
          {facts.length > 0 ? (
            <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
              <PlanFactRows facts={facts} />
            </dl>
          ) : null}
        </>
      ) : (
        <>
          <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
            {state.preview.destination !== null ? (
              <>
                <dt className="text-muted-foreground">Folder</dt>
                <dd className="min-w-0">
                  <span className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                    <WrappingPath
                      path={state.preview.destination.path}
                      className="font-mono text-foreground select-text"
                    />
                    <DestinationTag tag={state.preview.destination.tag} />
                  </span>
                  {state.preview.destination.note !== null ? (
                    <span className="block text-muted-foreground">
                      {state.preview.destination.note}
                    </span>
                  ) : null}
                </dd>
              </>
            ) : null}
            <PlanFactRows facts={facts} />
            {state.preview.sends !== undefined ? (
              <>
                <dt className="text-muted-foreground">Sends</dt>
                <dd className="min-w-0 text-foreground">{state.preview.sends}</dd>
              </>
            ) : null}
            {state.preview.followUpModel !== null ? (
              <>
                <dt className="text-muted-foreground">Setup thread</dt>
                <dd className="min-w-0 text-foreground">{state.preview.followUpModel}</dd>
              </>
            ) : null}
          </dl>
          {state.preview.problem !== null ? (
            <p
              role="status"
              className={cn(
                "text-destructive-foreground",
                state.preview.destination !== null || state.preview.followUpModel !== null
                  ? "mt-1.5"
                  : "mt-1",
              )}
            >
              {state.preview.problem}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

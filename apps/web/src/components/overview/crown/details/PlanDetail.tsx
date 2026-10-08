import { CheckIcon } from "lucide-react";

import { cn } from "~/lib/utils";

import type { ActivePlanState } from "~/session-logic";
import { PlanExplanation, ProposedPlanDisclosure } from "../../overviewSections";
import {
  CrownDetailEmpty,
  CrownDetailHeading,
  type CrownDetailViewProps,
} from "./crownDetailPrimitives";

type PlanStepStatus = ActivePlanState["steps"][number]["status"];

/** The plan colour; `--crown-plan` is declared on the island root. */
const PLAN_COLOR = "var(--crown-plan, #a78bfa)";

/**
 * Step marker (`.pb`): completed fills with the plan colour, the active step
 * breathes (`crown-step-active` keyframes; the static ring is its first frame),
 * pending stays hollow.
 */
function PlanStepMarker({ status }: { status: PlanStepStatus }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "mt-px grid size-3.5 shrink-0 place-items-center rounded-full border-[1.5px] border-foreground/17 transition-[background-color,border-color] duration-300",
        status === "completed" &&
          "border-[color:var(--crown-plan,#a78bfa)] bg-[color:var(--crown-plan,#a78bfa)] text-background",
        status === "inProgress" &&
          "crown-step-active border-[color:var(--crown-plan,#a78bfa)] shadow-[0_0_0_2px_color-mix(in_srgb,var(--crown-plan,#a78bfa)_28%,transparent)]",
      )}
    >
      {status === "completed" ? <CheckIcon className="size-[9px]" strokeWidth={3} /> : null}
    </span>
  );
}

function PlanStepList({ steps }: { steps: ActivePlanState["steps"] }) {
  return (
    <ol className="m-0 list-none p-0">
      {steps.map((step) => (
        <li
          key={`${step.status}:${step.step}`}
          className="flex items-start gap-2 p-1"
          data-slot="crown-plan-step"
          data-status={step.status}
        >
          <PlanStepMarker status={step.status} />
          <span
            className={cn(
              "min-w-0",
              step.status === "completed" && "text-muted-foreground",
              step.status === "inProgress" && "font-medium",
            )}
          >
            {step.step}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function PlanDetail({ layout, variant }: CrownDetailViewProps) {
  const steps = layout.activePlan?.steps ?? [];
  const completed = steps.filter((step) => step.status === "completed").length;
  const percent = steps.length > 0 ? Math.round((completed / steps.length) * 100) : 0;
  const hasPlan =
    steps.length > 0 ||
    Boolean(layout.activePlan?.explanation) ||
    Boolean(layout.activeProposedPlan?.planMarkdown);

  return (
    <>
      <CrownDetailHeading
        section="plan"
        variant={variant}
        meta={steps.length > 0 ? `${completed}/${steps.length}` : undefined}
      />
      {hasPlan ? (
        <>
          {steps.length > 0 ? (
            <>
              <div
                className="mb-2 h-1 overflow-hidden rounded-[2px] bg-muted"
                role="progressbar"
                aria-label="Plan progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
              >
                <span
                  className="block h-full rounded-[inherit] transition-[width] duration-(--crown-dur-plan-bar) ease-(--crown-ease-out)"
                  style={{ width: `${percent}%`, background: PLAN_COLOR }}
                />
              </div>
              <PlanStepList steps={steps} />
            </>
          ) : null}
          {/* The shared blocks pad 12px; pull them onto the 4px row inset. */}
          <div className="-mx-2">
            <PlanExplanation activePlan={layout.activePlan} />
            <ProposedPlanDisclosure
              activeProposedPlan={layout.activeProposedPlan}
              environmentId={layout.environmentId}
              markdownCwd={layout.markdownCwd}
              workspaceRoot={layout.workspaceRoot}
              actionsLabel="Overview plan actions"
            />
          </div>
        </>
      ) : (
        <CrownDetailEmpty>No plan yet</CrownDetailEmpty>
      )}
    </>
  );
}

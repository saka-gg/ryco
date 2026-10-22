import {
  CheckIcon,
  CircleCheckIcon,
  CloudDownloadIcon,
  CloudUploadIcon,
  ExternalLinkIcon,
  GitCommitHorizontalIcon,
  GitPullRequestIcon,
  LoaderCircleIcon,
  RocketIcon,
  SparklesIcon,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";

import type { GitShipStep } from "../../../GitActionsControl.logic";
import { Button } from "../../../ui/button";
import type { OverviewLayoutProps } from "../../overviewTypes";
import type { CrownShipBinding } from "../crownTypes";
import { SyncMeta } from "./BranchDetail";
import {
  CROWN_PILL_BUTTON_CLASS,
  CrownDetailHeading,
  CrownGroupHeader,
} from "./crownDetailPrimitives";

const STEP_ICON: Readonly<Record<GitShipStep, LucideIcon>> = {
  pull: CloudDownloadIcon,
  commit: GitCommitHorizontalIcon,
  push: CloudUploadIcon,
  pr: GitPullRequestIcon,
};

type StepState = "todo" | "now" | "done";

function stepTitle(step: GitShipStep, changeRequestLabel: string): string {
  switch (step) {
    case "pull":
      return "Pull";
    case "commit":
      return "Commit";
    case "push":
      return "Push";
    case "pr":
      return `Create ${changeRequestLabel}`;
  }
}

function ShipStepRow({
  step,
  state,
  title,
  detail,
}: {
  step: GitShipStep;
  state: StepState;
  title: string;
  detail: string;
}) {
  const Icon = state === "done" ? CheckIcon : state === "now" ? LoaderCircleIcon : STEP_ICON[step];
  return (
    <li
      className={cn(
        "grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 rounded-[10px] bg-foreground/[0.04] px-[9px] py-[7px] text-muted-foreground shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)] transition-[background-color,color,box-shadow] duration-300",
        state === "now" &&
          "bg-info/14 text-info-foreground shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--info)_45%,transparent)]",
      )}
      data-slot="crown-ship-step"
      data-step={step}
      data-state={state}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "row-span-2 size-3",
          state === "now" && "crown-spin text-info-foreground",
          state === "done" && "text-success",
        )}
      />
      <span
        className={cn(
          "truncate text-[12px] font-semibold text-foreground",
          state === "done" && "text-muted-foreground",
        )}
      >
        {title}
      </span>
      <span className="truncate font-mono text-[10px] text-muted-foreground/60">{detail}</span>
    </li>
  );
}

/** The commit message line: written by the server unless the user types one. */
function CommitMessageRow({ ship }: { ship: CrownShipBinding }) {
  const [editing, setEditing] = useState(ship.commitMessage !== "");
  if (editing) {
    return (
      <input
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- opened by the Edit button right before.
        autoFocus
        aria-label="Commit message"
        className="mt-2 h-7 w-full rounded-[10px] border border-foreground/10 bg-foreground/[0.04] px-2.5 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-info/70"
        placeholder="Commit message"
        value={ship.commitMessage}
        onChange={(event) => ship.setCommitMessage(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            ship.ship();
          }
        }}
      />
    );
  }
  return (
    <p className="mt-2 flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground/60">
      <SparklesIcon aria-hidden="true" className="size-3" />
      <span>Commit message is written for you</span>
      <button
        type="button"
        className="rounded-sm text-info-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
        onClick={() => setEditing(true)}
      >
        Edit
      </button>
    </p>
  );
}

/**
 * The Ship button's hover preview: what one click runs, step by step, and the
 * run's progress once it starts. Single actions sit below for when the whole
 * chain is not wanted.
 */
export function ShipDetail({
  ship,
  layout,
}: {
  readonly ship: CrownShipBinding;
  readonly layout: OverviewLayoutProps;
}) {
  const changes = layout.changes;
  const active = ship.phase !== "idle";
  const steps = active ? ship.runSteps : ship.steps;
  const activeIndex = ship.activeStep ? steps.indexOf(ship.activeStep) : -1;

  const others = active ? null : (
    <div className="mt-2.5 flex flex-wrap gap-[5px]" data-slot="crown-ship-others">
      {ship.commitOnly ? (
        <Button
          variant="ghost"
          size="sm"
          className={cn(CROWN_PILL_BUTTON_CLASS, "h-6 px-2.5 text-[11px] sm:h-6 sm:text-[11px]")}
          onClick={ship.commitOnly}
        >
          <GitCommitHorizontalIcon aria-hidden="true" className="size-3" />
          Commit only
        </Button>
      ) : null}
      {ship.pull ? (
        <Button
          variant="ghost"
          size="sm"
          className={cn(CROWN_PILL_BUTTON_CLASS, "h-6 px-2.5 text-[11px] sm:h-6 sm:text-[11px]")}
          onClick={ship.pull}
        >
          <CloudDownloadIcon aria-hidden="true" className="size-3" />
          Pull
        </Button>
      ) : null}
      {ship.openPullRequest ? (
        <Button
          variant="ghost"
          size="sm"
          className={cn(CROWN_PILL_BUTTON_CLASS, "h-6 px-2.5 text-[11px] sm:h-6 sm:text-[11px]")}
          onClick={ship.openPullRequest}
        >
          <ExternalLinkIcon aria-hidden="true" className="size-3" />
          View {ship.changeRequestLabel}
        </Button>
      ) : null}
    </div>
  );

  return (
    <>
      <CrownDetailHeading
        section="branch"
        variant="flyout"
        title="Ship"
        meta={changes ? <SyncMeta changes={changes} /> : null}
      />
      {changes?.refName ? (
        <p className="-mt-1.5 mb-1 truncate px-1 font-mono text-[11px] text-muted-foreground">
          {changes.refName}
        </p>
      ) : null}
      {steps.length === 0 ? (
        <div
          className="flex flex-col items-center gap-1.5 px-2 pt-3.5 pb-1.5 text-center text-[12px] text-muted-foreground"
          data-slot="crown-ship-done"
        >
          <CircleCheckIcon aria-hidden="true" className="size-5.5 text-success" />
          <span>
            {ship.disabledReason ??
              (ship.openPullRequest
                ? `Nothing to ship. Everything is in the open ${ship.changeRequestLabel}.`
                : "Nothing to ship.")}
          </span>
        </div>
      ) : (
        <>
          <CrownGroupHeader
            label={
              ship.phase === "arming"
                ? "Starting…"
                : ship.phase === "running"
                  ? "Shipping"
                  : "One click will"
            }
            count={steps.length}
          />
          <ol className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Ship steps">
            {steps.map((step, index) => (
              <ShipStepRow
                key={step}
                step={step}
                state={
                  ship.phase !== "running" || index > activeIndex
                    ? "todo"
                    : index === activeIndex
                      ? "now"
                      : "done"
                }
                title={stepTitle(step, ship.changeRequestLabel)}
                detail={ship.stepDetails[step]}
              />
            ))}
          </ol>
          {!active && steps.includes("commit") ? <CommitMessageRow ship={ship} /> : null}
          {ship.phase === "running" ? null : (
            <p
              className="mt-3 flex items-center gap-2 rounded-xl bg-info/12 px-2.5 py-[9px] text-[11.5px] text-info-foreground"
              data-slot="crown-ship-hint"
            >
              {ship.phase === "arming" ? (
                <LoaderCircleIcon aria-hidden="true" className="crown-spin size-3.5" />
              ) : (
                <RocketIcon aria-hidden="true" className="size-3.5" />
              )}
              <span className="min-w-0 flex-1 truncate">
                {ship.phase === "arming" ? "Starting in a moment" : "Click the rocket to ship"}
              </span>
              <kbd className="rounded-md bg-foreground/8 px-1.5 py-0.5 font-sans text-[10px] font-semibold text-muted-foreground">
                {ship.phase === "arming" ? "Esc cancels" : "1 click"}
              </kbd>
            </p>
          )}
        </>
      )}
      {others}
    </>
  );
}

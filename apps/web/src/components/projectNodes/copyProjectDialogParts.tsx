// FILE: copyProjectDialogParts.tsx
// Purpose: The small pieces the copy dialog's form, its progress views and the
//          Projects page's Copies block share: section labels, radio dots,
//          a checkout's branch / changes / behind meta, mono-marked text, the
//          ring spinner, the bar and the progress step list.
// Layer: Web UI, loaded with the copy dialog (and the Copies block).

import { CheckIcon, GitBranchIcon, XIcon } from "lucide-react";
import { Fragment, type ReactNode } from "react";

import { cn } from "~/lib/utils";

import type {
  CopyCheckoutMeta,
  CopyProgressStep,
  CopyTextSegment,
} from "./copyProjectDialog.logic";

export function CopySectionLabel(props: {
  readonly children: ReactNode;
  readonly id?: string | undefined;
}) {
  return (
    <span
      id={props.id}
      className="font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]"
    >
      {props.children}
    </span>
  );
}

/** One labelled block of the form ("From", "To", "How", …). */
export function CopyField(props: {
  readonly label: ReactNode;
  readonly labelId?: string | undefined;
  readonly children: ReactNode;
  readonly className?: string | undefined;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", props.className)}>
      <CopySectionLabel id={props.labelId}>{props.label}</CopySectionLabel>
      {props.children}
    </div>
  );
}

/** The radio circle of a hand-rolled radio row; checked from the row's `data-checked`. */
export function CopyRadioDot(props: { readonly className?: string | undefined }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-3.5 shrink-0 place-items-center rounded-full border-[1.5px] border-muted-foreground transition-colors duration-(--app-motion-duration-chip)",
        "group-data-checked/radio:border-primary",
        "after:size-1.5 after:rounded-full after:bg-primary after:opacity-0 after:transition-opacity group-data-checked/radio:after:opacity-100",
        props.className,
      )}
    />
  );
}

/** Text with mono-marked paths and commands. */
export function CopySegments(props: { readonly segments: ReadonlyArray<CopyTextSegment> }) {
  return (
    <>
      {props.segments.map((segment, index) =>
        segment.mono ? (
          // oxlint-disable-next-line react/no-array-index-key -- segments are positional
          <span key={index} className="font-mono text-[11.5px]">
            {segment.text}
          </span>
        ) : (
          // oxlint-disable-next-line react/no-array-index-key -- segments are positional
          <Fragment key={index}>{segment.text}</Fragment>
        ),
      )}
    </>
  );
}

/** A checkout's branch, changed files and how far it is behind, from loaded status only. */
export function CopyCheckoutMetaLine(props: {
  readonly meta: CopyCheckoutMeta;
  readonly offline?: boolean;
  readonly isNew?: boolean;
  readonly className?: string | undefined;
}) {
  const { meta } = props;
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[11px] text-muted-foreground",
        props.className,
      )}
    >
      {props.offline ? <span>offline</span> : null}
      {props.isNew ? (
        <span className="inline-flex items-center rounded-full bg-primary/12 px-1.5 py-px text-[10.5px] text-foreground dark:bg-primary/20">
          new
        </span>
      ) : null}
      {meta.branch ? (
        <span className="inline-flex min-w-0 max-w-[16ch] items-center gap-[3px] font-mono">
          <GitBranchIcon aria-hidden className="size-2.5 shrink-0" />
          <span className="truncate">{meta.branch}</span>
        </span>
      ) : null}
      {meta.changed > 0 ? <span className="text-warning">{meta.changed} changed</span> : null}
      {meta.behind > 0 ? <span>↓{meta.behind}</span> : null}
    </span>
  );
}

/** The mockup's ring spinner. */
export function CopyRingSpinner(props: { readonly className?: string | undefined }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-3.5 shrink-0 animate-spin rounded-full border-2 border-muted border-t-primary [animation-duration:700ms]",
        props.className,
      )}
    />
  );
}

/** A thin progress bar. */
export function CopyBar(props: {
  readonly percent: number;
  readonly label?: string | undefined;
  readonly className?: string | undefined;
}) {
  const percent = Math.max(0, Math.min(100, props.percent));
  return (
    <div
      role="progressbar"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      className={cn("h-1 shrink-0 overflow-hidden rounded-[2px] bg-muted", props.className)}
    >
      <i
        className="block h-full bg-primary transition-[width] duration-100 ease-linear"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

function StepIcon(props: { readonly status: CopyProgressStep["status"] }) {
  switch (props.status) {
    case "done":
      return (
        <span className="mt-px grid size-4 shrink-0 place-items-center rounded-full bg-success text-white">
          <CheckIcon aria-hidden className="size-2.5" strokeWidth={3} />
        </span>
      );
    case "running":
      return <CopyRingSpinner className="mt-px" />;
    case "failed":
      return (
        <span className="mt-px grid size-4 shrink-0 place-items-center rounded-full bg-destructive text-white">
          <XIcon aria-hidden className="size-2.5" strokeWidth={3} />
        </span>
      );
    case "pending":
      return (
        <span
          aria-hidden
          className="mt-px size-3.5 shrink-0 rounded-full border-[1.5px] border-muted-foreground border-dashed opacity-60"
        />
      );
  }
}

/** The copy's steps: done, running (with its bar and latest line), failed or still to come. */
export function CopyProgressStepList(props: {
  readonly steps: ReadonlyArray<CopyProgressStep>;
  readonly className?: string | undefined;
  /** Defaults to "Copy steps". */
  readonly "aria-label"?: string | undefined;
}) {
  return (
    <ol
      className={cn("flex flex-col", props.className)}
      aria-label={props["aria-label"] ?? "Copy steps"}
    >
      {props.steps.map((step) => (
        <li
          key={step.id}
          data-step={step.id}
          data-status={step.status}
          className={cn(
            "grid grid-cols-[18px_minmax(0,1fr)] items-start gap-2.5 px-0.5 py-1.5 text-[12.5px]",
            step.status === "pending" && "text-muted-foreground",
          )}
        >
          <StepIcon status={step.status} />
          <div className="min-w-0">
            <span className="sr-only">{step.status}: </span>
            <CopySegments segments={step.label} />
            {step.status === "running" && step.percent !== null ? (
              <CopyBar percent={step.percent} className="mt-1.5" />
            ) : null}
            {step.log ? (
              <div
                className={cn(
                  "mt-[3px] truncate font-mono text-[11px] text-muted-foreground",
                  step.status === "failed" && "whitespace-normal text-destructive-foreground",
                )}
              >
                {step.log}
              </div>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

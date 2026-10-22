// FILE: AddProjectOutcome.tsx
// Purpose: What the add-project dialog shows once it acts: a clone or link running on the node
//          (the import's steps, its progress and output line), and the done step ("<name> is
//          on <node>", which nodes the project is on now and where).
// Layer: Web UI, presentational. `AddProjectDialog` owns the import and the added project.

import type { NodeCatalogEntry } from "@ryco/client-runtime/state/nodes";
import type { ProjectImportSnapshot } from "@ryco/contracts/project-copy";
import { CheckIcon } from "lucide-react";
import { useMemo } from "react";

import { cn } from "../../lib/utils";
import { projectImportStepLabel } from "./copyRuntime/projectCopyProgress.logic";
import {
  displayNodePath,
  importProgressRows,
  type AddedProjectNodeRow,
} from "./addProjectDialog.logic";
import { NodeBadge } from "./NodePicker";

/** The overall bar: the import's share done, eased between snapshots. */
export function ImportProgressBar(props: { readonly percent: number }) {
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={props.percent}
      className="h-1 shrink-0 overflow-hidden rounded-[2px] bg-muted"
    >
      <i
        className="block h-full bg-primary transition-[width] duration-100 ease-linear"
        style={{ width: `${props.percent}%` }}
      />
    </div>
  );
}

function StepMarker(props: { readonly status: "done" | "running" | "pending" | "failed" }) {
  switch (props.status) {
    case "done":
      return (
        <span className="grid size-4 shrink-0 place-items-center rounded-full bg-success text-white">
          <CheckIcon aria-hidden className="size-2.5" strokeWidth={3} />
        </span>
      );
    case "running":
      return (
        <span
          aria-hidden
          className="mt-px inline-block size-3.5 animate-spin rounded-full border-2 border-muted border-t-primary [animation-duration:700ms]"
        />
      );
    case "failed":
      return (
        <span className="grid size-4 shrink-0 place-items-center rounded-full bg-destructive font-semibold text-[10px] text-white">
          !
        </span>
      );
    default:
      return (
        <span
          aria-hidden
          className="mt-px size-3.5 rounded-full border-[1.5px] border-muted-foreground border-dashed opacity-60"
        />
      );
  }
}

/**
 * The steps the node runs for a clone or link, as they report: done, running
 * (with its bar and last output line), pending, failed.
 */
export function ImportProgressSteps(props: {
  readonly snapshot: ProjectImportSnapshot | null;
  /** Shown while the node has not answered yet. */
  readonly startingLabel: string;
}) {
  const rows = useMemo(
    () => (props.snapshot ? importProgressRows(props.snapshot) : null),
    [props.snapshot],
  );
  return (
    <div className="flex flex-col" data-testid="add-project-import-steps">
      {rows === null ? (
        <div className="grid grid-cols-[18px_1fr] items-start gap-2.5 px-0.5 py-1.5 text-[12.5px]">
          <StepMarker status="running" />
          <div>{props.startingLabel}</div>
        </div>
      ) : (
        rows.map((row) => (
          <div
            key={row.id}
            data-step={row.id}
            data-status={row.status}
            className={cn(
              "grid grid-cols-[18px_1fr] items-start gap-2.5 px-0.5 py-1.5 text-[12.5px]",
              row.status === "pending" && "text-muted-foreground",
            )}
          >
            <StepMarker status={row.status} />
            <div className="min-w-0">
              {projectImportStepLabel(row.id)}
              {row.status === "running" && row.percent !== null ? (
                <div className="mt-1.5">
                  <ImportProgressBar percent={Math.round(row.percent)} />
                </div>
              ) : null}
              {row.log ? (
                <div className="mt-[3px] truncate font-mono text-[11px] text-muted-foreground">
                  {row.log}
                </div>
              ) : null}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

/** The done step: the check, "<name> is on <node>", why it groups, and every node it is on. */
export function AddedProjectSummary(props: {
  readonly name: string;
  readonly node: NodeCatalogEntry;
  readonly lead: string;
  readonly rows: ReadonlyArray<AddedProjectNodeRow>;
  readonly nodes: ReadonlyArray<NodeCatalogEntry>;
}) {
  const nodeById = useMemo(
    () => new Map(props.nodes.map((entry) => [entry.environmentId, entry] as const)),
    [props.nodes],
  );
  return (
    <>
      <div className="flex flex-col items-center gap-1.5 pt-1.5 pb-1 text-center">
        <div className="grid size-11 place-items-center rounded-full bg-success/20 text-success motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:duration-200">
          <CheckIcon aria-hidden className="size-[22px]" strokeWidth={2.25} />
        </div>
        <h3 className="mt-1 mb-0 font-semibold text-[16px] text-foreground">
          {props.name} is on {props.node.label}
        </h3>
        <p className="m-0 text-muted-foreground">{props.lead}</p>
      </div>
      <div
        className="overflow-hidden rounded-[10px] border border-border"
        data-testid="add-project-node-list"
      >
        {props.rows.map((row) => {
          const node = nodeById.get(row.environmentId);
          if (!node) return null;
          return (
            <div
              key={`${row.environmentId}\u0000${row.cwd}`}
              className="flex items-center gap-2 border-border px-2.5 py-2 text-[12.5px] not-first:border-t"
            >
              <NodeBadge node={node} size="sm" />
              <span className="w-[104px] shrink-0 truncate">{node.label}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground">
                {displayNodePath(row.cwd)}
              </span>
              {row.isNew ? (
                <span className="inline-flex items-center whitespace-nowrap rounded-full bg-primary/10 px-1.5 py-px text-[10.5px] text-foreground dark:bg-primary/18">
                  new
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </>
  );
}

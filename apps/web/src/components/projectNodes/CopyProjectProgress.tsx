// FILE: CopyProjectProgress.tsx
// Purpose: The copy dialog once a copy started: its progress (overall bar,
//          step list with the clone's and the upload's lines, whether Ryco must
//          stay open, Cancel and "Run in background"), the finished copy ("<name>
//          is on <D>" with the project's nodes and "Start a thread on <D>") and
//          a failure with its retry ("Send files instead", "Resume").
// Layer: Web UI inside `CopyProjectDialog`, following `copyManager`'s entry for
//        the copy; the wording is shared with the toasts (`projectCopyView`).

import type { NodeCatalogEntry } from "@ryco/client-runtime/state/nodes";
import { CheckIcon, CopyIcon, TriangleAlertIcon } from "lucide-react";
import { useRef } from "react";

import { getGitStatusSnapshot } from "../../lib/gitStatusState";
import type { Project } from "../../types";
import { Button } from "../ui/button";
import { DialogTitle } from "../ui/dialog";
import { projectCopyView } from "@ryco/client-runtime/projectCopy/progressView";
import type { ProjectCopyEntry } from "./copyRuntime/copyManager";
import {
  copyCheckoutMeta,
  copyOverallPercent,
  copyProgressFooter,
  copyProgressSteps,
} from "@ryco/client-runtime/projectCopy/dialog";
import {
  CopyBar,
  CopyCheckoutMetaLine,
  CopyProgressStepList,
  CopyRingSpinner,
} from "./copyProjectDialogParts";
import type { StartedProjectCopy } from "./CopyProjectForm";
import { displayProjectPath } from "@ryco/shared/projectPaths";
import { NodeBadge } from "./NodePicker";
import { NODE_LABEL_CELL, NodePathText, useNodeLabelColumn } from "./NodePathText";

const FOOTER_CLASS =
  "flex shrink-0 items-center gap-2 border-border border-t bg-muted/30 px-5 py-3";
const SUMMARY_CLASS = "min-w-0 flex-1 truncate text-[12px] text-muted-foreground";

export interface CopyProjectProgressProps {
  readonly copy: StartedProjectCopy;
  readonly entry: ProjectCopyEntry | null;
  readonly nodes: ReadonlyArray<NodeCatalogEntry>;
  /** The project's checkouts as the client knows them now (the new one joins once synced). */
  readonly members: ReadonlyArray<Project>;
  readonly retrying: boolean;
  readonly onCancel: () => void;
  readonly onBackground: () => void;
  readonly onRetry: () => void;
  readonly onStartThread: () => void;
  readonly onClose: () => void;
}

export function CopyProjectProgress(props: CopyProjectProgressProps) {
  const { copy, entry } = props;
  if (entry === null) {
    return (
      <>
        <div className="flex items-center gap-2.5 px-5 pt-4 pb-3">
          <DialogTitle className="flex min-w-0 flex-1 items-center gap-2 font-semibold text-[15px] leading-tight">
            <CopyIcon aria-hidden className="size-[15px] shrink-0" />
            <span className="truncate">
              Copying {copy.title} to {copy.targetLabel}
            </span>
          </DialogTitle>
        </div>
        <div className="flex items-center gap-2 px-5 pb-5 text-[12.5px] text-muted-foreground">
          <CopyRingSpinner />
          Starting…
        </div>
      </>
    );
  }
  const view = projectCopyView(entry.progress, {
    title: entry.title ?? copy.title,
    sourceLabel: entry.sourceLabel,
    targetLabel: entry.targetLabel ?? copy.targetLabel,
  });
  const steps = copyProgressSteps(entry.progress, copy.context, entry.throughput);
  switch (view.kind) {
    case "done":
      return <DoneView {...props} entry={entry} />;
    case "failed":
      return (
        <>
          <div className="flex items-center gap-2.5 ps-5 pe-12 pt-4 pb-3">
            <DialogTitle className="flex min-w-0 flex-1 items-center gap-2 font-semibold text-[15px] leading-tight">
              <TriangleAlertIcon aria-hidden className="size-[15px] shrink-0 text-destructive" />
              <span className="truncate">{view.title}</span>
            </DialogTitle>
          </div>
          <div
            className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 pb-4"
            data-testid="copy-project-failed"
          >
            <p className="m-0 rounded-lg bg-destructive/8 px-2.5 py-2 text-[12.5px] text-destructive-foreground">
              {view.description}
            </p>
            <CopyProgressStepList steps={steps} />
          </div>
          <div className={FOOTER_CLASS}>
            <span className={SUMMARY_CLASS}>
              {entry.progress.canCloseClient
                ? `Nothing more runs on ${copy.targetLabel}.`
                : "Nothing was left running."}
            </span>
            <Button size="sm" variant="outline" onClick={props.onClose}>
              Close
            </Button>
            {view.retryLabel && entry.hasPlan ? (
              <Button size="sm" disabled={props.retrying} onClick={props.onRetry}>
                {view.retryLabel === "Send files instead" && entry.sourceLabel
                  ? `Send from ${entry.sourceLabel} instead`
                  : view.retryLabel}
              </Button>
            ) : null}
          </div>
        </>
      );
    case "cancelled":
    case "progress": {
      const percent = copyOverallPercent(steps, entry.progress);
      return (
        <>
          <div className="flex items-center gap-2.5 px-5 pt-4 pb-3">
            <DialogTitle className="flex min-w-0 flex-1 items-center gap-2 font-semibold text-[15px] leading-tight">
              <CopyIcon aria-hidden className="size-[15px] shrink-0" />
              <span className="truncate">
                Copying {entry.title ?? copy.title} to {copy.targetLabel}
              </span>
            </DialogTitle>
            <span className="text-[11.5px] text-muted-foreground tabular-nums">{percent}%</span>
          </div>
          <div
            className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 pb-4"
            data-testid="copy-project-progress"
          >
            <CopyBar percent={percent} label={`Copying ${copy.title}`} />
            <CopyProgressStepList steps={steps} />
          </div>
          <div className={FOOTER_CLASS}>
            <span className={SUMMARY_CLASS} data-testid="copy-progress-footer">
              {copyProgressFooter(entry.progress, copy.targetLabel, entry.throughput)}
            </span>
            <Button size="sm" variant="outline" onClick={props.onCancel}>
              Cancel
            </Button>
            <Button size="sm" variant="outline" onClick={props.onBackground}>
              Run in background
            </Button>
          </div>
        </>
      );
    }
  }
}

interface DoneRow {
  readonly key: string;
  readonly node: NodeCatalogEntry | null;
  readonly label: string;
  readonly path: string;
  readonly isNew: boolean;
  /** Null for the new checkout before its project synced here. */
  readonly project: Project | null;
}

function DoneView(props: CopyProjectProgressProps & { readonly entry: ProjectCopyEntry }) {
  const { copy, entry, nodes } = props;
  const project = entry.project;
  const title = entry.title ?? copy.title;
  const rows: DoneRow[] = props.members.map((member) => ({
    key: `${member.environmentId}\u0000${member.id}`,
    node: nodes.find((node) => node.environmentId === member.environmentId) ?? null,
    label:
      nodes.find((node) => node.environmentId === member.environmentId)?.label ??
      (member.environmentId === copy.targetEnvironmentId ? copy.targetLabel : "Device"),
    path: member.cwd,
    isNew:
      project !== null &&
      member.environmentId === project.environmentId &&
      member.id === project.projectId,
    project: member,
  }));
  // The new checkout joins the list once the destination's projects synced here.
  if (project && !rows.some((row) => row.isNew)) {
    rows.push({
      key: `${project.environmentId}\u0000${project.projectId}`,
      node: nodes.find((node) => node.environmentId === project.environmentId) ?? null,
      label: copy.targetLabel,
      path: project.workspaceRoot ?? entry.progress.importSnapshot?.destinationPath ?? "",
      isNew: true,
      project: null,
    });
  }
  const nodeCount = new Set(rows.map((row) => row.node?.environmentId ?? row.label).filter(Boolean))
    .size;
  const listRef = useRef<HTMLDivElement | null>(null);
  useNodeLabelColumn(listRef, rows.map((row) => row.label).join("\u0000"));
  const warnings = project?.warnings ?? entry.progress.importSnapshot?.warnings ?? [];
  return (
    <>
      <div className="h-11" aria-hidden />
      <div
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 pb-4"
        data-testid="copy-project-done"
      >
        <div className="flex flex-col items-center gap-1.5 pt-1.5 pb-1 text-center">
          <div className="project-copy-pop grid size-11 place-items-center rounded-full bg-success/20 text-success">
            <CheckIcon aria-hidden className="size-[22px]" />
          </div>
          <DialogTitle className="mt-1 font-semibold text-[16px] leading-tight">
            {title} is on {copy.targetLabel}
          </DialogTitle>
          <p className="m-0 text-[13px] text-muted-foreground">
            {nodeCount > 1
              ? `One project on ${nodeCount} nodes. Threads can start on any of them.`
              : "Ready for threads."}
          </p>
        </div>
        <div ref={listRef} className="overflow-hidden rounded-[10px] border border-border">
          {rows.map((row) => (
            <div
              key={row.key}
              className="flex items-center gap-2 border-border px-2.5 py-2 text-[12.5px] not-first:border-t"
            >
              {row.node ? <NodeBadge node={row.node} size="sm" /> : null}
              <span
                className="w-(--node-label-column,104px) shrink-0 truncate"
                {...NODE_LABEL_CELL}
              >
                {row.label}
              </span>
              <NodePathText
                path={displayProjectPath(row.path)}
                title={row.path}
                className="flex-1 font-mono text-[11.5px] text-muted-foreground"
              />
              <CopyCheckoutMetaLine
                isNew={row.isNew}
                meta={
                  row.project
                    ? copyCheckoutMeta(
                        getGitStatusSnapshot({
                          environmentId: row.project.environmentId,
                          cwd: row.project.cwd,
                        }).data,
                      )
                    : { branch: null, changed: 0, behind: 0 }
                }
              />
            </div>
          ))}
        </div>
        {warnings.length > 0 ? (
          <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Warnings">
            {warnings.map((warning) => (
              <li key={warning} className="flex gap-1.5 text-[11.5px] text-warning">
                <TriangleAlertIcon aria-hidden className="mt-0.5 size-3 shrink-0" />
                <span className="min-w-0 [overflow-wrap:anywhere]">{warning}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className={FOOTER_CLASS}>
        <span className={SUMMARY_CLASS} />
        <Button size="sm" variant="outline" onClick={props.onClose}>
          Done
        </Button>
        <Button size="sm" disabled={project === null} onClick={props.onStartThread}>
          Start a thread on {copy.targetLabel}
        </Button>
      </div>
    </>
  );
}

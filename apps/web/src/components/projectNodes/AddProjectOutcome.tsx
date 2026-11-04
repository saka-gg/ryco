// FILE: AddProjectOutcome.tsx
// Purpose: What the add-project dialog shows once it acts: a clone or link running on the node
//          (the import's steps, its progress and output line), and the done step ("<name> is
//          on <node>", which nodes the project is on now and where).
// Layer: Web UI, presentational. `AddProjectDialog` owns the import and the added project.

import type { NodeCatalogEntry } from "@ryco/client-runtime/state/nodes";
import type { ProjectImportSnapshot } from "@ryco/contracts/project-copy";
import { CheckIcon } from "lucide-react";
import { useMemo, useRef } from "react";

import { importProgressSteps, type AddedProjectNodeRow } from "./addProjectDialog.logic";
import type { CopyProgressStep } from "./copyProjectDialog.logic";
import { CopyProgressStepList } from "./copyProjectDialogParts";
import { displayProjectPath } from "../../lib/projectPaths";
import { NodeBadge } from "./NodePicker";
import { NODE_LABEL_CELL, NodePathText, useNodeLabelColumn } from "./NodePathText";

/**
 * The steps the node runs for a clone or link, as they report: done, running
 * (with its bar and last output line), pending, failed. Rendered by the copy
 * dialog's step list, so both dialogs show a node's import the same way.
 */
export function ImportProgressSteps(props: {
  readonly snapshot: ProjectImportSnapshot | null;
  /** Shown while the node has not answered yet. */
  readonly startingLabel: string;
}) {
  const { snapshot, startingLabel } = props;
  const steps = useMemo<ReadonlyArray<CopyProgressStep>>(
    () =>
      snapshot
        ? importProgressSteps(snapshot)
        : [
            {
              id: "starting",
              label: [{ text: startingLabel }],
              status: "running",
              percent: null,
              log: null,
              weight: 1,
            },
          ],
    [snapshot, startingLabel],
  );
  return (
    <div data-testid="add-project-import-steps">
      <CopyProgressStepList steps={steps} aria-label="Import steps" />
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
  const listRef = useRef<HTMLDivElement | null>(null);
  useNodeLabelColumn(listRef, props.rows);
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
        ref={listRef}
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
              <span
                className="w-(--node-label-column,104px) shrink-0 truncate"
                {...NODE_LABEL_CELL}
              >
                {node.label}
              </span>
              <NodePathText
                path={displayProjectPath(row.cwd)}
                title={row.cwd}
                className="flex-1 font-mono text-[11.5px] text-muted-foreground"
              />
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

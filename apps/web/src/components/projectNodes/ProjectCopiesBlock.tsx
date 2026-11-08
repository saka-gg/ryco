// FILE: ProjectCopiesBlock.tsx
// Purpose: The Projects page's "Copies" block (A36(3)): this project's copies
//          to other nodes that run or did not finish, from this client's copies
//          and stored records plus the imports the already connected nodes
//          report (`projects.listImports`; a node is never woken for it). Each
//          row offers View log, Retry, Resume and Discard leftover
//          (`projects.discardImport`). A copy the user started whose upload
//          stopped when Ryco closed resumes through the copy dialog.
// Layer: Web UI, loaded on demand by the devices section of the Projects page
//        (a settings block of its own; nothing when there is no row).

import type { NodeCatalogEntry } from "@ryco/client-runtime/state/nodes";
import { projectCopyResumeKind } from "@ryco/client-runtime/projectCopy";
import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import { XIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { useNodeCatalog } from "../../environments/nodeCatalog";
import { cn, randomUUID } from "../../lib/utils";
import { SettingsBlock } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import {
  discardProjectCopy,
  forgetProjectCopy,
  openInterruptedProjectCopy,
  projectCopyResumesInDialog,
  resumeProjectCopy,
  retryProjectCopy,
  useProjectCopyEntries,
  useProjectCopyRecords,
} from "./copyRuntime/copyManager";
import { callNodeWithLease } from "./copyRuntime/webProjectCopyIo";
import {
  copyProgressSteps,
  projectCopyRows,
  type CopyProgressContext,
  type NodeImportReport,
  type ProjectCopyRow,
} from "@ryco/client-runtime/projectCopy/dialog";
import { CopyBar, CopyProgressStepList } from "./copyProjectDialogParts";
import { displayProjectPath } from "@ryco/shared/projectPaths";
import { useNodeRead } from "./nodePathQueries";
import { NodeBadge } from "./NodePicker";

/** How often running imports only a node reports are read again. */
const RUNNING_IMPORT_REFRESH_MS = 10_000;

export interface ProjectCopiesBlockProps {
  /** Every checkout of the project, on every node. */
  readonly members: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
    readonly name: string;
  }>;
}

/** The connected nodes that can report imports, with their APIs as they are now. */
function reportingNodes(nodes: ReadonlyArray<NodeCatalogEntry>) {
  return nodes.flatMap((node) => {
    if (node.presence !== "online" || node.projectCopySupport !== "yes") return [];
    const listImports = readEnvironmentApi(node.environmentId)?.projects.listImports;
    return listImports ? [{ environmentId: node.environmentId, listImports }] : [];
  });
}

function useNodeImports(
  nodes: ReadonlyArray<NodeCatalogEntry>,
  refresh: string,
): ReadonlyArray<NodeImportReport> {
  const reporting = reportingNodes(nodes);
  const key = reporting.map((node) => node.environmentId).join("\u0000");
  const read = useNodeRead<ReadonlyArray<NodeImportReport>>(
    reporting.length > 0 ? `${key}\u0000${refresh}` : null,
    reporting.length > 0
      ? async () => {
          const results = await Promise.allSettled(
            reporting.map(async (node) =>
              (await node.listImports({})).imports.map((snapshot) => ({
                environmentId: node.environmentId,
                snapshot,
              })),
            ),
          );
          return results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
        }
      : null,
    { keepPrevious: true },
  );
  return read.data ?? [];
}

function logContext(row: ProjectCopyRow): CopyProgressContext {
  return {
    sourceLabel: null,
    targetLabel: row.targetLabel,
    mode: "clone",
    remoteUrl: null,
    branch: null,
    destinationPath: row.snapshot?.destinationPath ?? "",
    targetHome: null,
    changeCount: 0,
    setupCommand: null,
    uploads: false,
    bringsCommits: false,
    bringsChanges: false,
    copiesSettings: false,
    followUp: false,
  };
}

const STATUS_LABEL: Record<ProjectCopyRow["status"], string> = {
  running: "Copying",
  failed: "Failed",
  interrupted: "Stopped",
  cancelled: "Stopped",
};

export function ProjectCopiesBlock(props: ProjectCopiesBlockProps) {
  const nodes = useNodeCatalog();
  const entries = useProjectCopyEntries();
  const records = useProjectCopyRecords();
  const [refresh, setRefresh] = useState(0);
  // A copy that ends here reads the imports again.
  const settledCopies = Object.values(entries).filter((entry) => !entry.running).length;
  const imports = useNodeImports(nodes, `${refresh}\u0000${settledCopies}`);
  const [openLog, setOpenLog] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const rows = useMemo(
    () =>
      projectCopyRows({
        entries: Object.values(entries),
        records,
        imports,
        memberProjectIds: new Set(props.members.map((member) => member.id)),
        projectNames: new Set(props.members.map((member) => member.name.trim().toLowerCase())),
        labelOf: (environmentId) =>
          nodes.find((node) => node.environmentId === environmentId)?.label ?? "Device",
        isResumable: (record) => projectCopyResumeKind(record) !== "none",
        resumesInDialog: projectCopyResumesInDialog,
      }),
    [entries, imports, nodes, props.members, records],
  );

  // An import only a node reports that still runs is read again now and then.
  const runningOnNodes = rows.some((row) => row.status === "running" && row.copyId === null);
  useEffect(() => {
    if (!runningOnNodes) return;
    const timer = globalThis.setInterval(
      () => setRefresh((value) => value + 1),
      RUNNING_IMPORT_REFRESH_MS,
    );
    return () => globalThis.clearInterval(timer);
  }, [runningOnNodes]);

  if (rows.length === 0) return null;

  const act = async (row: ProjectCopyRow, action: () => Promise<unknown>) => {
    setBusy(row.key);
    try {
      await action();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "That didn't work",
        description: error instanceof Error ? error.message : String(error),
      });
    }
    // After the try, not in a `finally`: React Compiler does not lower one.
    setBusy(null);
    setRefresh((value) => value + 1);
  };

  const discard = (row: ProjectCopyRow) =>
    act(row, async () => {
      const leftover = row.leftover;
      if (!leftover) return;
      const result = await callNodeWithLease(
        leftover.environmentId,
        (api) => {
          const discardImport = api.projects.discardImport;
          if (!discardImport) throw new Error(`${row.targetLabel} can't discard leftovers.`);
          return discardImport({ importId: leftover.importId });
        },
        { copyId: randomUUID() },
      );
      if (result.deleted) {
        if (row.copyId) forgetProjectCopy(row.copyId);
        toastManager.add({
          type: "success",
          title: "Leftover removed",
          description: displayProjectPath(leftover.path),
        });
      } else {
        toastManager.add({
          type: "warning",
          title: "Nothing was removed",
          description: result.reason ?? undefined,
        });
      }
    });

  return (
    <SettingsBlock
      className="flex flex-col gap-1.5 py-2.5"
      data-testid="project-copies"
      role="group"
      aria-label="Copies"
    >
      <span className="font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]">
        Copies
      </span>
      {rows.map((row) => {
        const node = nodes.find((entry) => entry.environmentId === row.targetEnvironmentId);
        const entry = row.copyId ? entries[row.copyId] : undefined;
        const logOpen = openLog === row.key;
        const steps =
          entry !== undefined
            ? copyProgressSteps(entry.progress, logContext(row))
            : row.snapshot
              ? copyProgressSteps(
                  {
                    copyId: row.key,
                    phase: row.status === "running" ? "import" : "failed",
                    uploadedBytes: 0,
                    totalBytes: 0,
                    importSnapshot: row.snapshot,
                    canCloseClient: true,
                    error: null,
                  },
                  logContext(row),
                )
              : [];
        return (
          <div
            key={row.key}
            data-testid="project-copy-row"
            data-status={row.status}
            className="flex flex-col gap-1.5 rounded-lg border border-border/70 px-2.5 py-2"
          >
            <div className="flex min-w-0 items-center gap-2 text-[12.5px]">
              {node ? <NodeBadge node={node} size="sm" /> : null}
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{row.title}</span> → {row.targetLabel}
                <span
                  className={cn(
                    "ms-2 text-[11.5px] text-muted-foreground",
                    row.status === "failed" && "text-destructive-foreground",
                  )}
                >
                  {STATUS_LABEL[row.status]}
                  {row.percent !== null ? ` · ${row.percent}%` : ""}
                </span>
              </span>
              {row.canDismiss && row.copyId ? (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={
                    row.resumeInDialog
                      ? `Discard the copy to ${row.targetLabel}`
                      : `Dismiss the copy to ${row.targetLabel}`
                  }
                  onClick={() =>
                    row.resumeInDialog
                      ? discardProjectCopy(row.copyId!)
                      : forgetProjectCopy(row.copyId!)
                  }
                >
                  <XIcon />
                </Button>
              ) : null}
            </div>
            {row.status === "running" && row.percent !== null ? (
              <CopyBar percent={row.percent} label={`Copying ${row.title}`} />
            ) : null}
            <span className="text-[11.5px] text-muted-foreground [overflow-wrap:anywhere]">
              {row.description}
            </span>
            <div className="flex flex-wrap items-center gap-1.5">
              {steps.length > 0 || row.snapshot?.outputTail ? (
                <Button
                  size="xs"
                  variant="ghost"
                  aria-expanded={logOpen}
                  onClick={() => setOpenLog(logOpen ? null : row.key)}
                >
                  {logOpen ? "Hide log" : "View log"}
                </Button>
              ) : null}
              {row.retryLabel && row.copyId ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy === row.key}
                  onClick={() => void act(row, () => retryProjectCopy(row.copyId!))}
                >
                  {row.retryLabel}
                </Button>
              ) : null}
              {row.canResume && row.copyId ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy === row.key}
                  onClick={() =>
                    row.resumeInDialog
                      ? openInterruptedProjectCopy(row.copyId!)
                      : void act(row, () => resumeProjectCopy(row.copyId!))
                  }
                >
                  Resume
                </Button>
              ) : null}
              {row.leftover ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy === row.key}
                  title={row.leftover.path}
                  onClick={() => void discard(row)}
                >
                  Discard leftover
                </Button>
              ) : null}
            </div>
            {logOpen ? (
              <div className="flex flex-col gap-1.5" data-testid="project-copy-log">
                <CopyProgressStepList steps={steps} />
                {row.snapshot?.outputTail ? (
                  <pre className="m-0 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
                    {row.snapshot.outputTail}
                  </pre>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </SettingsBlock>
  );
}

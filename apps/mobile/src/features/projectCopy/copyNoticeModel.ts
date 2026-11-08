import type { ProjectCopyJobRecord } from "@ryco/client-runtime/projectCopy";
import type { ProjectCopyEntry } from "@ryco/client-runtime/projectCopy/manager";

import type { SFSymbol } from "../../components/AppSymbol";
import type { ProjectCopyNotice } from "./mobileCopyManager";

/**
 * Where the copy notice's Show opens the copy screen: on the checkout the copy
 * started from, else (a clone or link the add-project flow handed over) on the
 * project it makes on its destination. Null when neither is known yet.
 */
export function copyNoticeLinkPath(
  record: ProjectCopyJobRecord | null,
  entry: Pick<ProjectCopyEntry, "sourceRef" | "targetEnvironmentId" | "project"> | null,
): string | null {
  const source = entry?.sourceRef ?? null;
  if (source !== null) return `projects/${source.environmentId}/${source.projectId}/copy`;
  if (record?.sourceEnvironmentId && record.sourceProjectId) {
    return `projects/${record.sourceEnvironmentId}/${record.sourceProjectId}/copy`;
  }
  const projectId = entry?.project?.projectId ?? record?.projectId ?? null;
  const environmentId = entry?.targetEnvironmentId ?? record?.targetEnvironmentId ?? null;
  return projectId && environmentId ? `projects/${environmentId}/${projectId}/copy` : null;
}

export interface CopyNoticeTone {
  readonly symbol: SFSymbol;
  /** The second line: the status, with the percent while it runs. */
  readonly detail: string;
}

/** The notice's icon and second line. */
export function copyNoticeTone(notice: Pick<ProjectCopyNotice, "kind" | "view">): CopyNoticeTone {
  const view = notice.view;
  if (notice.kind === "interrupted") {
    return { symbol: "pause.circle", detail: view.description };
  }
  if ("kind" in view) {
    if (view.kind === "progress") {
      const percent = view.percent === null ? "" : ` · ${Math.round(view.percent)}%`;
      return { symbol: "arrow.triangle.2.circlepath", detail: `${view.description}${percent}` };
    }
    if (view.kind === "done") return { symbol: "checkmark.circle", detail: view.description };
    if (view.kind === "failed") {
      return { symbol: "exclamationmark.triangle", detail: view.description };
    }
  }
  return { symbol: "xmark.circle", detail: view.description };
}

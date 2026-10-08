import { EyeIcon } from "lucide-react";

import { cn } from "~/lib/utils";

import { Button } from "../../../ui/button";
import { ChangedFileList, COMPACT_DIFF_STAT_CLASS, DiffStat } from "../../overviewSections";
import { getOverviewSummary, pickChangesItem } from "../../overviewSummary.logic";
import type { OverviewChangedFile } from "../../overviewTypes";
import {
  CROWN_PILL_BUTTON_CLASS,
  CrownDetailActions,
  CrownDetailEmpty,
  CrownDetailHeading,
  CrownGroupHeader,
  type CrownDetailViewProps,
} from "./crownDetailPrimitives";

/** The card lists at most this many files per group; the flyout lists all of them. */
const CARD_MAX_FILE_ROWS = 5;

/** The 4px insertions / deletions split bar (`.splitbar`). */
function SplitBar({ additions, deletions }: { additions: number; deletions: number }) {
  const segment =
    "block h-full transition-[flex-grow] duration-700 ease-[cubic-bezier(0.16,1,0.3,1)]";
  return (
    <div
      aria-hidden="true"
      className="mb-1 flex h-1 gap-0.5 overflow-hidden rounded-[2px]"
      data-slot="crown-changes-split-bar"
    >
      <span className={cn(segment, "bg-success")} style={{ flexGrow: additions }} />
      <span
        className={cn(segment, "bg-destructive")}
        style={{ flexGrow: Math.max(deletions, 1) }}
      />
    </div>
  );
}

function FileGroup({
  label,
  files,
  maxRows,
}: {
  label: string | null;
  files: ReadonlyArray<OverviewChangedFile>;
  maxRows: number | undefined;
}) {
  if (files.length === 0) return null;
  return (
    <>
      {label ? <CrownGroupHeader label={label} count={files.length} /> : null}
      <ChangedFileList files={files} maxRows={maxRows} />
    </>
  );
}

export function ChangesDetail({ layout, variant }: CrownDetailViewProps) {
  const summary = getOverviewSummary(layout);
  const files = layout.changes?.files ?? [];
  const changesItem = pickChangesItem(layout.overviewItems);
  const maxRows = variant === "card" ? CARD_MAX_FILE_ROWS : undefined;
  const local = files.filter((file) => file.category === "local");
  const committed = files.filter((file) => file.category === "committed");
  const uncategorised = files.filter((file) => file.category === undefined);
  const hasChanges = files.length > 0 || Boolean(changesItem);

  return (
    <>
      <CrownDetailHeading
        section="changes"
        variant={variant}
        meta={
          summary.hasDiff ? (
            <DiffStat
              additions={summary.additions}
              deletions={summary.deletions}
              className={COMPACT_DIFF_STAT_CLASS}
            />
          ) : null
        }
      />
      {hasChanges ? (
        <>
          {summary.hasDiff ? (
            <SplitBar additions={summary.additions} deletions={summary.deletions} />
          ) : null}
          {/* Sources that can't tell local from committed render one flat list. */}
          <FileGroup label={null} files={uncategorised} maxRows={maxRows} />
          <FileGroup label="Local" files={local} maxRows={maxRows} />
          <FileGroup label="Committed" files={committed} maxRows={maxRows} />
          {files.length === 0 && changesItem ? (
            <p className="flex items-center justify-between gap-2 px-1 py-1">
              <span className="truncate">{changesItem.value}</span>
              {changesItem.detail ? (
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {changesItem.detail}
                </span>
              ) : null}
            </p>
          ) : null}
          {layout.onOpenReview ? (
            <CrownDetailActions>
              <Button
                variant="ghost"
                size="sm"
                className={CROWN_PILL_BUTTON_CLASS}
                onClick={layout.onOpenReview}
              >
                <EyeIcon aria-hidden="true" className="size-3.5" />
                Open review
              </Button>
            </CrownDetailActions>
          ) : null}
        </>
      ) : (
        <CrownDetailEmpty>No file changes</CrownDetailEmpty>
      )}
    </>
  );
}

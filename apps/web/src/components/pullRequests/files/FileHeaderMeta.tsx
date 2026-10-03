import { ChevronRightIcon, CopyIcon, ExternalLinkIcon, MoreHorizontalIcon } from "lucide-react";
import { memo } from "react";

import { openExternalLink } from "../../../lib/openExternalLink";
import { cn } from "../../../lib/utils";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../ui/menu";
import { DiffStat } from "../primitives";
import { FileThreadCount, StaleViewedDot, ViewedCheckbox } from "./FileMarks";
import type { FileThreadCounts } from "./FileTreePane";
import { splitFilePath, type FileViewedState } from "./pullRequestFiles.logic";
import type { PullRequestDiffFile } from "./usePullRequestDiffFiles";

const STATUS_WORD: Partial<Record<PullRequestDiffFile["status"], string>> = {
  added: "Added",
  deleted: "Deleted",
  renamed: "Renamed",
};

/**
 * A file path that keeps the file name whole and gives way in the middle:
 * `apps/…/pullRequests/PullRequestStackRail.tsx`. The first directory stays,
 * the rest truncates from its start, and the name never shrinks.
 */
export function MiddleTruncatedPath(props: {
  readonly path: string;
  readonly muted?: boolean | undefined;
  readonly className?: string | undefined;
}) {
  const { directory, name } = splitFilePath(props.path);
  const slash = directory.indexOf("/");
  const head = slash === -1 ? directory : directory.slice(0, slash + 1);
  const rest = slash === -1 ? "" : directory.slice(slash + 1);
  return (
    <span
      className={cn("flex min-w-0 items-baseline font-mono text-[12.5px]", props.className)}
      title={props.path}
    >
      {head ? <span className="shrink-0 text-muted-foreground/80">{head}</span> : null}
      {rest ? (
        <span className="min-w-0 shrink truncate text-muted-foreground/80 [direction:rtl]">
          <bdi>{rest}</bdi>
        </span>
      ) : null}
      <span
        className={cn(
          "shrink-0 font-medium",
          props.muted ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {name}
      </span>
    </span>
  );
}

/**
 * The sticky header of one file in the diff: disclosure + path, then the
 * file's facts (conversations, size, viewed) and a quiet ⋯ for copying the
 * path or opening the file at the head commit.
 */
export const FileHeaderMeta = memo(function FileHeaderMeta(props: {
  readonly file: PullRequestDiffFile;
  readonly open: boolean;
  readonly onToggleOpen: () => void;
  readonly threads: FileThreadCounts | undefined;
  readonly viewedState: FileViewedState | undefined;
  readonly viewedSupported: boolean;
  readonly viewedDisabled: boolean;
  readonly onToggleViewed: (viewed: boolean) => void;
  readonly headUrl: string | null;
  readonly onCopyPath: () => void;
}) {
  const { file } = props;
  const statusWord = STATUS_WORD[file.status];
  const viewed = props.viewedState === "viewed";
  return (
    <div className="flex h-10 min-w-0 items-center gap-2">
      <button
        type="button"
        aria-expanded={props.open}
        aria-label={`${props.open ? "Collapse" : "Expand"} ${file.path}`}
        onClick={props.onToggleOpen}
        className="group/file-toggle flex h-full min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-(--app-motion-duration-chip) ease-(--app-motion-spring-snappy) group-hover/file-toggle:text-foreground",
            props.open && "rotate-90",
          )}
        />
        <MiddleTruncatedPath path={file.path} muted={viewed} />
        {statusWord ? (
          <span
            className="shrink-0 text-[11px] text-muted-foreground"
            title={
              file.status === "renamed" && file.previousPath
                ? `Renamed from ${file.previousPath}`
                : undefined
            }
          >
            {statusWord}
          </span>
        ) : null}
      </button>
      <div className="flex shrink-0 items-center gap-2.5">
        {props.threads ? (
          <FileThreadCount total={props.threads.total} unresolved={props.threads.unresolved} />
        ) : null}
        <DiffStat additions={file.additions} deletions={file.deletions} />
        {props.viewedSupported ? (
          <span className="flex items-center gap-1.5">
            {props.viewedState === "stale" ? <StaleViewedDot /> : null}
            <ViewedCheckbox
              path={file.path}
              state={props.viewedState}
              withLabel
              disabled={props.viewedDisabled}
              onToggle={props.onToggleViewed}
            />
          </span>
        ) : null}
        <Menu>
          <MenuTrigger
            render={
              <button
                type="button"
                aria-label={`More for ${file.path}`}
                className="-ml-1 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <MoreHorizontalIcon className="size-3.5" />
              </button>
            }
          />
          <MenuPopup align="end" className="min-w-48">
            <MenuItem onClick={props.onCopyPath}>
              <CopyIcon aria-hidden />
              Copy path
            </MenuItem>
            {props.headUrl ? (
              <MenuItem
                onClick={() =>
                  props.headUrl && openExternalLink(props.headUrl, "Unable to open the file")
                }
              >
                <ExternalLinkIcon aria-hidden />
                View at head
              </MenuItem>
            ) : null}
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
});

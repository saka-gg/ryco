import type { SourceControlChangeRequestCommit } from "@ryco/contracts";
import {
  ChevronDownIcon,
  Columns2Icon,
  GitCommitHorizontalIcon,
  ListTreeIcon,
  Rows2Icon,
  SlidersHorizontalIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { useDiffLayout, type DiffRenderMode } from "../../../hooks/useDiffLayout";
import { cn } from "../../../lib/utils";
import { rovingRadioGroup, type RovingRadioOption } from "../../ui/roving-radio-group";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { KeyHint } from "../primitives";
import { usePullRequestSelection, usePullRequestsPage } from "../PullRequestsPageContext";
import { usePullRequestsShortcut } from "../pullRequestsShortcuts";
import {
  toggleFileTree,
  useFileTreeShown,
  usePullRequestFilesUiStore,
} from "./pullRequestFilesStore";

const ALL_COMMITS = "__all__";
const DIFF_LAYOUT_OPTIONS: ReadonlyArray<RovingRadioOption<DiffRenderMode>> = [
  { value: "stacked" },
  { value: "split" },
];
/**
 * Off Conversation the bar also carries the stack chip and the next action,
 * so the Files tools fold into "View" before the bar's own compact width.
 */
const FILES_TOOLS_FOLD_WIDTH = 1040;

const TOOL_BUTTON_CLASS =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[pressed=true]:bg-accent data-[pressed=true]:text-foreground";

function ToolTooltip(props: {
  readonly label: string;
  readonly shortcut: string;
  readonly children: React.ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={props.children} />
      <TooltipPopup side="bottom" sideOffset={4}>
        <span className="inline-flex items-center gap-1.5">
          {props.label}
          <KeyHint>{props.shortcut}</KeyHint>
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * Files-tab tools in the bar: which commits the diff covers (C), unified or
 * split (U), and the file tree (F). On narrower readers they fold into one
 * "View" menu so the bar keeps a single line.
 */
export function FilesBarTools() {
  const { layout, nav, model } = usePullRequestsPage();
  const selection = usePullRequestSelection();
  // Without single-commit diffs there is no commit scope to pick.
  const scopable = model.capabilities.commitDiffs;
  const commits = selection.detail.data?.commits ?? [];
  const commitSha = nav.search.commit ?? null;
  const [diffLayout, setDiffLayout] = useDiffLayout();
  const treeShown = useFileTreeShown(layout.treeDocked);
  const menuOpen = usePullRequestFilesUiStore((state) => state.commitMenuOpen);
  const setMenuOpen = usePullRequestFilesUiStore((state) => state.setCommitMenuOpen);

  const scope = (sha: string | null) => nav.scopeToCommit(sha ?? undefined);
  const toggleLayout = () => setDiffLayout(diffLayout === "split" ? "stacked" : "split");

  usePullRequestsShortcut("c", () => setMenuOpen(true), { tab: "files", enabled: scopable });
  usePullRequestsShortcut("u", toggleLayout, { tab: "files" });
  usePullRequestsShortcut("f", () => toggleFileTree(layout.treeDocked), { tab: "files" });

  if (layout.barCompact || layout.readerWidth < FILES_TOOLS_FOLD_WIDTH) {
    return (
      <ViewMenu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        scopable={scopable}
        commits={commits}
        commitSha={commitSha}
        onScope={scope}
        diffLayout={diffLayout}
        onDiffLayout={setDiffLayout}
        treeShown={treeShown}
        onToggleTree={() => toggleFileTree(layout.treeDocked)}
      />
    );
  }

  const layoutGroup = rovingRadioGroup<DiffRenderMode>({
    options: DIFF_LAYOUT_OPTIONS,
    value: diffLayout === "split" ? "split" : "stacked",
    onChange: setDiffLayout,
  });

  return (
    <div className="flex items-center gap-0.5">
      {scopable ? (
        <CommitScopeMenu
          open={menuOpen}
          onOpenChange={setMenuOpen}
          commits={commits}
          commitSha={commitSha}
          onScope={scope}
        />
      ) : null}
      <div
        role="radiogroup"
        aria-label="Diff layout"
        className="flex items-center"
        onKeyDown={layoutGroup.onKeyDown}
      >
        <ToolTooltip label="Unified" shortcut="U">
          <button
            {...layoutGroup.radio("stacked")}
            aria-label="Unified diff"
            data-pressed={diffLayout !== "split"}
            className={TOOL_BUTTON_CLASS}
          >
            <Rows2Icon className="size-3.5" />
          </button>
        </ToolTooltip>
        <ToolTooltip label="Split" shortcut="U">
          <button
            {...layoutGroup.radio("split")}
            aria-label="Split diff"
            data-pressed={diffLayout === "split"}
            className={TOOL_BUTTON_CLASS}
          >
            <Columns2Icon className="size-3.5" />
          </button>
        </ToolTooltip>
      </div>
      <ToolTooltip label={treeShown ? "Hide file tree" : "Show file tree"} shortcut="F">
        <button
          type="button"
          aria-label="File tree"
          aria-pressed={treeShown}
          data-pressed={treeShown}
          onClick={() => toggleFileTree(layout.treeDocked)}
          className={TOOL_BUTTON_CLASS}
        >
          <ListTreeIcon className="size-3.5" />
        </button>
      </ToolTooltip>
      <span aria-hidden className="mx-1.5 h-4 w-px bg-border/70" />
    </div>
  );
}

function commitLabel(commit: SourceControlChangeRequestCommit): string {
  return commit.messageHeadline.trim() || commit.shortOid;
}

/** The diff's commit scope: every commit (default) or exactly one. */
function CommitScopeMenu(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly commits: ReadonlyArray<SourceControlChangeRequestCommit>;
  readonly commitSha: string | null;
  readonly onScope: (sha: string | null) => void;
}) {
  const scoped = props.commits.find((commit) => commit.oid === props.commitSha) ?? null;
  const scopedIndex = scoped ? props.commits.indexOf(scoped) : -1;
  return (
    <Menu open={props.open} onOpenChange={props.onOpenChange}>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <button
                  type="button"
                  aria-label={scoped ? `Showing commit ${scoped.shortOid}` : "Showing all commits"}
                  className={cn(
                    "inline-flex h-7 max-w-[15rem] min-w-0 items-center gap-1.5 rounded-md px-2 text-xs outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent",
                    scoped ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {scoped ? (
                    <>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {scopedIndex + 1}/{props.commits.length}
                      </span>
                      <span className="shrink-0 font-mono text-[11px]">{scoped.shortOid}</span>
                      <span className="min-w-0 truncate">{commitLabel(scoped)}</span>
                    </>
                  ) : (
                    <span>All commits</span>
                  )}
                  <ChevronDownIcon aria-hidden className="size-3 shrink-0 opacity-70" />
                </button>
              }
            />
          }
        />
        <TooltipPopup side="bottom" sideOffset={4}>
          <span className="inline-flex items-center gap-1.5">
            Commits
            <KeyHint>C</KeyHint>
          </span>
        </TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" className="w-[22rem] max-w-[calc(100vw-2rem)]">
        <CommitRadioItems
          commits={props.commits}
          commitSha={props.commitSha}
          onScope={props.onScope}
        />
      </MenuPopup>
    </Menu>
  );
}

function CommitRadioItems(props: {
  readonly commits: ReadonlyArray<SourceControlChangeRequestCommit>;
  readonly commitSha: string | null;
  readonly onScope: (sha: string | null) => void;
}) {
  return (
    <MenuRadioGroup
      value={props.commitSha ?? ALL_COMMITS}
      onValueChange={(value) => props.onScope(value === ALL_COMMITS ? null : String(value))}
    >
      <MenuRadioItem value={ALL_COMMITS} className="grid-cols-[1rem_minmax(0,1fr)]">
        <span className="flex min-w-0 items-baseline gap-2">
          <span>All commits</span>
          <span className="text-xs text-muted-foreground tabular-nums">{props.commits.length}</span>
        </span>
      </MenuRadioItem>
      {props.commits.length > 0 ? <MenuSeparator /> : null}
      {props.commits.map((commit) => (
        <MenuRadioItem
          key={commit.oid}
          value={commit.oid}
          className="grid-cols-[1rem_minmax(0,1fr)]"
        >
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
              {commit.shortOid}
            </span>
            <span className="min-w-0 truncate">{commitLabel(commit)}</span>
          </span>
        </MenuRadioItem>
      ))}
    </MenuRadioGroup>
  );
}

/** Narrow readers: commits, layout and the tree behind one "View" menu. */
function ViewMenu(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The host serves single-commit diffs (the commit submenu exists). */
  readonly scopable: boolean;
  readonly commits: ReadonlyArray<SourceControlChangeRequestCommit>;
  readonly commitSha: string | null;
  readonly onScope: (sha: string | null) => void;
  readonly diffLayout: DiffRenderMode;
  readonly onDiffLayout: (layout: DiffRenderMode) => void;
  readonly treeShown: boolean;
  readonly onToggleTree: () => void;
}): ReactNode {
  const scoped = props.commits.find((commit) => commit.oid === props.commitSha) ?? null;
  return (
    <Menu open={props.open} onOpenChange={props.onOpenChange}>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <button
                  type="button"
                  aria-label={scoped ? `View options, commit ${scoped.shortOid}` : "View options"}
                  className={cn(
                    "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md text-muted-foreground outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent",
                    scoped ? "px-2" : "w-7 justify-center",
                  )}
                >
                  <SlidersHorizontalIcon aria-hidden className="size-3.5" />
                  {scoped ? (
                    <span className="font-mono text-[11px] text-foreground">{scoped.shortOid}</span>
                  ) : null}
                </button>
              }
            />
          }
        />
        <TooltipPopup side="bottom" sideOffset={4}>
          View
        </TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" className="min-w-56">
        {props.scopable ? (
          <>
            <MenuSub>
              <MenuSubTrigger>
                <GitCommitHorizontalIcon aria-hidden />
                <span className="flex-1">{scoped ? scoped.shortOid : "All commits"}</span>
                <MenuShortcut>C</MenuShortcut>
              </MenuSubTrigger>
              <MenuSubPopup className="w-[20rem] max-w-[calc(100vw-2rem)]">
                <CommitRadioItems
                  commits={props.commits}
                  commitSha={props.commitSha}
                  onScope={props.onScope}
                />
              </MenuSubPopup>
            </MenuSub>
            <MenuSeparator />
          </>
        ) : null}
        <MenuGroup>
          <MenuGroupLabel>Layout</MenuGroupLabel>
          <MenuRadioGroup
            value={props.diffLayout}
            onValueChange={(value) => props.onDiffLayout(value as DiffRenderMode)}
          >
            <MenuRadioItem value="stacked">Unified</MenuRadioItem>
            <MenuRadioItem value="split">Split</MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuCheckboxItem checked={props.treeShown} onCheckedChange={props.onToggleTree}>
          <span className="flex items-center justify-between gap-4">
            File tree
            <MenuShortcut>F</MenuShortcut>
          </span>
        </MenuCheckboxItem>
      </MenuPopup>
    </Menu>
  );
}

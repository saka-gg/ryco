import { memo, useCallback, useMemo, useState } from "react";
import {
  buildTurnDiffTree,
  type TurnDiffTreeEntryInput,
  type TurnDiffTreeNode,
} from "../../lib/turnDiffTree";
import { ChevronRightIcon, FolderIcon, FolderClosedIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";
import { VscodeEntryIcon } from "./VscodeEntryIcon";
import { WindowedRows } from "./WindowedRows";

const EMPTY_DIRECTORY_OVERRIDES: Record<string, boolean> = {};
// Above this many files in expanded folders, only the rows in view render.
const VIRTUALIZE_AFTER_FILES = 250;
// Rows are a fixed height so a long tree can lay them out without measuring
// each one; the probe adds the 2px gap that separates them.
const ROW_HEIGHT_CLASS = "h-6 phone:h-11";
const ROW_STRIDE_CLASS = "h-6.5 phone:h-11.5";

interface ChangedFilesTreeRow {
  readonly node: TurnDiffTreeNode;
  readonly depth: number;
}

const treeRowKey = (row: ChangedFilesTreeRow) => `${row.node.kind}:${row.node.path}`;

export const ChangedFilesTree = memo(function ChangedFilesTree(props: {
  files: ReadonlyArray<TurnDiffTreeEntryInput>;
  allDirectoriesExpanded: boolean;
  resolvedTheme: "light" | "dark";
  onSelectFile: (filePath: string) => void;
  selectedFilePath?: string | null;
  showStats?: boolean;
  /** Makes file rows draggable: the caller writes what the drag carries. */
  onFileDragStart?: ((filePath: string, transfer: DataTransfer) => void) | undefined;
  onFileDragEnd?: (() => void) | undefined;
}) {
  const {
    files,
    allDirectoriesExpanded,
    onSelectFile,
    resolvedTheme,
    selectedFilePath = null,
    showStats = true,
    onFileDragStart,
    onFileDragEnd,
  } = props;
  const treeNodes = useMemo(() => buildTurnDiffTree(files), [files]);
  const directoryPathsKey = useMemo(
    () => collectDirectoryPaths(treeNodes).join("\u0000"),
    [treeNodes],
  );
  const expansionStateKey = `${allDirectoriesExpanded ? "expanded" : "collapsed"}\u0000${directoryPathsKey}`;
  const [directoryExpansionState, setDirectoryExpansionState] = useState<{
    key: string;
    overrides: Record<string, boolean>;
  }>(() => ({
    key: expansionStateKey,
    overrides: {},
  }));
  const expandedDirectories =
    directoryExpansionState.key === expansionStateKey
      ? directoryExpansionState.overrides
      : EMPTY_DIRECTORY_OVERRIDES;

  const toggleDirectory = useCallback(
    (pathValue: string) => {
      setDirectoryExpansionState((current) => {
        const nextOverrides = current.key === expansionStateKey ? current.overrides : {};
        return {
          key: expansionStateKey,
          overrides: {
            ...nextOverrides,
            [pathValue]: !(nextOverrides[pathValue] ?? allDirectoriesExpanded),
          },
        };
      });
    },
    [allDirectoriesExpanded, expansionStateKey],
  );

  const rows = useMemo(
    () => collectExpandedRows(treeNodes, expandedDirectories, allDirectoriesExpanded),
    [allDirectoriesExpanded, expandedDirectories, treeNodes],
  );
  const virtualized = useMemo(() => {
    let fileCount = 0;
    for (const row of rows) {
      if (row.node.kind === "file") fileCount += 1;
    }
    return fileCount > VIRTUALIZE_AFTER_FILES;
  }, [rows]);

  const renderRow = ({ node, depth }: ChangedFilesTreeRow) => {
    const leftPadding = 8 + depth * 14;
    if (node.kind === "directory") {
      const isExpanded = expandedDirectories[node.path] ?? allDirectoriesExpanded;
      return (
        <button
          type="button"
          data-scroll-anchor-ignore
          aria-expanded={isExpanded}
          className={cn(
            "group/tree-row flex w-full items-center gap-1.5 rounded-md pr-2 text-left hover:bg-background/80",
            ROW_HEIGHT_CLASS,
          )}
          style={{ paddingLeft: `${leftPadding}px` }}
          onClick={() => toggleDirectory(node.path)}
        >
          <ChevronRightIcon
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground/70 transition-transform",
              isExpanded && "rotate-90",
            )}
          />
          {isExpanded ? (
            <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/75" />
          ) : (
            <FolderClosedIcon className="size-3.5 shrink-0 text-muted-foreground/75" />
          )}
          <span
            data-tree-label
            className="truncate font-mono text-[11px] text-muted-foreground/90 group-hover/tree-row:text-foreground/90"
          >
            {node.name}
          </span>
          {showStats && hasNonZeroStat(node.stat) && (
            <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums">
              <DiffStatLabel additions={node.stat.additions} deletions={node.stat.deletions} />
            </span>
          )}
        </button>
      );
    }

    return (
      <button
        type="button"
        className={cn(
          "group/tree-row flex w-full items-center gap-1.5 rounded-md pr-2 text-left hover:bg-background/80",
          ROW_HEIGHT_CLASS,
          selectedFilePath === node.path && "bg-accent text-accent-foreground hover:bg-accent",
        )}
        style={{ paddingLeft: `${leftPadding}px` }}
        onClick={() => onSelectFile(node.path)}
        draggable={onFileDragStart ? true : undefined}
        onDragStart={
          onFileDragStart ? (event) => onFileDragStart(node.path, event.dataTransfer) : undefined
        }
        onDragEnd={onFileDragEnd}
      >
        <span aria-hidden="true" className="size-3.5 shrink-0" />
        <VscodeEntryIcon
          pathValue={node.path}
          kind="file"
          theme={resolvedTheme}
          className="size-3.5 text-muted-foreground/70"
        />
        <span
          data-tree-label
          className={cn(
            "truncate font-mono text-[11px] text-muted-foreground/80 group-hover/tree-row:text-foreground/90",
            selectedFilePath === node.path && "text-accent-foreground",
          )}
        >
          {node.name}
        </span>
        {showStats && node.stat && (
          <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums">
            <DiffStatLabel additions={node.stat.additions} deletions={node.stat.deletions} />
          </span>
        )}
      </button>
    );
  };

  return (
    <WindowedRows
      rows={rows}
      rowKey={treeRowKey}
      renderRow={renderRow}
      virtualized={virtualized}
      rowStrideClassName={ROW_STRIDE_CLASS}
      className="flex flex-col gap-0.5"
    />
  );
});

/** The tree's visible rows in order: each node, then an expanded folder's children. */
function collectExpandedRows(
  nodes: ReadonlyArray<TurnDiffTreeNode>,
  overrides: Readonly<Record<string, boolean>>,
  allDirectoriesExpanded: boolean,
  depth = 0,
  rows: ChangedFilesTreeRow[] = [],
): ChangedFilesTreeRow[] {
  for (const node of nodes) {
    rows.push({ node, depth });
    if (node.kind === "directory" && (overrides[node.path] ?? allDirectoriesExpanded)) {
      collectExpandedRows(node.children, overrides, allDirectoriesExpanded, depth + 1, rows);
    }
  }
  return rows;
}

function collectDirectoryPaths(nodes: ReadonlyArray<TurnDiffTreeNode>): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind !== "directory") continue;
    paths.push(node.path);
    paths.push(...collectDirectoryPaths(node.children));
  }
  return paths;
}

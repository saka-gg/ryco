import { normalizeWorkspaceFileSearchQuery } from "@ryco/client-runtime/state/files";
import { WS_METHODS } from "@ryco/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { useCommandPaletteStore } from "../../commandPaletteStore";
import { useComposerHandleContext } from "../../composerHandleContext";
import { useRouteWorkspaceTarget } from "../../hooks/useRouteWorkspaceTarget";
import { useTheme } from "../../hooks/useTheme";
import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { useHostedHubStore } from "../../hostedHub/state";
import { hostedCapabilityCopy, hostedSwitchTargetLabel } from "../../hostedHub/switchTarget";
import { cn } from "../../lib/utils";
import { useWorkspacePathSearch } from "../../rpc/useProject";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../../threadRoutes";
import { buildOpenFilesSearch } from "../../workspaceRouteSearch";
import { VscodeEntryIcon } from "../chat/VscodeEntryIcon";
import { Button } from "../ui/button";
import {
  Command,
  CommandDialogPopup,
  CommandFooter,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
} from "../ui/command";
import { Kbd, KbdGroup } from "../ui/kbd";
import {
  buildQuickOpenRows,
  resolveQuickOpenStatus,
  type QuickOpenRow,
} from "./WorkspaceSearchDialog.logic";

/**
 * The palette's searches of the routed thread's workspace, shown in place of
 * its command list. They ship in the palette's chunk: as a lazy entry of their
 * own they would regroup the shared icon chunks and add a file to the shell's
 * budgeted closures.
 */
export function WorkspaceSearchDialog() {
  const mode = useCommandPaletteStore((store) => store.workspaceSearchMode);
  return mode === "files" ? <QuickOpen /> : null;
}

/** Quick open: a file of the routed thread's workspace, by name, into its Files panel. */
function QuickOpen() {
  const setOpen = useCommandPaletteStore((store) => store.setOpen);
  const composerHandleRef = useComposerHandleContext();
  const { resolvedTheme } = useTheme();
  const { activeThread, activeCwd } = useRouteWorkspaceTarget();
  const environmentId = activeThread?.environmentId ?? null;
  const capability = useHostedRpcCapability(WS_METHODS.projectsSearchEntries, environmentId);
  const nodeLabel = useHostedHubStore((state) => hostedSwitchTargetLabel(state, environmentId));
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [highlightedPath, setHighlightedPath] = useState<string | null>(null);

  // The node takes a trimmed query: "  " searches nothing rather than failing.
  const searchQuery = normalizeWorkspaceFileSearchQuery(query);
  const search = useWorkspacePathSearch({
    environmentId,
    cwd: activeCwd,
    query: searchQuery,
    enabled: activeCwd !== null && capability.allowed,
  });
  const rows = useMemo(
    () => buildQuickOpenRows(search.results?.entries ?? [], searchQuery),
    [search.results, searchQuery],
  );
  // Handed to the list so it highlights the first row of results that arrive
  // after the query changed, too.
  const rowPaths = useMemo(() => rows.map((row) => row.path), [rows]);
  const status = resolveQuickOpenStatus({
    hasWorkspace: activeCwd !== null,
    access: { allowed: capability.allowed, reason: hostedCapabilityCopy(capability, nodeLabel) },
    requestsSearch: search.requestsSearch,
    isLoading: search.isLoading,
    hasResults: search.hasResults,
    error: search.error,
    partial: search.results?.partial === true,
  });

  // The routed thread's case of `createWorkspaceFileOpener`
  // (workspaceFileNavigation.ts), which sits in a chat chunk this one must not
  // pull in.
  const openFile = (path: string) => {
    setOpen(false);
    if (!routeTarget) return;
    const nextSearch = (previous: Record<string, unknown>) =>
      buildOpenFilesSearch(previous, { path });
    if (routeTarget.kind === "draft") {
      void navigate({
        to: "/draft/$draftId",
        params: { draftId: routeTarget.draftId },
        replace: true,
        search: nextSearch,
      });
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(routeTarget.threadRef),
      replace: true,
      search: nextSearch,
    });
  };

  return (
    <CommandDialogPopup
      aria-label="Go to file"
      className="project-glass-surface overflow-hidden p-0"
      data-testid="quick-open"
      surface="glass"
      finalFocus={() => {
        composerHandleRef?.current?.focusAtEnd();
        return false;
      }}
      onBackdropPointerDown={() => {
        setOpen(false);
      }}
    >
      <Command
        aria-label="Go to file"
        items={rowPaths}
        mode="none"
        onItemHighlighted={(value) => {
          setHighlightedPath(typeof value === "string" ? value : null);
        }}
        onValueChange={setQuery}
        value={query}
      >
        <CommandInput placeholder="Go to file" />
        <CommandPanel className="max-h-[min(28rem,70vh)] bg-transparent">
          {rows.length > 0 ? (
            <CommandList>
              {rows.map((row) => (
                <QuickOpenResultRow
                  key={row.path}
                  row={row}
                  isActive={highlightedPath === row.path}
                  resolvedTheme={resolvedTheme}
                  onOpen={openFile}
                />
              ))}
            </CommandList>
          ) : (
            <div
              aria-live="polite"
              className="flex flex-col items-center gap-2 py-10 text-center text-muted-foreground text-sm"
            >
              <p role={status.failed ? "alert" : undefined}>{status.text}</p>
              {status.failed ? (
                <Button size="xs" variant="outline" onClick={search.retry}>
                  Retry
                </Button>
              ) : null}
            </div>
          )}
          {rows.length > 0 && status.failed ? (
            <div className="flex items-center justify-between gap-2 border-t px-4 py-1.5">
              <p role="alert" className="text-destructive text-xs">
                {status.text}
              </p>
              <Button size="xs" variant="ghost" onClick={search.retry}>
                Retry
              </Button>
            </div>
          ) : null}
          {status.footnote ? (
            <p className="border-t px-4 py-1.5 text-[11px] text-muted-foreground/70">
              {status.footnote}
            </p>
          ) : null}
        </CommandPanel>
        <CommandFooter className="gap-3 pointer-coarse:hidden">
          <div className="flex items-center gap-3">
            <KbdGroup className="items-center gap-1.5">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
              <span className="text-muted-foreground/80">Navigate</span>
            </KbdGroup>
            <KbdGroup className="items-center gap-1.5">
              <Kbd>Enter</Kbd>
              <span className="text-muted-foreground/80">Open</span>
            </KbdGroup>
            <KbdGroup className="items-center gap-1.5">
              <Kbd>Esc</Kbd>
              <span className="text-muted-foreground/80">Close</span>
            </KbdGroup>
          </div>
        </CommandFooter>
      </Command>
    </CommandDialogPopup>
  );
}

function QuickOpenResultRow(props: {
  row: QuickOpenRow;
  isActive: boolean;
  resolvedTheme: "light" | "dark";
  onOpen: (path: string) => void;
}) {
  const { row } = props;
  return (
    <CommandItem
      value={row.path}
      className={cn(
        "cursor-pointer gap-2 hover:bg-transparent hover:text-inherit data-highlighted:bg-transparent data-highlighted:text-inherit",
        props.isActive && "bg-accent! text-accent-foreground!",
      )}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        props.onOpen(row.path);
      }}
    >
      <VscodeEntryIcon pathValue={row.path} kind="file" theme={props.resolvedTheme} />
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="shrink-0 text-foreground text-sm">
          <HighlightedText segments={row.name} />
        </span>
        {row.parentPath ? (
          <span className="min-w-0 flex-1 truncate text-muted-foreground/70 text-xs">
            <HighlightedText segments={row.parentPath} />
          </span>
        ) : null}
      </span>
    </CommandItem>
  );
}

function HighlightedText(props: { segments: QuickOpenRow["name"] }) {
  // Runs are keyed by where they start in the text.
  let start = 0;
  return props.segments.map((segment) => {
    const key = start;
    start += segment.text.length;
    return segment.highlighted ? (
      <mark key={key} className="bg-transparent font-semibold text-foreground">
        {segment.text}
      </mark>
    ) : (
      <span key={key}>{segment.text}</span>
    );
  });
}

import { FolderPlusIcon, SearchIcon, XIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type KeyboardEvent,
} from "react";

import { PAGE_BAR_CLASS, PAGE_DRAWER_LEADING_INSET_CLASS } from "../../../appChrome";
import { useCommandPaletteStore } from "../../../commandPaletteStore";
import { usePageLeadingInsetClass } from "../../../hooks/usePageLeadingInsetClass";
import { useHostedRpcCapability } from "../../../hostedHub/capabilities";
import { cn } from "../../../lib/utils";
import { WS_METHODS } from "@ryco/contracts";
import { InboxMotionContext, useInboxListMotion } from "../../inboxSidebar/useInboxListMotion";
import { KeyHint } from "../../pullRequests/primitives";
import { Button } from "../../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import {
  filterProjectListRows,
  type ProjectListRow as ProjectListRowModel,
} from "../projectsModel.logic";
import { useProjectsLayoutStore } from "../projectsLayoutStore";
import { useProjectsList, useProjectsPage } from "../ProjectsPageContext";
import { PROJECT_ROW_BUTTON_SELECTOR, ProjectListRow } from "./ProjectListRow";

export type ProjectListVariant = "docked" | "drawer" | "fill";

const ICON_BUTTON_CLASS =
  "relative inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";

function findRowButton(container: HTMLElement, key: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(
    `${PROJECT_ROW_BUTTON_SELECTOR.slice(0, -1)}="${CSS.escape(key)}"]`,
  );
}

/**
 * The projects list: a 52px header with the filter and "Add project", then
 * every logical project in sidebar order. One plate marks the selection and
 * glides between rows; one highlight follows the pointer.
 */
export function ProjectListPane(props: { readonly variant: ProjectListVariant }) {
  const { selection, nav, layout } = useProjectsPage();
  const { rows, filter, setFilter } = useProjectsList();
  const visibleRows = useMemo(() => filterProjectListRows(rows, filter), [filter, rows]);
  const selectedKey = selection?.snapshot.projectKey ?? null;
  const inputRef = useRef<HTMLInputElement>(null);
  const addProjectCapability = useHostedRpcCapability(WS_METHODS.projectsAdd);
  const leadingInset = usePageLeadingInsetClass(
    props.variant !== "drawer" && layout.leadingRegion === "list",
    "pl-2.5",
  );

  // A `/` press while no list was mounted asked for the filter.
  useEffect(() => {
    if (useProjectsLayoutStore.getState().consumeFilterFocus()) inputRef.current?.focus();
  }, []);

  // ── Motion: FLIP + enter, hover highlight, selection plate ──────────
  const orderSignature = useMemo(() => visibleRows.map((row) => row.key).join("\0"), [visibleRows]);
  const { listRef, highlightRef, gateRef, onPointerMove, onPointerLeave } = useInboxListMotion({
    enabled: visibleRows.length > 0,
    orderSignature,
  });
  const plateRef = useRef<HTMLDivElement>(null);
  const plateBoxRef = useRef<{ readonly top: number; readonly height: number } | null>(null);
  const placedForRef = useRef({ selectedKey, orderSignature });

  const placePlate = useCallback(
    (glide: boolean) => {
      const plate = plateRef.current;
      const list = listRef.current;
      if (!plate || !list) return;
      const button = selectedKey === null ? null : findRowButton(list, selectedKey);
      const row = button?.parentElement ?? null;
      if (!row) {
        plate.dataset.visible = "false";
        plateBoxRef.current = null;
        return;
      }
      const box = { top: row.offsetTop, height: row.offsetHeight };
      const previous = plateBoxRef.current;
      if (previous && previous.top === box.top && previous.height === box.height) return;
      const instant = !glide || previous === null;
      if (instant) plate.style.transition = "none";
      plate.style.transform = `translateY(${box.top}px)`;
      plate.style.height = `${box.height}px`;
      if (instant) {
        void plate.offsetWidth;
        plate.style.transition = "";
      }
      plate.dataset.visible = "true";
      plateBoxRef.current = box;
    },
    [listRef, selectedKey],
  );

  useLayoutEffect(() => {
    const plate = plateRef.current;
    const placedFor = placedForRef.current;
    if (plate) {
      // A reorder under an unchanged selection rides with its row's FLIP.
      plate.dataset.motion =
        placedFor.selectedKey === selectedKey && placedFor.orderSignature !== orderSignature
          ? "reorder"
          : "";
    }
    placedForRef.current = { selectedKey, orderSignature };
    placePlate(true);
  });

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => placePlate(false));
    observer.observe(list);
    return () => observer.disconnect();
  }, [listRef, placePlate]);

  // Keep the selected row in view when it changes from outside (j/k, links).
  const scrollerRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || selectedKey === null) return;
    findRowButton(list, selectedKey)?.scrollIntoView({ block: "nearest" });
  }, [listRef, selectedKey]);

  // ── Keyboard: roving focus inside the rows ──────────────────────────
  const tabStopKey =
    selectedKey !== null && visibleRows.some((row) => row.key === selectedKey)
      ? selectedKey
      : (visibleRows[0]?.key ?? null);
  const focusRow = useCallback(
    (key: string | undefined) => {
      const list = listRef.current;
      if (!list || key === undefined) return;
      findRowButton(list, key)?.focus();
    },
    [listRef],
  );
  // Stable across list updates, so the memo'd rows only re-render for their own data.
  const onRowKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, row: ProjectListRowModel) => {
      const index = visibleRows.findIndex((candidate) => candidate.key === row.key);
      let target: ProjectListRowModel | undefined;
      if (event.key === "ArrowDown") target = visibleRows[index + 1];
      else if (event.key === "ArrowUp") {
        if (index === 0) {
          event.preventDefault();
          inputRef.current?.focus();
          return;
        }
        target = visibleRows[index - 1];
      } else if (event.key === "Home") target = visibleRows[0];
      else if (event.key === "End") target = visibleRows.at(-1);
      else return;
      event.preventDefault();
      if (!target) return;
      focusRow(target.key);
      nav.selectProject(target, { via: "keyboard" });
    },
    [focusRow, nav, visibleRows],
  );

  const selectRow = useCallback(
    (row: ProjectListRowModel) => nav.selectProject(row, { via: "pointer" }),
    [nav],
  );

  const trimmedFilter = filter.trim();
  return (
    <div
      data-projects-list-pane={props.variant}
      className="flex min-h-0 flex-1 flex-col bg-background"
    >
      <header
        className={cn(
          PAGE_BAR_CLASS,
          "gap-1 pr-2",
          props.variant === "drawer" ? PAGE_DRAWER_LEADING_INSET_CLASS : leadingInset,
        )}
      >
        <div
          className={cn(
            "group/filter flex h-8 min-w-0 flex-1 items-center rounded-lg bg-muted/80 text-muted-foreground transition-[background-color,box-shadow] duration-(--app-motion-duration-chip) [-webkit-app-region:no-drag]",
            "focus-within:bg-background focus-within:shadow-[inset_0_0_0_1px_var(--color-border),0_0_0_3px_--theme(--color-ring/12%)]",
          )}
        >
          <label className="flex h-full min-w-0 flex-1 cursor-text items-center gap-2 pr-1.5 pl-2.5">
            <SearchIcon aria-hidden className="size-3.5 shrink-0 opacity-70" />
            <input
              ref={inputRef}
              data-projects-filter
              type="text"
              value={filter}
              spellCheck={false}
              autoComplete="off"
              aria-label="Filter projects"
              placeholder="Filter projects"
              className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground/70"
              onChange={(event) => setFilter(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === "ArrowDown" ||
                  (event.key === "Enter" && !event.nativeEvent.isComposing)
                ) {
                  event.preventDefault();
                  const first = visibleRows[0];
                  if (!first) return;
                  if (event.key === "Enter") nav.selectProject(first, { via: "keyboard" });
                  focusRow(event.key === "Enter" ? first.key : (tabStopKey ?? first.key));
                } else if (event.key === "Escape" && filter.length > 0) {
                  event.preventDefault();
                  event.stopPropagation();
                  setFilter("");
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
              }}
            />
            {filter.length > 0 ? (
              <button
                type="button"
                aria-label="Clear filter"
                className="inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/80 outline-hidden hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => {
                  setFilter("");
                  inputRef.current?.focus();
                }}
              >
                <XIcon aria-hidden className="size-3" />
              </button>
            ) : props.variant !== "drawer" ? (
              <KeyHint className="transition-opacity duration-(--app-motion-duration-chip) group-focus-within/filter:opacity-0">
                /
              </KeyHint>
            ) : null}
          </label>
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Add project"
                disabled={!addProjectCapability.allowed}
                className={ICON_BUTTON_CLASS}
                onClick={() => useCommandPaletteStore.getState().openAddProject()}
              />
            }
          >
            <FolderPlusIcon className="size-4" />
          </TooltipTrigger>
          <TooltipPopup side="bottom">{addProjectCapability.reason ?? "Add project"}</TooltipPopup>
        </Tooltip>
      </header>

      <div
        ref={scrollerRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2"
      >
        {rows.length === 0 ? (
          <div className="flex flex-col items-start gap-3 px-2.5 py-6">
            <div>
              <p className="text-[13px] font-medium text-foreground">No projects yet</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Add a folder to start threads in it.
              </p>
            </div>
            <Button
              size="sm"
              disabled={!addProjectCapability.allowed}
              onClick={() => useCommandPaletteStore.getState().openAddProject()}
            >
              <FolderPlusIcon className="size-3.5" />
              Add project
            </Button>
          </div>
        ) : visibleRows.length === 0 ? (
          <p className="px-2.5 py-6 text-xs text-muted-foreground">
            No projects match “{trimmedFilter}”
          </p>
        ) : (
          <InboxMotionContext.Provider value={gateRef}>
            <div
              ref={listRef}
              role="list"
              aria-label="Projects"
              className="relative"
              onPointerMove={onPointerMove}
              onPointerLeave={onPointerLeave}
            >
              <div
                ref={highlightRef}
                aria-hidden
                className="pointer-events-none absolute inset-x-0 top-0 rounded-[min(var(--radius-lg),0.625rem)] bg-accent/55 opacity-0 transition-[transform,height,opacity] duration-(--app-motion-duration-stack) ease-(--app-motion-spring-gentle) motion-reduce:transition-none data-[visible=true]:opacity-100"
                data-visible="false"
              />
              <div
                ref={plateRef}
                aria-hidden
                className="projects-list-plate"
                data-visible="false"
              />
              {visibleRows.map((row) => (
                <div key={row.key} role="listitem">
                  <ProjectListRow
                    row={row}
                    selected={row.key === selectedKey}
                    tabStop={row.key === tabStopKey}
                    onSelect={selectRow}
                    onKeyDown={onRowKeyDown}
                  />
                </div>
              ))}
            </div>
          </InboxMotionContext.Provider>
        )}
      </div>
    </div>
  );
}

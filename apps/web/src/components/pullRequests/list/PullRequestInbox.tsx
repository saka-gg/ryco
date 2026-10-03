import type { ChangeRequest } from "@ryco/contracts";
import type { ChangeRequestListGroupKey } from "@ryco/client-runtime/state/pull-request-review";
import { ChevronDownIcon } from "lucide-react";
import {
  useCallback,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";

import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import { useEvent } from "../../../hooks/useEvent";
import { readMotionDurationMs } from "../../../lib/perf/motion";
import { cn } from "../../../lib/utils";
import { invalidateSourceControl } from "../../../rpc/useSourceControl";
import { InboxMotionContext, useInboxListMotion } from "../../inboxSidebar/useInboxListMotion";
import { Button } from "../../ui/button";
import { Skeleton } from "../../ui/skeleton";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { usePullRequestAgentHandoff } from "../agentHandoff";
import { usePullRequestsPage } from "../PullRequestsPageContext";
import { usePullRequestsLayoutStore } from "../pullRequestsLayoutStore";
import { resolvePullRequestsStateFilter } from "../pullRequestsSearch";
import type { PullRequestListVariant } from "./ListHeader";
import { PULL_REQUEST_FILTER_RESET, pullRequestFilterChips } from "./pullRequestListFilters.logic";
import {
  describePullRequestReadiness,
  type PullRequestReadiness,
} from "./pullRequestListRows.logic";
import { buildPullRequestListItems, type PullRequestListItem } from "./pullRequestListStacks.logic";
import {
  PULL_REQUEST_ROW_BUTTON_ATTRIBUTE,
  PullRequestRow,
  PullRequestRowSkeleton,
  StackFoot,
  type PullRequestRowDensity,
} from "./PullRequestRow";
import { RepositoryStatusMessage } from "./RepositoryStatusMessage";
import type { PullRequestListSearch } from "./usePullRequestListSearch";

/** What the list column asks of its rows (the search field drives these). */
export interface PullRequestInboxActions {
  /** Focus the selected row, else the first visible one. */
  focusRows(): void;
  /** Open the first visible row (Enter in the search field). */
  openFirst(): void;
}

/** Sticky group headers are this tall; revealing a row clears them. */
const GROUP_HEADER_HEIGHT = 32;
/** Breathing room kept around a row scrolled into view. */
const REVEAL_MARGIN = 6;

interface InboxSection {
  readonly key: ChangeRequestListGroupKey;
  readonly label: string;
  readonly count: number;
  /** Rows show author and size instead of readiness (the group says it already). */
  readonly reviewer: boolean;
  readonly items: ReadonlyArray<PullRequestListItem<ChangeRequest>>;
  readonly readiness: ReadonlyMap<number, PullRequestReadiness>;
}

const ROW_BUTTON_SELECTOR = `[${PULL_REQUEST_ROW_BUTTON_ATTRIBUTE}]`;

function rowNumber(button: Element): number {
  return Number(button.getAttribute(PULL_REQUEST_ROW_BUTTON_ATTRIBUTE));
}

/** Row buttons a person can reach: folded groups are inert. */
function visibleRowButtons(content: HTMLElement): HTMLButtonElement[] {
  return [...content.querySelectorAll<HTMLButtonElement>(ROW_BUTTON_SELECTOR)].filter(
    (button) => button.closest("[inert]") === null,
  );
}

function findRow(content: HTMLElement, number: number): HTMLElement | null {
  const row = content.querySelector<HTMLElement>(`[data-pr-row="${number}"]`);
  return row && row.closest("[inert]") === null ? row : null;
}

/**
 * Scrolls the list just enough to show a row (block "nearest"), clearing the
 * sticky group header. Layout offsets, not client rects, so rows mid-FLIP and
 * the page around the list never move.
 */
function revealRow(scroller: HTMLElement, content: HTMLElement, row: HTMLElement, inset: number) {
  const top = content.offsetTop + row.offsetTop;
  const bottom = top + row.offsetHeight;
  const viewTop = scroller.scrollTop + inset;
  const viewBottom = scroller.scrollTop + scroller.clientHeight - REVEAL_MARGIN;
  if (top < viewTop) scroller.scrollTop = Math.max(0, top - inset);
  else if (bottom > viewBottom) {
    scroller.scrollTop = bottom - scroller.clientHeight + REVEAL_MARGIN;
  }
}

/**
 * The grouped list (Needs your review · Yours · Others, or one flat list when
 * the host cannot tell involvement apart), ranked by readiness with stacks as
 * one unit. One plate glides to the selected row; filtering and reordering
 * FLIP rows into place and new rows settle in from just above.
 */
export function PullRequestInbox({
  ref,
  ...props
}: {
  readonly ref?: Ref<PullRequestInboxActions | null>;
  readonly variant: PullRequestListVariant;
  readonly search: PullRequestListSearch;
  readonly onFocusSearch: () => void;
  /** Scrolls with the rows, above them (the active filter chips). */
  readonly header?: ReactNode;
}) {
  const { variant, search, onFocusSearch } = props;
  const { model, nav, repository, repositoryStatus, selectionMotion } = usePullRequestsPage();
  const { list } = model;
  const selected = nav.search.pr ?? null;
  const grouped = list.involvementSupported;
  const density: PullRequestRowDensity = variant === "fill" ? "wide" : "compact";
  const providerName = model.provider?.name ?? "the web";
  const foldedGroups = usePullRequestsLayoutStore((state) => state.foldedGroups);
  const toggleGroupFolded = usePullRequestsLayoutStore((state) => state.toggleGroupFolded);
  const detailStack = model.selection?.detail.data?.stack ?? null;
  const viewerLogin = list.viewerLogin;
  const listReadiness = model.capabilities.listReadiness;

  const sections = useMemo<ReadonlyArray<InboxSection>>(() => {
    // Stack feet read every loaded layer, including ones a filter hides.
    const allRows = [...list.byNumber.values()];
    return list.groups.map((group) => {
      const readiness = new Map(
        group.entries.map(
          (entry) =>
            [
              entry.number,
              describePullRequestReadiness(entry, { viewerLogin, readiness: listReadiness }),
            ] as const,
        ),
      );
      return {
        key: group.key,
        label: group.label,
        count: group.entries.length,
        reviewer: grouped && group.key === "needs-your-review",
        items: buildPullRequestListItems(group.entries, {
          isLandable: (entry) =>
            (
              readiness.get(entry.number) ??
              describePullRequestReadiness(entry, { readiness: listReadiness })
            ).landable,
          allRows,
          detailStack,
        }),
        readiness,
      };
    });
  }, [detailStack, grouped, list.byNumber, list.groups, listReadiness, viewerLogin]);

  const serverRows = search.server.results;
  const serverReadiness = useMemo(
    () =>
      new Map(
        serverRows.map(
          (entry) =>
            [
              entry.number,
              describePullRequestReadiness(entry, { viewerLogin, readiness: listReadiness }),
            ] as const,
        ),
      ),
    [listReadiness, serverRows, viewerLogin],
  );

  const isFolded = useCallback(
    (key: string) => grouped && foldedGroups.includes(key),
    [foldedGroups, grouped],
  );

  // Roving focus: Tab lands on the selected row when it is visible, else the first.
  const visibleNumbers = useMemo(() => {
    const numbers: number[] = [];
    for (const section of sections) {
      if (isFolded(section.key)) continue;
      for (const item of section.items) if (item.kind === "row") numbers.push(item.entry.number);
    }
    for (const entry of serverRows) numbers.push(entry.number);
    return numbers;
  }, [isFolded, sections, serverRows]);
  const tabStop =
    selected !== null && visibleNumbers.includes(selected) ? selected : (visibleNumbers[0] ?? null);

  // ── Motion: FLIP + enter for rows, and the selection plate ─────────
  const orderSignature = useMemo(
    () =>
      [
        ...sections.map(
          (section) => `${section.key}:${section.items.map((item) => item.key).join(",")}`,
        ),
        `search:${serverRows.map((entry) => entry.number).join(",")}`,
      ].join("|"),
    [sections, serverRows],
  );
  const hasRows = sections.length > 0 || serverRows.length > 0;
  const { listRef: contentRef, gateRef: motionGateRef } = useInboxListMotion({
    // The first paint of a list (and every reload of it) stays still; only
    // later changes move.
    enabled: !list.isLoading && hasRows,
    orderSignature,
  });
  const scrollerRef = useRef<HTMLDivElement>(null);
  const plateRef = useRef<HTMLDivElement>(null);
  const plateBoxRef = useRef<{ readonly top: number; readonly height: number } | null>(null);
  // Bumped when a group finishes folding, so the motion hook re-reads row
  // positions at rest instead of mid-fold.
  const [, settleLayout] = useReducer((count: number) => count + 1, 0);

  const placePlate = useCallback(
    (glide: boolean) => {
      const plate = plateRef.current;
      const content = contentRef.current;
      if (!plate || !content) return;
      const row = selected === null ? null : findRow(content, selected);
      if (!row) {
        plate.dataset.visible = "false";
        plateBoxRef.current = null;
        return;
      }
      const box = { top: row.offsetTop, height: row.offsetHeight };
      const previous = plateBoxRef.current;
      if (previous && previous.top === box.top && previous.height === box.height) return;
      // Appearing (or tracking a fold in progress) places the plate without a glide.
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
    [contentRef, selected],
  );

  // A reorder under an unchanged selection moves the plate with its row's
  // FLIP (same duration and curve); a selection change glides at its own pace.
  const placedForRef = useRef({ selected, orderSignature });
  useLayoutEffect(() => {
    const plate = plateRef.current;
    const placedFor = placedForRef.current;
    if (plate) {
      plate.dataset.motion =
        placedFor.selected !== selected
          ? selectionMotion.kind === "push"
            ? "push"
            : ""
          : placedFor.orderSignature !== orderSignature
            ? "reorder"
            : "";
    }
    placedForRef.current = { selected, orderSignature };
    placePlate(true);
  });

  // Folds, resizes and late layout move rows without a commit here: follow
  // them exactly rather than gliding behind.
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => placePlate(false));
    observer.observe(content);
    return () => observer.disconnect();
  }, [contentRef, placePlate]);

  // Keep the selected row in view (J/K from the page, links, the reader), and
  // keep keyboard focus on it when focus was already in the rows.
  const revealedRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const content = contentRef.current;
    if (!scroller || !content || selected === null || revealedRef.current === selected) return;
    const row = findRow(content, selected);
    if (!row) return;
    revealedRef.current = selected;
    revealRow(scroller, content, row, (grouped ? GROUP_HEADER_HEIGHT : 0) + REVEAL_MARGIN);
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      content.contains(active) &&
      active.matches(ROW_BUTTON_SELECTOR)
    ) {
      row.querySelector<HTMLElement>(ROW_BUTTON_SELECTOR)?.focus({ preventScroll: true });
    }
  });

  const focusButton = useCallback(
    (button: HTMLElement) => {
      button.focus({ preventScroll: true });
      const scroller = scrollerRef.current;
      const content = contentRef.current;
      const row = button.closest<HTMLElement>("[data-pr-row]");
      if (scroller && content && row) {
        revealRow(scroller, content, row, (grouped ? GROUP_HEADER_HEIGHT : 0) + REVEAL_MARGIN);
      }
    },
    [contentRef, grouped],
  );

  // Stable across URL changes (nav's actions are), so memoized rows only
  // re-render for their own props.
  const { selectPullRequest } = nav;
  const select = useCallback(
    (number: number) => selectPullRequest(number, { push: true, via: "list" }),
    [selectPullRequest],
  );

  useImperativeHandle(
    ref,
    () => ({
      focusRows: () => {
        const content = contentRef.current;
        if (!content) return;
        const buttons = visibleRowButtons(content);
        const target =
          buttons.find((button) => selected !== null && rowNumber(button) === selected) ??
          buttons[0];
        if (target) focusButton(target);
      },
      openFirst: () => {
        const content = contentRef.current;
        const first = content ? visibleRowButtons(content)[0] : undefined;
        if (first) select(rowNumber(first));
      },
    }),
    [contentRef, focusButton, select, selected],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const content = contentRef.current;
    const button = (event.target as Element).closest<HTMLElement>(ROW_BUTTON_SELECTOR);
    if (!content || !button) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    // Page shortcuts pause inside the drawer (a dialog), so it moves on J/K itself.
    const ownLetters = variant === "drawer" && !event.shiftKey;
    if (key === "/" && variant === "drawer") {
      event.preventDefault();
      onFocusSearch();
      return;
    }
    const buttons = visibleRowButtons(content);
    const index = buttons.indexOf(button as HTMLButtonElement);
    let target: HTMLElement | undefined;
    if (key === "ArrowDown" || (ownLetters && key === "j")) target = buttons[index + 1];
    else if (key === "ArrowUp" || (ownLetters && key === "k")) {
      if (index <= 0) {
        event.preventDefault();
        onFocusSearch();
        return;
      }
      target = buttons[index - 1];
    } else if (key === "Home") target = buttons[0];
    else if (key === "End") target = buttons.at(-1);
    else return;
    event.preventDefault();
    if (!target) return;
    // Beside the reader the arrows move the selection (like J/K); in the
    // drawer and the full-page list they move focus and Enter opens.
    if (variant === "docked") nav.selectPullRequest(rowNumber(target), { via: "list" });
    focusButton(target);
  };

  const { copyToClipboard } = useCopyToClipboard<void>({
    onCopy: () =>
      toastManager.add(
        stackedThreadToast({ type: "success", title: "Copied link", timeout: 1600 }),
      ),
    onError: (error) =>
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Couldn’t copy link",
          description: error.message,
        }),
      ),
  });
  const copyLink = useCallback((url: string) => copyToClipboard(url, undefined), [copyToClipboard]);

  // The row menu's "Check out in worktree": the same hand-off as the bar's,
  // aimed at that row's pull request.
  const handoff = usePullRequestAgentHandoff();
  const checkoutWorktree = useEvent(
    (entry: ChangeRequest) =>
      void handoff.openWorktreeThread({
        number: entry.number,
        headRefName: entry.headRefName,
        isCrossRepository: entry.isCrossRepository,
      }),
  );

  const rowProps = {
    density,
    viewerLogin,
    providerName,
    onSelect: select,
    onCopyLink: copyLink,
    onCheckoutWorktree: repository !== null ? checkoutWorktree : undefined,
    canCheckout: model.capabilities.checkout,
  } as const;

  const renderItems = (
    items: ReadonlyArray<PullRequestListItem<ChangeRequest>>,
    readiness: ReadonlyMap<number, PullRequestReadiness>,
    reviewer: boolean,
  ) =>
    items.map((item) =>
      item.kind === "row" ? (
        <PullRequestRow
          key={item.key}
          {...rowProps}
          entry={item.entry}
          itemKey={item.key}
          selected={item.entry.number === selected}
          tabStop={item.entry.number === tabStop}
          readiness={readiness.get(item.entry.number) ?? FALLBACK_READINESS}
          reviewer={reviewer}
          spine={item.spine}
        />
      ) : (
        <StackFoot key={item.key} itemKey={item.key} foot={item.foot} />
      ),
    );

  let body: ReactNode;
  if (repository === null || repositoryStatus.kind !== "ready") {
    body =
      repositoryStatus.kind === "ready" ? (
        <ListMessage title="Choose a repository" />
      ) : (
        <RepositoryStatusMessage status={repositoryStatus} />
      );
  } else if (list.isLoading) {
    body = <InboxSkeleton grouped={model.capabilities.involvementFilters} />;
  } else if (list.error !== null && !hasRows) {
    body = (
      <ListMessage title="Couldn’t load pull requests" detail={list.error}>
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            invalidateSourceControl({ environmentId: model.environmentId, cwd: model.cwd })
          }
        >
          Try again
        </Button>
      </ListMessage>
    );
  } else if (sections.length > 0) {
    body = grouped
      ? sections.map((section) => (
          <InboxGroup
            key={section.key}
            label={section.label}
            count={section.count}
            folded={isFolded(section.key)}
            onToggle={() => toggleGroupFolded(section.key)}
            onSettled={settleLayout}
          >
            {renderItems(section.items, section.readiness, section.reviewer)}
          </InboxGroup>
        ))
      : sections.map((section) => (
          <div key={section.key} className="pt-1.5">
            {renderItems(section.items, section.readiness, false)}
          </div>
        ));
  } else if (search.server.active && (search.server.isLoading || serverRows.length > 0)) {
    body = (
      <section aria-label={`Found on ${providerName}`}>
        <div className="flex h-8 items-center gap-2 pl-2.5 text-[11px] text-muted-foreground">
          {search.server.isLoading ? `Searching ${providerName}…` : `Found on ${providerName}`}
        </div>
        {serverRows.map((entry) => (
          <PullRequestRow
            key={`pr:${entry.number}`}
            {...rowProps}
            entry={entry}
            itemKey={`pr:${entry.number}`}
            selected={entry.number === selected}
            tabStop={entry.number === tabStop}
            readiness={serverReadiness.get(entry.number) ?? FALLBACK_READINESS}
            reviewer={false}
            spine={null}
          />
        ))}
      </section>
    );
  } else {
    body = <EmptyList query={search.query} serverError={search.server.error} />;
  }

  return (
    <div
      ref={scrollerRef}
      className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
      aria-busy={list.isLoading || undefined}
    >
      {props.header}
      <InboxMotionContext.Provider value={motionGateRef}>
        <div
          ref={contentRef}
          role="presentation"
          className="relative px-1.5 pb-4"
          onKeyDown={onKeyDown}
        >
          <div
            ref={plateRef}
            aria-hidden
            data-visible="false"
            className="pr-list-plate inset-x-1.5"
          />
          {body}
        </div>
      </InboxMotionContext.Provider>
    </div>
  );
}

const FALLBACK_READINESS: PullRequestReadiness = {
  label: "",
  tone: "neutral",
  landable: false,
};

/**
 * A group: a sticky, sentence-case header with its count, and rows that fold
 * away (grid rows 0fr ↔ 1fr). The fold persists; folded rows are inert, so
 * neither Tab nor the arrows land in them.
 */
function InboxGroup(props: {
  readonly label: string;
  readonly count: number;
  readonly folded: boolean;
  readonly onToggle: () => void;
  readonly onSettled: () => void;
  readonly children: ReactNode;
}) {
  const regionId = useId();
  const headerId = useId();
  const open = !props.folded;
  // Clip only while folded or folding, so FLIP rows can travel across groups.
  const [clipping, setClipping] = useState(props.folded);
  const toggle = () => {
    if (readMotionDurationMs("--app-motion-duration-stack", 260) > 0) setClipping(true);
    else props.onSettled();
    props.onToggle();
  };
  return (
    <section aria-labelledby={headerId} data-folded={props.folded} className="[&+&]:mt-1.5">
      <div className="sticky top-0 z-[2] bg-(--pr-list-bg)">
        <button
          id={headerId}
          type="button"
          aria-expanded={open}
          aria-controls={regionId}
          className="group/gh flex h-8 w-full items-center gap-1.5 rounded-md pr-2.5 pl-2.5 text-left text-[11px] text-muted-foreground outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          onClick={toggle}
        >
          <span className="font-medium">{props.label}</span>
          <span className="text-muted-foreground/60 tabular-nums">{props.count}</span>
          <ChevronDownIcon
            aria-hidden
            data-folded={props.folded}
            className="ml-auto size-3 text-muted-foreground/70 opacity-0 transition-[opacity,rotate] duration-(--app-motion-duration-chip) ease-(--app-motion-spring-snappy) group-hover/gh:opacity-100 group-focus-visible/gh:opacity-100 data-[folded=true]:-rotate-90 data-[folded=true]:opacity-100"
          />
        </button>
      </div>
      <div
        id={regionId}
        inert={props.folded}
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-(--app-motion-duration-stack) ease-(--app-motion-spring-gentle)",
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
        onTransitionEnd={(event) => {
          if (event.target !== event.currentTarget || event.propertyName !== "grid-template-rows") {
            return;
          }
          setClipping(props.folded);
          props.onSettled();
        }}
      >
        <div className={cn("min-h-0", (clipping || props.folded) && "overflow-hidden")}>
          {props.children}
        </div>
      </div>
    </section>
  );
}

/** Loading rows with the loaded list's exact geometry: header, rows, header, rows. */
function InboxSkeleton(props: { readonly grouped: boolean }) {
  const header = (width: string) =>
    props.grouped ? (
      <div className="flex h-8 items-center pl-2.5">
        <Skeleton className="h-2 rounded-full" style={{ width }} />
      </div>
    ) : null;
  return (
    <div aria-label="Loading pull requests" className={props.grouped ? undefined : "pt-1.5"}>
      {header("6.5rem")}
      {[0, 1, 2, 3].map((index) => (
        <PullRequestRowSkeleton key={index} index={index} />
      ))}
      <div className={props.grouped ? "mt-1.5" : undefined}>
        {header("2.75rem")}
        {[4, 5, 6, 7, 8].map((index) => (
          <PullRequestRowSkeleton key={index} index={index} />
        ))}
      </div>
    </div>
  );
}

function ListMessage(props: {
  readonly title: string;
  readonly detail?: string | null | undefined;
  readonly children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-1.5 px-6 pt-12 text-center">
      <p className="text-[13px] text-muted-foreground">{props.title}</p>
      {props.detail ? (
        <p className="line-clamp-3 max-w-64 text-xs break-words text-muted-foreground/70">
          {props.detail}
        </p>
      ) : null}
      {props.children ? <div className="pt-1.5">{props.children}</div> : null}
    </div>
  );
}

const STATE_EMPTY_TITLE = {
  open: "No open pull requests",
  merged: "No merged pull requests",
  closed: "No closed pull requests",
  all: "No pull requests",
} as const;

/** Nothing to show: say why (query, filters, or simply none) and offer the way back. */
function EmptyList(props: { readonly query: string; readonly serverError: string | null }) {
  const { nav, model } = usePullRequestsPage();
  const filtered = pullRequestFilterChips(nav.search, model.list.labels).length > 0;
  const title =
    props.query.length > 0
      ? `Nothing matches “${props.query}”`
      : filtered
        ? "Nothing matches these filters"
        : STATE_EMPTY_TITLE[resolvePullRequestsStateFilter(nav.search)];
  return (
    <ListMessage title={title} detail={props.serverError}>
      {filtered ? (
        <Button size="xs" variant="ghost" onClick={() => nav.setSearch(PULL_REQUEST_FILTER_RESET)}>
          Clear filters
        </Button>
      ) : null}
    </ListMessage>
  );
}

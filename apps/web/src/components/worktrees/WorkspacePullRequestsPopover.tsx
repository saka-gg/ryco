import type { EnvironmentId, WorktreeId } from "@ryco/contracts";
import type { WorktreePullRequestLink } from "@ryco/shared/worktreePullRequests";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { ArrowLeftIcon, LinkIcon } from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from "react";

import { openExternalLink } from "~/lib/openExternalLink";
import { cn } from "~/lib/utils";
import { parsePullRequestReference, parsePullRequestReferenceNumber } from "~/pullRequestReference";
import { prefersExternalPullRequestLink } from "~/pullRequestsRoute";
import { useResolvePullRequest } from "~/rpc/useGit";
import { useOverviewChangeRequestList } from "~/rpc/useOverview";
import {
  useDismissWorktreePullRequestMutation,
  useLinkWorktreePullRequestMutation,
  useSourceControlChangeRequestDetail,
} from "~/rpc/useSourceControl";
import { ChangeRequestStateGlyph, RelativeTime } from "../pullRequests/primitives";
import { StackLayerList } from "../pullRequests/rail/StackLayerList";
import { StackSummary } from "../pullRequests/rail/StackSummary";
import { Popover, PopoverPopup, PopoverTitle } from "../ui/popover";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  groupWorkspacePullRequests,
  rankLinkCandidates,
  resolveDisplayStack,
  stackFactsFromDetail,
} from "./workspacePullRequests.logic";

/**
 * Every pull request a workspace carries, in one popover off whichever chip or
 * tab shows its current one: the stack the shown one belongs to, the others
 * still open, the finished ones, and "Link pull request…". Dense rows never
 * grow; this is where the rest lives. Nothing here is optimistic: the server's
 * link event updates every surface, this one included.
 */

export type WorkspacePullRequestsView = "list" | "link";

export interface WorkspacePullRequestsPopoverProps {
  readonly environmentId: EnvironmentId | null;
  /** Null for a workspace without a record (nothing can be linked to it). */
  readonly worktreeId: WorktreeId | null;
  /** Checkout the open-list and detail reads run in. */
  readonly cwd: string | null;
  readonly workspaceTitle: string;
  readonly workspaceBranch: string | null;
  /** Visible links, current first (`visiblePullRequestLinks`). */
  readonly links: ReadonlyArray<WorktreePullRequestLink>;
  /**
   * Numbers the server stores for the workspace (only those can be unlinked);
   * omit when every entry in `links` is stored.
   */
  readonly storedNumbers?: ReadonlySet<number> | undefined;
  /** The pull request the surface shows (marked in the list). */
  readonly shownNumber: number | null;
  /** Draw the shown pull request's stack (the PR reader already shows its own). */
  readonly showStack: boolean;
  /** Link and unlink allowed (`useWorkspacePullRequestEditing().ready`). */
  readonly canEdit: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly view: WorkspacePullRequestsView;
  readonly onViewChange: (view: WorkspacePullRequestsView) => void;
  /**
   * What the popover hangs from: the surface's chip, tab pill or button. Each
   * surface keeps one instance mounted (it never remounts when the workspace
   * goes from one pull request to two), so its own controls drive `open`.
   * Pass the element itself (kept in state through a callback ref) where the
   * node can be replaced while open (a chip switching between its one-click
   * and toggle forms): a new element re-anchors, a ref is read only on open.
   */
  readonly anchor: Element | null | RefObject<Element | null>;
  /**
   * The control that toggles the popover (a chip, a chevron): presses on it
   * are not "outside" presses, so its own click can close what it opened.
   */
  readonly toggle?: (() => Element | null) | undefined;
  readonly side?: "top" | "bottom" | "left" | "right" | undefined;
  readonly align?: "start" | "center" | "end" | undefined;
  readonly sideOffset?: number | undefined;
  /** Open a pull request (the surface decides: its dialog, or the PR tab). */
  readonly onOpenPullRequest: (number: number) => void;
  /** Linked from this popover (not called when it closed before the link landed). */
  readonly onLinked?: ((number: number) => void) | undefined;
  /** Unlinked from this popover (not called when it closed before the unlink landed). */
  readonly onUnlinked?: ((number: number) => void) | undefined;
}

const ROW_CLASS =
  "pr-swap relative flex h-7 items-center rounded-md ring-ring transition-colors duration-(--app-motion-duration-chip) has-[[data-link-row]:focus-visible]:ring-2";
const ROW_BUTTON_CLASS =
  "flex h-full min-w-0 flex-1 items-center gap-2 rounded-md pl-1.5 text-left outline-hidden";
const GROUP_LABEL_CLASS = "px-1.5 pt-2 pb-1 text-[11px] text-muted-foreground";
/** Everything the arrow keys rove across: link rows, stack layers, the footer. */
const ROVING_SELECTOR = "[data-link-row], [data-layer-main]";

function isFinished(link: WorktreePullRequestLink): boolean {
  return link.state === "merged" || link.state === "closed";
}

function stateWord(link: Pick<WorktreePullRequestLink, "state" | "isDraft">): string {
  if (link.state === "merged") return "Merged";
  if (link.state === "closed") return "Closed";
  if (link.isDraft) return "Draft";
  if (link.state === "open") return "Open";
  return "State unknown";
}

function errorMessage(error: unknown): string | null {
  return error instanceof Error && error.message.length > 0 ? error.message : null;
}

/**
 * Arrow keys, Home and End move focus between the list's rows. Bound on the
 * popup, so they still work when the focused row left the list (unlinked, or
 * moved into the stack once its details arrived) and focus fell back to it.
 */
function moveRovingFocus(event: KeyboardEvent<HTMLElement>, container: HTMLElement | null) {
  if (event.defaultPrevented || container === null) return;
  const { key } = event;
  if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") return;
  const rows = [...container.querySelectorAll<HTMLElement>(ROVING_SELECTOR)];
  if (rows.length === 0) return;
  event.preventDefault();
  const index = rows.indexOf(document.activeElement as HTMLElement);
  const next =
    key === "Home"
      ? 0
      : key === "End"
        ? rows.length - 1
        : index === -1
          ? key === "ArrowDown"
            ? 0
            : rows.length - 1
          : (index + (key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
  rows[next]?.focus();
}

/** Whether a settled request can still show its result here (open and mounted). */
function useVisibleRef(open: boolean) {
  const visibleRef = useRef(false);
  useEffect(() => {
    visibleRef.current = open;
    return () => {
      visibleRef.current = false;
    };
  }, [open]);
  return visibleRef;
}

function LinkRow(props: {
  readonly link: WorktreePullRequestLink;
  readonly shown: boolean;
  /** Take focus when the row arrives (the pull request just linked). */
  readonly focusOnArrival: boolean;
  readonly onFocused: () => void;
  readonly canUnlink: boolean;
  readonly pending: boolean;
  readonly onOpen: (event: MouseEvent<HTMLButtonElement>) => void;
  readonly onUnlink: () => void;
}) {
  const { link } = props;
  const finished = isFinished(link);
  const label = `#${link.number} ${link.title ?? link.headRefName ?? ""}`.trim();
  return (
    <div
      role="listitem"
      aria-current={props.shown ? "true" : undefined}
      aria-busy={props.pending || undefined}
      className={cn(
        ROW_CLASS,
        props.shown ? "bg-accent" : "hover:bg-accent/50",
        props.pending && "pointer-events-none opacity-50",
      )}
    >
      <button
        ref={
          props.focusOnArrival
            ? (node: HTMLButtonElement | null) => {
                if (!node) return;
                node.focus();
                props.onFocused();
              }
            : undefined
        }
        type="button"
        data-link-row=""
        data-link-number={link.number}
        aria-label={`${label}, ${stateWord(link)}`}
        className={ROW_BUTTON_CLASS}
        title={link.title ?? undefined}
        onClick={props.onOpen}
        onKeyDown={(event) => {
          if (props.canUnlink && (event.key === "Delete" || event.key === "Backspace")) {
            event.preventDefault();
            props.onUnlink();
          }
        }}
      >
        <span className="flex w-3.5 shrink-0 justify-center">
          <ChangeRequestStateGlyph state={link.state ?? "open"} isDraft={link.isDraft ?? false} />
        </span>
        <span
          className={cn(
            "shrink-0 text-xs tabular-nums",
            props.shown ? "text-foreground" : "text-muted-foreground",
          )}
        >
          #{link.number}
        </span>
        {link.title ? (
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-[13px]",
              props.shown
                ? "font-medium text-foreground"
                : finished
                  ? "text-muted-foreground"
                  : "text-foreground/85",
            )}
          >
            {link.title}
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
            {link.headRefName ?? ""}
          </span>
        )}
      </button>
      {/* The finish time gives way to "Unlink" (see `.pr-swap` in rail.css). */}
      <span className="pr-swap-slot shrink-0 justify-items-end pr-1.5">
        {!props.shown && finished && link.terminalAt ? (
          <RelativeTime
            value={link.terminalAt}
            className={cn("text-xs text-muted-foreground", props.canUnlink && "pr-swap-out")}
          />
        ) : null}
        {props.pending ? (
          <Spinner className="size-3" />
        ) : props.canUnlink ? (
          <button
            type="button"
            aria-label={`Unlink #${link.number}`}
            className="pr-swap-in h-5 rounded px-1.5 text-[11px] text-muted-foreground outline-hidden hover:bg-background/80 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={props.onUnlink}
          >
            Unlink
          </button>
        ) : null}
      </span>
    </div>
  );
}

function ListView(
  props: WorkspacePullRequestsPopoverProps & {
    /** Focus this number's row once it is in the list (after a link). */
    readonly focusNumber: number | null;
    readonly onFocused: () => void;
  },
) {
  const listLabelId = useId();
  const openLabelId = useId();
  const earlierLabelId = useId();
  const detail = useSourceControlChangeRequestDetail({
    environmentId: props.environmentId,
    cwd: props.cwd,
    reference: props.shownNumber === null ? null : String(props.shownNumber),
    enabled: props.open && props.showStack && props.shownNumber !== null,
  });
  const stack = props.showStack ? resolveDisplayStack(detail.data) : null;
  const stackFacts = useMemo(
    () =>
      stack && props.shownNumber !== null
        ? stackFactsFromDetail({
            stack,
            incomplete: detail.data?.stackMetadataIncomplete === true,
            currentNumber: props.shownNumber,
          })
        : null,
    [detail.data?.stackMetadataIncomplete, props.shownNumber, stack],
  );
  const groups = useMemo(
    () => groupWorkspacePullRequests({ links: props.links, stack }),
    [props.links, stack],
  );
  const dismiss = useDismissWorktreePullRequestMutation({ environmentId: props.environmentId });
  const link = useLinkWorktreePullRequestMutation({ environmentId: props.environmentId });
  const [pendingNumber, setPendingNumber] = useState<number | null>(null);
  const visibleRef = useVisibleRef(props.open);
  const editable = props.canEdit && props.worktreeId !== null;

  const unlink = (number: number) => {
    if (props.worktreeId === null || pendingNumber !== null) return;
    const worktreeId = props.worktreeId;
    setPendingNumber(number);
    dismiss
      .mutateAsync({ worktreeId, number })
      .then(() => {
        if (visibleRef.current) props.onUnlinked?.(number);
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: `Unlinked #${number}`,
            timeout: 5000,
            actionProps: {
              children: "Undo",
              // Linking by hand brings a dismissed pull request back.
              onClick: () =>
                void link
                  .mutateAsync({ worktreeId, reference: String(number) })
                  .catch((error: unknown) =>
                    toastManager.add(
                      stackedThreadToast({
                        type: "error",
                        title: `Couldn't link #${number} again`,
                        description: errorMessage(error) ?? undefined,
                      }),
                    ),
                  ),
            },
          }),
        );
      })
      .catch((error: unknown) =>
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Couldn't unlink #${number}`,
            description: errorMessage(error) ?? undefined,
          }),
        ),
      )
      .finally(() => setPendingNumber(null));
  };

  const openNumber = (number: number) => {
    props.onOpenChange(false);
    props.onOpenPullRequest(number);
  };
  const openLink = (entry: WorktreePullRequestLink, event: MouseEvent<HTMLButtonElement>) => {
    if (entry.url && prefersExternalPullRequestLink(event)) {
      openExternalLink(entry.url, "Unable to open pull request link");
      return;
    }
    openNumber(entry.number);
  };
  const row = (entry: WorktreePullRequestLink) => (
    <LinkRow
      key={entry.number}
      link={entry}
      shown={entry.number === props.shownNumber}
      focusOnArrival={entry.number === props.focusNumber}
      onFocused={props.onFocused}
      canUnlink={editable && (props.storedNumbers?.has(entry.number) ?? true)}
      pending={pendingNumber === entry.number}
      onOpen={(event) => openLink(entry, event)}
      onUnlink={() => unlink(entry.number)}
    />
  );

  return (
    <div>
      <div role="list" aria-labelledby={listLabelId}>
        <span id={listLabelId} className="sr-only">
          Linked pull requests
        </span>
        {groups.stack && stackFacts ? (
          // ⌘/Ctrl-click on a layer opens it on the host, as on every row here.
          <div
            onClickCapture={(event) => {
              if (!prefersExternalPullRequestLink(event)) return;
              const number = Number(
                (event.target as Element)
                  .closest<HTMLElement>("[data-layer-number]")
                  ?.getAttribute("data-layer-number"),
              );
              const url = groups.stack?.entries.find((entry) => entry.number === number)?.url;
              if (!url) return;
              event.preventDefault();
              event.stopPropagation();
              openExternalLink(url, "Unable to open pull request link");
            }}
          >
            <div className="px-1.5 pt-1 pb-1 text-xs">
              <StackSummary facts={stackFacts} />
            </div>
            <StackLayerList
              stack={groups.stack}
              currentNumber={stackFacts.currentNumber}
              canMergeThrough={false}
              onSelect={openNumber}
              onMergeThrough={() => undefined}
            />
          </div>
        ) : null}
        {groups.open.length > 0 ? (
          <div role="group" aria-labelledby={groups.stack ? openLabelId : undefined}>
            {groups.stack ? (
              <div id={openLabelId} className={GROUP_LABEL_CLASS}>
                Also open
              </div>
            ) : null}
            {groups.open.map(row)}
          </div>
        ) : null}
        {groups.earlier.length > 0 ? (
          <div role="group" aria-labelledby={earlierLabelId}>
            <div
              id={earlierLabelId}
              className={cn(
                GROUP_LABEL_CLASS,
                // First in the list it labels for screen readers only.
                !groups.stack && groups.open.length === 0 && "sr-only",
              )}
            >
              Earlier
            </div>
            {groups.earlier.map(row)}
          </div>
        ) : null}
      </div>
      {editable ? (
        <div className="mt-1 border-t border-border/60 pt-1">
          <button
            type="button"
            data-link-row=""
            className="flex h-7 w-full items-center gap-2 rounded-md pl-1.5 text-left text-[13px] text-muted-foreground outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => props.onViewChange("link")}
          >
            <span className="flex w-3.5 shrink-0 justify-center">
              <LinkIcon className="size-3.5" aria-hidden />
            </span>
            Link pull request…
          </button>
        </div>
      ) : null}
    </div>
  );
}

interface LinkOption {
  readonly key: string;
  readonly number: number;
  readonly reference: string;
  readonly title: string | null;
  readonly branch: string | null;
  readonly state: "open" | "closed" | "merged" | null;
  readonly isDraft: boolean;
  /** Already a visible link: shown, not pickable. */
  readonly linked: boolean;
}

function LinkView(
  props: WorkspacePullRequestsPopoverProps & {
    readonly onLinkedInView: (number: number) => void;
  },
) {
  const listId = useId();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  const [pendingNumber, setPendingNumber] = useState<number | null>(null);
  // Read when a link request settles, possibly after the popover closed.
  const visibleRef = useVisibleRef(props.open);
  const link = useLinkWorktreePullRequestMutation({ environmentId: props.environmentId });
  const openList = useOverviewChangeRequestList({
    environmentId: props.environmentId,
    cwd: props.cwd,
    enabled: props.open,
  });
  const linkedNumbers = useMemo(
    () => new Set(props.links.map((entry) => entry.number)),
    [props.links],
  );
  const linkHeads = useMemo(
    () => new Set(props.links.flatMap((entry) => (entry.headRefName ? [entry.headRefName] : []))),
    [props.links],
  );
  const ranked = useMemo(
    () =>
      rankLinkCandidates(openList.data ?? [], {
        linkedNumbers,
        workspaceBranch: props.workspaceBranch,
        linkHeads,
        query,
      }),
    [linkHeads, linkedNumbers, openList.data, props.workspaceBranch, query],
  );
  const typedNumber = parsePullRequestReferenceNumber(query);
  // A pasted URL (bare, or inside `gh pr checkout …`) names its repository
  // too; it goes to the server as is, which checks it is this one.
  const typedReference = parsePullRequestReference(query);
  const typedUrl =
    typedReference !== null && /^https?:/iu.test(typedReference) ? typedReference : null;
  const [debouncedQuery] = useDebouncedValue(query, { wait: 250 });
  const debouncedNumber = parsePullRequestReferenceNumber(debouncedQuery);
  const typedListed = ranked.some((candidate) => candidate.number === typedNumber);
  // A typed number the open list does not carry (merged, closed, another
  // branch): resolve it so the row can say what it is before it is linked.
  const resolved = useResolvePullRequest({
    environmentId: props.environmentId,
    cwd: props.cwd,
    reference:
      props.open &&
      debouncedNumber !== null &&
      debouncedNumber === typedNumber &&
      !typedListed &&
      !linkedNumbers.has(debouncedNumber)
        ? String(debouncedNumber)
        : null,
  });
  const resolvedPullRequest =
    resolved.data?.pullRequest.number === typedNumber ? resolved.data.pullRequest : null;
  const options = useMemo<LinkOption[]>(() => {
    const listed = ranked.map((candidate): LinkOption => ({
      key: `pr:${candidate.number}`,
      number: candidate.number,
      reference: String(candidate.number),
      title: candidate.title,
      branch: candidate.headRefName,
      state: candidate.state,
      isDraft: candidate.isDraft ?? false,
      linked: false,
    }));
    if (typedNumber === null || typedListed) return listed;
    const linked = props.links.find((entry) => entry.number === typedNumber) ?? null;
    const typed: LinkOption = {
      key: "typed",
      number: typedNumber,
      reference: typedUrl ?? String(typedNumber),
      title: linked?.title ?? resolvedPullRequest?.title ?? null,
      branch: linked?.headRefName ?? resolvedPullRequest?.headBranch ?? null,
      state: linked?.state ?? resolvedPullRequest?.state ?? null,
      isDraft: linked?.isDraft ?? false,
      linked: linked !== null,
    };
    return [typed, ...listed];
  }, [props.links, ranked, resolvedPullRequest, typedListed, typedNumber, typedUrl]);
  const active = options[Math.min(activeIndex, Math.max(0, options.length - 1))];

  const submit = (option: LinkOption | undefined) => {
    if (!option || option.linked || props.worktreeId === null || pendingNumber !== null) return;
    setFailure(null);
    setPendingNumber(option.number);
    link
      .mutateAsync({ worktreeId: props.worktreeId, reference: option.reference })
      .then((linked) => {
        // Closed meanwhile (or the surface moved on): every surface shows the
        // new link; nothing to say or navigate to here.
        if (!visibleRef.current) return;
        props.onLinkedInView(linked.number);
        props.onLinked?.(linked.number);
      })
      .catch((error: unknown) => {
        const reason = errorMessage(error);
        const message = `Couldn't link #${option.number}${reason ? `: ${reason}` : ""}`;
        if (visibleRef.current) setFailure(message);
        else toastManager.add(stackedThreadToast({ type: "error", title: message }));
      })
      .finally(() => setPendingNumber(null));
  };

  return (
    <div>
      <div className="flex items-center gap-1 border-b border-border/60 pb-1.5">
        {props.links.length > 0 ? (
          <button
            type="button"
            aria-label="Back to pull requests"
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-hidden hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => props.onViewChange("list")}
          >
            <ArrowLeftIcon className="size-3.5" />
          </button>
        ) : null}
        <input
          autoFocus
          data-initial-focus=""
          role="combobox"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls={listId}
          aria-activedescendant={active ? `${listId}-${active.key}` : undefined}
          aria-label="Pull request to link"
          placeholder="Number, link, or title"
          readOnly={pendingNumber !== null}
          value={query}
          className="h-7 min-w-0 flex-1 bg-transparent px-1.5 text-[13px] outline-hidden placeholder:text-muted-foreground/70"
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
            setFailure(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              setActiveIndex(
                (index) => (index + step + options.length) % Math.max(1, options.length),
              );
            } else if (event.key === "Enter") {
              event.preventDefault();
              submit(active);
            } else if (event.key === "Escape" && props.links.length > 0) {
              event.preventDefault();
              event.stopPropagation();
              props.onViewChange("list");
            }
          }}
        />
      </div>
      <div
        id={listId}
        role="listbox"
        aria-label="Pull requests"
        className="max-h-72 overflow-y-auto pt-1"
      >
        {options.map((option, index) => {
          const thisBranch = option.branch !== null && option.branch === props.workspaceBranch;
          return (
            <div
              key={option.key}
              id={`${listId}-${option.key}`}
              role="option"
              aria-selected={option === active}
              aria-disabled={option.linked || pendingNumber !== null || undefined}
              className={cn(
                "flex h-7 cursor-default items-center gap-2 rounded-md px-1.5 text-[13px]",
                option === active && !option.linked && "bg-accent",
                option.linked && "text-muted-foreground",
              )}
              onMouseMove={() => setActiveIndex(index)}
              onClick={() => submit(option)}
            >
              <span className="flex w-3.5 shrink-0 justify-center">
                {option.state === null ? (
                  <LinkIcon className="size-3.5 text-muted-foreground" aria-hidden />
                ) : (
                  <ChangeRequestStateGlyph state={option.state} isDraft={option.isDraft} />
                )}
              </span>
              {option.title === null ? (
                <span className="min-w-0 flex-1 truncate">Link #{option.number}</span>
              ) : (
                <>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    #{option.number}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{option.title}</span>
                </>
              )}
              {pendingNumber === option.number ? (
                <Spinner className="size-3.5" />
              ) : option.linked ? (
                <span className="ml-auto shrink-0 text-[11px]">Already linked</span>
              ) : option.branch ? (
                <span
                  className={cn(
                    "ml-auto max-w-28 truncate text-[11px] text-muted-foreground",
                    !thisBranch && "font-mono",
                  )}
                >
                  {thisBranch ? "this branch" : option.branch}
                </span>
              ) : null}
            </div>
          );
        })}
        {options.length === 0 ? (
          <p className="px-1.5 py-2 text-xs text-muted-foreground">
            {openList.isLoading
              ? "Loading open pull requests…"
              : "No open pull request matches. Paste a number or link."}
          </p>
        ) : null}
      </div>
      {failure ? (
        <p role="alert" className="px-1.5 pt-1.5 text-[11px] text-destructive-foreground">
          {failure}
        </p>
      ) : null}
    </div>
  );
}

export function WorkspacePullRequestsPopover(props: WorkspacePullRequestsPopoverProps) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [focusNumber, setFocusNumber] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const { onOpenChange, onViewChange, toggle } = props;
  const linkView = props.view === "link" || props.links.length === 0;
  // Closed by the surface (its toggle): drop what the last opening left behind.
  if (!props.open && (focusNumber !== null || announcement !== "")) {
    setFocusNumber(null);
    setAnnouncement("");
  }
  // Every close from in here resets the popover, however it closed.
  const close = () => {
    onOpenChange(false);
    onViewChange("list");
    setFocusNumber(null);
    setAnnouncement("");
  };
  return (
    <Popover
      open={props.open}
      onOpenChange={(open, details) => {
        if (open) {
          onOpenChange(true);
          return;
        }
        // A press on the surface's own toggle is its to handle (it closes):
        // neither the press nor the focus it moves there dismisses here.
        const target =
          details.reason === "focus-out"
            ? (details.event as FocusEvent | undefined)?.relatedTarget
            : details.event?.target;
        if (
          (details.reason === "outside-press" || details.reason === "focus-out") &&
          target instanceof Node &&
          toggle?.()?.contains(target)
        ) {
          details.cancel();
          return;
        }
        close();
      }}
    >
      <PopoverPopup
        side={props.side ?? "bottom"}
        align={props.align ?? "start"}
        sideOffset={props.sideOffset ?? 6}
        anchor={props.anchor}
        className="w-80"
        viewportClassName="px-2 py-2 [--viewport-inline-padding:--spacing(2)]"
        // React events bubble through the portal to whatever renders this (a
        // sidebar row is a context-menu trigger, with a touch long-press).
        onContextMenu={(event) => event.stopPropagation()}
        onTouchStart={(event) => event.stopPropagation()}
        onKeyDown={linkView ? undefined : (event) => moveRovingFocus(event, contentRef.current)}
        // The picker's input, else the row of the pull request on screen.
        initialFocus={() =>
          contentRef.current?.querySelector<HTMLElement>(
            '[data-initial-focus], [aria-current="true"] > [data-link-row], [aria-current="true"] > [data-layer-main]',
          ) ?? true
        }
      >
        <PopoverTitle className="sr-only">Pull requests in {props.workspaceTitle}</PopoverTitle>
        <div ref={contentRef}>
          {linkView ? (
            <LinkView
              {...props}
              onLinkedInView={(number) => {
                // The first link leaves nothing to go back to; the surface shows it.
                if (props.links.length === 0) {
                  close();
                  return;
                }
                setAnnouncement(`Linked #${number}`);
                setFocusNumber(number);
                onViewChange("list");
              }}
            />
          ) : (
            <ListView {...props} focusNumber={focusNumber} onFocused={() => setFocusNumber(null)} />
          )}
          <p role="status" aria-live="polite" className="sr-only">
            {announcement}
          </p>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

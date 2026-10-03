import { ArrowRightIcon, PencilIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type Ref } from "react";

import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import { cn } from "../../../lib/utils";
import { useUpdateChangeRequestMutation } from "../../../rpc/useSourceControl";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import {
  ActorAvatar,
  ChangeRequestStateGlyph,
  DiffStat,
  KeyHint,
  changeRequestStateLabel,
  toIsoString,
  type TimeLike,
} from "../primitives";
import { usePullRequestSelection, usePullRequestsPage } from "../PullRequestsPageContext";
import { usePullRequestReaderStore } from "../pullRequestsLayoutStore";
import { errorText } from "./MarkdownEditor";

/** Edit requests already answered, per reader, so a remount does not reopen the editor. */
const handledTitleEditRequests = new Map<string, number>();

const OPENED_DATE = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const OPENED_DATE_WITH_YEAR = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

function openedDate(value: TimeLike): { readonly iso: string; readonly label: string } | null {
  const iso = toIsoString(value);
  if (iso === null) return null;
  const date = new Date(iso);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return { iso, label: (sameYear ? OPENED_DATE : OPENED_DATE_WITH_YEAR).format(date) };
}

export const META_BUTTON_CLASS =
  "rounded-[4px] outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

function useCopyWithToast() {
  const { copyToClipboard } = useCopyToClipboard<string>({
    onCopy: (what) =>
      toastManager.add(
        stackedThreadToast({ type: "success", title: `Copied ${what}`, timeout: 1600 }),
      ),
  });
  return copyToClipboard;
}

/**
 * Conversation's masthead: the title (editable in place) over one meta line
 * that states identity once — state, number, author and date, branches, size.
 * The bar shows the title instead once this scrolls away.
 */
export function Masthead({ ref }: { readonly ref?: Ref<HTMLElement> | undefined }) {
  return (
    <header ref={ref} className="min-w-0">
      <EditableTitle />
      <MetaLine />
    </header>
  );
}

function EditableTitle() {
  const { readerKey, model, nav } = usePullRequestsPage();
  const selection = usePullRequestSelection();
  const detail = selection.detail.data;
  const title = detail?.title ?? selection.summary?.title ?? `#${selection.number}`;
  const canUpdate = model.supportsReview && (selection.activity.data?.viewer?.canUpdate ?? false);
  const update = useUpdateChangeRequestMutation(selection.mutationTarget);
  const [editing, setEditing] = useState(false);

  // "Edit title" from the bar menu or `E` bumps a counter; answer each bump once.
  const editRequest = usePullRequestReaderStore((state) =>
    readerKey ? (state.titleEditRequest[readerKey] ?? 0) : 0,
  );
  // Answer only once Conversation is the active tab. The request can commit
  // before the tab switch it came with (the router commits tabs in a
  // transition), and an editor opened inside the hidden, inert panel cannot
  // take focus, so typing would reach the page shortcuts instead.
  const active = nav.tab === "conversation";
  // Answering a request from another component's store is a sync with an external event.
  useEffect(() => {
    if (!readerKey) return;
    if (editRequest === 0) {
      // No request (or the store started over): nothing counts as answered.
      handledTitleEditRequests.delete(readerKey);
      return;
    }
    if (!active) return;
    if ((handledTitleEditRequests.get(readerKey) ?? 0) >= editRequest) return;
    handledTitleEditRequests.set(readerKey, editRequest);
    // oxlint-disable-next-line react/set-state-in-effect -- see above
    if (canUpdate) setEditing(true);
  }, [active, canUpdate, editRequest, readerKey]);

  if (editing) {
    return (
      <TitleEditor
        initialValue={title}
        onCancel={() => setEditing(false)}
        onSubmit={async (next) => {
          await update.mutateAsync({ kind: "edit", title: next });
          setEditing(false);
        }}
      />
    );
  }

  return (
    <div className="group/title flex min-w-0 items-start gap-1">
      <h1 className="line-clamp-2 min-w-0 text-xl leading-[1.3] font-semibold tracking-[-0.012em] text-balance text-foreground">
        {title}
      </h1>
      {canUpdate ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Edit title"
                onClick={() => setEditing(true)}
                className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-hidden transition-[opacity,background-color,color] duration-(--app-motion-duration-chip) group-hover/title:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:opacity-100"
              >
                <PencilIcon className="size-3.5" />
              </button>
            }
          />
          <TooltipPopup side="bottom" sideOffset={4}>
            <span className="inline-flex items-center gap-1.5">
              Edit title
              <KeyHint>E</KeyHint>
            </span>
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
}

function TitleEditor(props: {
  readonly initialValue: string;
  readonly onSubmit: (title: string) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const [value, setValue] = useState(props.initialValue);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const settledRef = useRef(false);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    input.select();
  }, []);

  const commit = async () => {
    if (pending || settledRef.current) return;
    // Titles are one line; pasted newlines collapse to spaces.
    const next = value.replace(/\s+/gu, " ").trim();
    if (next.length === 0 || next === props.initialValue.trim()) {
      settledRef.current = true;
      props.onCancel();
      return;
    }
    setPending(true);
    setError(null);
    try {
      await props.onSubmit(next);
      settledRef.current = true;
    } catch (submitError) {
      setError(errorText(submitError, "Could not rename the pull request."));
      setPending(false);
    }
  };

  return (
    <div className="min-w-0">
      <textarea
        ref={inputRef}
        aria-label="Pull request title"
        rows={1}
        value={value}
        disabled={pending}
        onChange={(event) => {
          setValue(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            settledRef.current = true;
            props.onCancel();
          }
        }}
        onBlur={() => {
          if (!error) void commit();
        }}
        className="-mx-1.5 -my-0.5 block field-sizing-content w-[calc(100%+0.75rem)] resize-none rounded-md bg-transparent px-1.5 py-0.5 text-xl leading-[1.3] font-semibold tracking-[-0.012em] text-foreground ring-1 ring-border outline-none transition-shadow duration-(--app-motion-duration-chip) focus:ring-ring/70 focus:shadow-[0_0_0_4px_color-mix(in_srgb,var(--ring)_14%,transparent)] disabled:opacity-70"
      />
      <p className="mt-1.5 text-[11px] text-muted-foreground" aria-live="polite">
        {error ? (
          <span className="text-destructive">{error}</span>
        ) : (
          <>
            <KeyHint>↵</KeyHint> to save · <KeyHint>Esc</KeyHint> to cancel
          </>
        )}
      </p>
    </div>
  );
}

function MetaLine() {
  const selection = usePullRequestSelection();
  const copy = useCopyWithToast();
  const detail = selection.detail.data;
  const summary = selection.summary;
  const source = detail ?? summary;
  if (!source) return null;
  const state = source.state;
  const isDraft = source.isDraft ?? false;
  const stateLabel = changeRequestStateLabel({ state, isDraft });
  const author = source.author ?? null;
  const authorActor = author
    ? selection.activity.data?.timeline.find((item) => item.actor?.login === author)?.actor
    : undefined;
  const opened = openedDate(detail?.createdAt ?? summary?.createdAt);
  const head =
    source.isCrossRepository && source.headRepositoryOwnerLogin
      ? `${source.headRepositoryOwnerLogin}:${source.headRefName}`
      : source.headRefName;
  const additions = detail?.additions ?? summary?.additions;
  const deletions = detail?.deletions ?? summary?.deletions;

  return (
    <div className="pr-meta mt-2 flex min-w-0 flex-wrap items-center gap-y-1 text-xs leading-5 text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <ChangeRequestStateGlyph state={state} isDraft={isDraft} />
        <span className="font-medium text-foreground/90">{stateLabel}</span>
      </span>
      <span className="inline-flex">
        <button
          type="button"
          className={cn(META_BUTTON_CLASS, "tabular-nums")}
          aria-label={`Copy link to #${selection.number}`}
          title="Copy link"
          onClick={() => copy(source.url, "link")}
        >
          #{selection.number}
        </button>
      </span>
      {author ? (
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <ActorAvatar login={author} avatarUrl={authorActor?.avatarUrl} size={16} />
          <span className="truncate text-foreground/90">{author}</span>
          {opened ? (
            <span className="shrink-0">
              opened{" "}
              <time dateTime={opened.iso} title={new Date(opened.iso).toLocaleString()}>
                {opened.label}
              </time>
            </span>
          ) : null}
        </span>
      ) : null}
      <span className="inline-flex min-w-0 max-w-full items-center gap-1 font-mono text-[11px]">
        <button
          type="button"
          className={cn(META_BUTTON_CLASS, "min-w-0 truncate")}
          title={`Copy ${head}`}
          onClick={() => copy(head, "branch name")}
        >
          {head}
        </button>
        <ArrowRightIcon className="size-3 shrink-0 opacity-60" aria-label="into" />
        <button
          type="button"
          className={cn(META_BUTTON_CLASS, "min-w-0 truncate")}
          title={`Copy ${source.baseRefName}`}
          onClick={() => copy(source.baseRefName, "branch name")}
        >
          {source.baseRefName}
        </button>
      </span>
      {additions !== undefined || deletions !== undefined ? (
        <span className="inline-flex">
          <DiffStat additions={additions} deletions={deletions} />
        </span>
      ) : null}
    </div>
  );
}

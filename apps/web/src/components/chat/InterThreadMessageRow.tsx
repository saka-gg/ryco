// FILE: InterThreadMessageRow.tsx
// Purpose: A message another chat sent this one (an agent's `ryco_send_message`, or the result of
//          a task this chat delegated). The person's messages sit on the right and this chat's
//          agent on the left; another chat's sits in the middle: who sent it, how that chat
//          relates to this one, and what it said. It never reads as the sender taking charge.
// Layer: Web UI, desktop and tablet only. The frozen phone tier keeps its one-line fold
//        (`MessagesTimeline`). Copy is shared through `@ryco/client-runtime`.

import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  delegationReturnsHeadline,
  delegationReturnTone,
  delegationReturnVerb,
  INTER_THREAD_COPY,
  interThreadRelationOf,
  type DelegationReturnSection,
  type DelegationReturnTone,
  type InterThreadMessage,
  type InterThreadRelation,
} from "@ryco/client-runtime/state/threads/interThreadMessage";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { useRouter } from "@tanstack/react-router";
import {
  CircleCheckIcon,
  CircleXIcon,
  CornerDownRightIcon,
  CornerUpLeftIcon,
  ExternalLinkIcon,
  InfoIcon,
  MailIcon,
  type LucideIcon,
} from "lucide-react";
import { type CSSProperties, memo, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { cn } from "../../lib/utils";
import { useStore } from "../../store";
import { buildThreadRouteHref, buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { useInboxClock } from "../inboxSidebar/useInboxListMotion";
import { deriveProjectMonogram, monogramColorFor } from "../projectMonogram";

const RELATION_ICON: Record<InterThreadRelation, LucideIcon> = {
  "delegated-task": CornerUpLeftIcon,
  "delegating-parent": CornerDownRightIcon,
  unlinked: MailIcon,
};

const RELATION_TONE: Record<InterThreadRelation, string> = {
  "delegated-task": "text-teal-600 dark:text-teal-400",
  "delegating-parent": "text-info",
  unlinked: "text-muted-foreground",
};

const RETURN_ICON: Record<DelegationReturnTone, LucideIcon> = {
  success: CircleCheckIcon,
  danger: CircleXIcon,
  muted: InfoIcon,
};

const RETURN_TONE: Record<DelegationReturnTone, string> = {
  success: "text-success",
  danger: "text-destructive",
  muted: "text-muted-foreground",
};

const BODY_TEXT = "whitespace-pre-wrap wrap-anywhere text-sm leading-relaxed text-foreground";
const LINK =
  "inline-flex items-center gap-1 rounded-sm text-xs whitespace-nowrap text-info-foreground outline-none hover:underline focus-visible:ring-1 focus-visible:ring-ring/60";

interface KnownThread {
  readonly title: string;
  readonly lineage?: Parameters<typeof interThreadRelationOf>[0]["threadLineage"];
}

/** Title and lineage of each thread this client knows, in order; undefined for the rest. */
function useKnownThreads(
  environmentId: EnvironmentId,
  threadIds: ReadonlyArray<ThreadId | null>,
): ReadonlyArray<KnownThread | undefined> {
  return useStore(
    useShallow((state) => {
      const shells = state.environmentStateById[environmentId]?.threadShellById;
      return threadIds.map((id) => (id === null ? undefined : shells?.[id]));
    }),
  );
}

function ThreadMonogram(props: { readonly threadId: ThreadId; readonly title: string }) {
  return (
    <span
      aria-hidden
      className="inline-grid size-[18px] shrink-0 place-items-center rounded-[5px] bg-[color-mix(in_oklab,var(--thread-monogram)_18%,transparent)] text-[9px] font-semibold text-(--thread-monogram) dark:text-[color-mix(in_oklab,var(--thread-monogram)_55%,white)]"
      style={{ "--thread-monogram": monogramColorFor(props.threadId) } as CSSProperties}
    >
      {deriveProjectMonogram(props.title).initials}
    </span>
  );
}

/** Whether a clamped block hides lines; stays true while it is open, so it can close again. */
function useClampOverflow(open: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null || open) return;
    const check = () =>
      setOverflows(
        Array.from(element.querySelectorAll<HTMLElement>("[data-clamped]")).some(
          (block) => block.scrollHeight > block.clientHeight + 1,
        ),
      );
    check();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(check);
    observer.observe(element);
    return () => observer.disconnect();
  }, [open]);
  return [ref, overflows] as const;
}

/** A link to another chat that navigates in place (and still opens in a new tab). */
function ThreadLink(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const router = useRouter({ warn: false });
  const ref = scopeThreadRef(props.environmentId, props.threadId);
  return (
    <a
      className={cn(LINK, props.className)}
      href={buildThreadRouteHref(ref)}
      onClick={(event) => {
        if (!router || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
          return;
        }
        event.preventDefault();
        void router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(ref),
        });
      }}
    >
      {props.children}
      <ExternalLinkIcon aria-hidden className="size-[11px] shrink-0" />
    </a>
  );
}

/** "· 4m ago". The clock ticks every second, so only this label re-renders with it. */
function MessageAge(props: { readonly createdAt: string }) {
  const now = useInboxClock();
  return (
    <span className="text-muted-foreground" title={new Date(props.createdAt).toLocaleString()}>
      · {formatRelativeTimeLabel(props.createdAt, now)}
    </span>
  );
}

function ClampedBody(props: { readonly text: string; readonly open: boolean }) {
  return (
    <div data-clamped className={cn(BODY_TEXT, !props.open && "line-clamp-2")}>
      {props.text}
    </div>
  );
}

export const InterThreadMessageRow = memo(function InterThreadMessageRow(props: {
  readonly message: { readonly id: string; readonly text: string; readonly createdAt: string };
  readonly inter: InterThreadMessage;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | undefined;
}) {
  const { message, inter, environmentId, threadId } = props;
  const sections = inter.kind === "delegation-result" ? inter.sections : [];
  const senderIds: ReadonlyArray<ThreadId | null> =
    inter.kind === "agent-message"
      ? [inter.senderThreadId]
      : sections.map((section) => section.childThreadId as ThreadId | null);
  const [current, ...senders] = useKnownThreads(environmentId, [threadId ?? null, ...senderIds]);
  const [open, setOpen] = useState(false);
  const [clampRef, overflows] = useClampOverflow(open);

  const relation: InterThreadRelation =
    inter.kind === "delegation-result"
      ? "delegated-task"
      : threadId === undefined
        ? "unlinked"
        : interThreadRelationOf({
            threadId,
            threadLineage: current?.lineage,
            senderThreadId: inter.senderThreadId,
            senderLineage: senders[0]?.lineage,
          });

  let icon: LucideIcon;
  let iconTone: string;
  let senderId: ThreadId | null = null;
  let senderName: string;
  let verb: string;
  let relationLabel: string = INTER_THREAD_COPY.relation[relation];
  if (inter.kind === "agent-message") {
    icon = RELATION_ICON[relation];
    iconTone = RELATION_TONE[relation];
    senderId = inter.senderThreadId;
    senderName =
      senderId === null
        ? INTER_THREAD_COPY.unknownSender
        : (senders[0]?.title ?? INTER_THREAD_COPY.unknownThread);
    verb = INTER_THREAD_COPY.verb[relation];
  } else if (sections.length === 1) {
    const tone = delegationReturnTone(sections[0]!);
    icon = RETURN_ICON[tone];
    iconTone = RETURN_TONE[tone];
    senderId = sections[0]!.childThreadId as ThreadId | null;
    senderName = senders[0]?.title ?? INTER_THREAD_COPY.unknownTask;
    verb = delegationReturnVerb(sections[0]!);
  } else {
    const allCompleted = sections.length > 0 && sections.every((s) => s.state === "completed");
    icon = allCompleted ? CircleCheckIcon : CornerUpLeftIcon;
    iconTone = allCompleted ? RETURN_TONE.success : RELATION_TONE["delegated-task"];
    senderName =
      sections.length === 0
        ? INTER_THREAD_COPY.unknownTask
        : delegationReturnsHeadline(sections.length);
    verb = sections.length === 0 ? INTER_THREAD_COPY.verb["delegated-task"] : "";
    if (sections.length > 1) relationLabel = INTER_THREAD_COPY.delegatedTasks;
  }
  const Icon = icon;
  const senderKnown = senderId !== null && senders[0] !== undefined;
  const listed = sections.length > 1;
  const bodyText =
    inter.kind === "agent-message" || sections.length === 0
      ? message.text
      : sections[0]!.text || INTER_THREAD_COPY.noSummary;

  return (
    <div
      role="group"
      aria-label={verb ? `${senderName} ${verb}` : senderName}
      className="my-1 flex w-full min-w-0 flex-col items-center gap-1.5"
      data-inter-thread-message={inter.kind}
      data-inter-thread-relation={relation}
    >
      <div className="flex w-full min-w-0 items-center gap-2.5">
        <span aria-hidden className="h-px min-w-4 flex-1 bg-border" />
        <span className="inline-flex min-w-0 max-w-[80%] flex-wrap items-center justify-center gap-1.5 text-xs text-muted-foreground">
          <Icon aria-hidden className={cn("size-[13px] shrink-0", iconTone)} />
          {senderKnown ? <ThreadMonogram threadId={senderId!} title={senderName} /> : null}
          <b className="min-w-0 max-w-full truncate font-semibold text-foreground">{senderName}</b>
          {verb ? <span>{verb}</span> : null}
        </span>
        <span aria-hidden className="h-px min-w-4 flex-1 bg-border" />
      </div>
      <div className="-mt-0.5 flex items-center gap-1.5 text-[11px]">
        <span className={cn("font-medium", RELATION_TONE[relation])}>{relationLabel}</span>
        <MessageAge createdAt={message.createdAt} />
      </div>
      <div
        ref={clampRef}
        className="flex w-full max-w-[560px] min-w-0 flex-col gap-1.5 rounded-xl border border-border bg-foreground/3 px-3.5 py-2.5"
      >
        {listed ? (
          <div className="flex min-w-0 flex-col gap-2.5">
            {sections.map((section, index) => (
              <ReturnedTask
                key={section.childThreadId ?? `${section.state}:${section.text}`}
                section={section}
                known={senders[index]}
                open={open}
                environmentId={environmentId}
              />
            ))}
          </div>
        ) : (
          <ClampedBody text={bodyText} open={open} />
        )}
        {overflows || (!listed && senderKnown) ? (
          <div className="flex gap-3.5">
            {overflows ? (
              <button
                type="button"
                aria-expanded={open}
                className={LINK}
                onClick={() => setOpen((value) => !value)}
              >
                {open ? "Show less" : "Show all"}
              </button>
            ) : null}
            {!listed && senderKnown ? (
              <ThreadLink environmentId={environmentId} threadId={senderId!}>
                Open {senderName}
              </ThreadLink>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
});

/** One task of a result that returned several. */
function ReturnedTask(props: {
  readonly section: DelegationReturnSection;
  readonly known: KnownThread | undefined;
  readonly open: boolean;
  readonly environmentId: EnvironmentId;
}) {
  const { section, known, open, environmentId } = props;
  const tone = delegationReturnTone(section);
  const Icon = RETURN_ICON[tone];
  const childId = section.childThreadId as ThreadId | null;
  const title = known?.title ?? INTER_THREAD_COPY.unknownTask;
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <Icon aria-hidden className={cn("size-[13px] shrink-0", RETURN_TONE[tone])} />
        {childId !== null && known ? <ThreadMonogram threadId={childId} title={title} /> : null}
        <b className="min-w-0 max-w-full truncate font-semibold text-foreground">{title}</b>
        <span>{delegationReturnVerb(section)}</span>
        {childId !== null && known ? (
          <ThreadLink environmentId={environmentId} threadId={childId} className="ml-auto">
            Open
          </ThreadLink>
        ) : null}
      </div>
      <ClampedBody text={section.text || INTER_THREAD_COPY.noSummary} open={open} />
    </div>
  );
}

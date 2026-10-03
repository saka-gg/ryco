import { useCallback, useRef } from "react";

import { invalidateSourceControl } from "../../../rpc/useSourceControl";
import { Skeleton } from "../../ui/skeleton";
import { usePullRequestSelection, usePullRequestsPage } from "../PullRequestsPageContext";
import { FactsPanel } from "../rail/FactsPanel";
import {
  useConversationScrollMemory,
  useMastheadVisibility,
  useThreadReveal,
  useUnresolvedThreadKeys,
} from "./conversationScroll";
import { DescriptionBlock } from "./DescriptionBlock";
import { Masthead } from "./Masthead";
import { PullRequestTimeline, TimelineNotice } from "./PullRequestTimeline";
import type { TimelineComposerHandle } from "./TimelineComposer";

/**
 * The Conversation tab: masthead, description and the timeline in one
 * scrolling column. With a reader of 800px or more the facts sit beside it as
 * a sticky 264px rail; below that they fold into an untinted band under the
 * masthead. The masthead lives only here — the bar shows the title instead
 * once it scrolls away.
 */
export function ConversationTab() {
  const { model } = usePullRequestsPage();
  // The reader mounts only with a selection; this keeps the pane well-formed regardless.
  return model.selection === null ? <div className="h-full" /> : <Conversation />;
}

function Conversation() {
  const { layout, model, nav, readerKey } = usePullRequestsPage();
  const selection = usePullRequestSelection();
  const scrollRef = useRef<HTMLDivElement>(null);
  const mastheadRef = useRef<HTMLElement>(null);
  const composerRef = useRef<TimelineComposerHandle>(null);
  const quote = useCallback((markdown: string) => composerRef.current?.quote(markdown), []);

  const hasHeader = selection.detail.data !== null || selection.summary !== null;
  const detailSettled = selection.detail.data !== null || selection.detail.error !== null;
  const activitySettled =
    !model.capabilities.activity ||
    selection.activity.data !== null ||
    selection.activity.error !== null;
  const threadTarget = nav.tab === "conversation" ? nav.search.thread : undefined;

  useMastheadVisibility({ scrollRef, mastheadRef, readerKey, enabled: hasHeader });
  useConversationScrollMemory({
    scrollRef,
    readerKey,
    settled: detailSettled && activitySettled,
    skip: threadTarget !== undefined,
  });
  useThreadReveal({ scrollRef, threadId: threadTarget, ready: selection.activity.data !== null });
  useUnresolvedThreadKeys(scrollRef);

  const railDocked = layout.railDocked;

  return (
    <div
      ref={scrollRef}
      data-pr-conversation=""
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain [container-type:size] [scrollbar-gutter:stable]"
    >
      {/* One reading measure (68ch prose plus the timeline gutter); wide readers centre it. */}
      <div className="flex w-full justify-center gap-x-12 px-5 @[40rem]/reader:px-8">
        <article
          aria-label={`Pull request #${selection.number}`}
          className="min-w-0 max-w-[calc(68ch+2.125rem)] flex-1 pt-7 pb-24 text-[14px]"
        >
          {hasHeader ? <Masthead ref={mastheadRef} /> : <MastheadSkeleton />}
          {railDocked ? null : (
            <div className="mt-5 border-y border-border/60 py-4 empty:hidden">
              <FactsPanel layout="band" />
            </div>
          )}
          <DescriptionArea />
          <section aria-label="Timeline" className="mt-10 border-t border-border/60 pt-7">
            <PullRequestTimeline composerRef={composerRef} onQuote={quote} />
          </section>
        </article>
        {railDocked ? (
          // FactsPanel's own <aside> is the landmark; this only docks it.
          <div className="sticky top-0 max-h-[100cqh] w-[264px] shrink-0 self-start overflow-y-auto overscroll-contain py-7 [scrollbar-width:none]">
            <FactsPanel layout="rail" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function DescriptionArea() {
  const selection = usePullRequestSelection();
  if (selection.detail.data) {
    return (
      <div className="mt-7">
        <DescriptionBlock />
      </div>
    );
  }
  if (selection.detail.error) {
    return (
      <div className="mt-7">
        <TimelineNotice
          message="Couldn’t load this pull request."
          onRetry={() =>
            invalidateSourceControl({
              environmentId: selection.mutationTarget.environmentId,
              cwd: selection.mutationTarget.cwd,
            })
          }
        />
      </div>
    );
  }
  return <DescriptionSkeleton />;
}

/** Title (two lines at text-xl) and the meta line. */
function MastheadSkeleton() {
  return (
    <div aria-hidden className="min-w-0">
      <div className="flex h-[26px] items-center">
        <Skeleton className="h-[18px] w-[78%] rounded-md" />
      </div>
      <div className="flex h-[26px] items-center">
        <Skeleton className="h-[18px] w-[46%] rounded-md" />
      </div>
      <div className="mt-2 flex h-5 items-center gap-3">
        <Skeleton className="h-3 w-14 rounded-full" />
        <Skeleton className="h-3 w-8 rounded-full" />
        <Skeleton className="h-3 w-36 rounded-full" />
        <Skeleton className="h-3 w-44 rounded-full" />
      </div>
    </div>
  );
}

/** Paragraph lines at 14px/1.6 with one paragraph break. */
function DescriptionSkeleton() {
  const lines = [0.96, 0.88, 0.6, 0, 0.92, 0.7];
  return (
    <div aria-hidden className="mt-7 max-w-[68ch]">
      {lines.map((width, index) =>
        width === 0 ? (
          // oxlint-disable-next-line react/no-array-index-key -- static placeholder rows
          <div key={index} className="h-3" />
        ) : (
          // oxlint-disable-next-line react/no-array-index-key -- static placeholder rows
          <div key={index} className="flex h-[22.4px] items-center">
            <Skeleton className="h-3 rounded-full" style={{ width: `${width * 100}%` }} />
          </div>
        ),
      )}
    </div>
  );
}

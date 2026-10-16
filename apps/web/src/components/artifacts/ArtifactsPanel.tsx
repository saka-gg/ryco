import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  deriveThreadArtifacts,
  type ThreadFileArtifact,
  type ThreadPageArtifact,
} from "@ryco/client-runtime/state/session";
import { selectThreadDetailLoaded } from "@ryco/client-runtime/state/threads";
import type { ChatAttachmentHandoff, EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import { htmlRenderThumbnail } from "@ryco/shared/htmlRender";
import type { ThemeAppearance } from "@ryco/shared/themePalettes";
import { AppWindowIcon, LocateFixedIcon, ShapesIcon } from "lucide-react";
import { memo, useMemo, useState, type ReactNode } from "react";

import { useTheme } from "../../hooks/useTheme";
import { useLazyComponentReady } from "../../lib/preloadableLazy";
import { useStore } from "../../store";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import type { ChatMessage } from "../../types";
import { LazyExpandedImageDialog } from "../chat/chatViewLazySurfaces";
import type { ExpandedImagePreview } from "../chat/ExpandedImagePreview";
import { MessageAttachments } from "../chat/MessageAttachments";
import { useThreadTitle } from "../chat/ThreadMentionChip";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  useEarlierThreadArtifacts,
  type EarlierThreadArtifacts,
} from "./useEarlierThreadArtifacts";

const SECTION_LABEL_CLASS =
  "flex h-7 items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground";

function ShowInThreadButton(props: {
  readonly label: string;
  readonly onClick: () => void;
  readonly className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={`Show ${props.label} in thread`}
            size="icon-xs"
            variant="ghost"
            className={props.className}
            onClick={props.onClick}
          />
        }
      >
        <LocateFixedIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="left">Show in thread</TooltipPopup>
    </Tooltip>
  );
}

/** Where a handed-over artifact came from; opens that thread. */
function HandoffSource(props: {
  readonly environmentId: EnvironmentId;
  readonly handoff: ChatAttachmentHandoff;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const title = useThreadTitle(props.environmentId, props.handoff.threadId);
  return (
    <button
      type="button"
      data-artifact-handoff=""
      className="min-w-0 truncate text-start text-[11px] text-muted-foreground transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => props.onOpenThread(props.handoff.threadId)}
    >
      From {title ? `“${title}”` : "another thread"}
    </button>
  );
}

const ArtifactPageCard = memo(function ArtifactPageCard(props: {
  readonly artifact: ThreadPageArtifact;
  readonly environmentId: EnvironmentId;
  readonly appearance: ThemeAppearance;
  readonly onOpen: (artifact: ThreadPageArtifact) => void;
  readonly onShowInThread: (messageId: MessageId) => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { artifact } = props;
  const { title } = artifact.htmlRender;
  // Only data URLs the shared reader validated ever reach `src`.
  const thumbnail = htmlRenderThumbnail(artifact.htmlRender, props.appearance);
  return (
    <div className="group/artifact relative" data-artifact-page="">
      <button
        type="button"
        aria-label={`Open ${title}`}
        className="flex w-full min-w-0 flex-col overflow-hidden rounded-lg border border-border/60 bg-card/35 text-left transition-[background-color,border-color] duration-(--app-motion-duration-chip) ease-(--app-motion-ease) hover:border-border hover:bg-card/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => props.onOpen(artifact)}
      >
        {/* The stored thumbnail's proportions: the top of the page. */}
        <span className="flex aspect-[8/5] w-full items-center justify-center overflow-hidden border-b border-border/50 bg-background">
          {thumbnail ? (
            <img
              src={thumbnail}
              alt=""
              loading="lazy"
              decoding="async"
              draggable={false}
              className="size-full object-cover object-left-top"
            />
          ) : (
            <AppWindowIcon aria-hidden className="size-5 text-muted-foreground/55" />
          )}
        </span>
        <span className="block min-w-0 px-2.5 py-2">
          <span className="block truncate text-[13px] text-foreground">{title}</span>
          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
            Page · {formatRelativeTimeLabel(artifact.createdAt)}
          </span>
        </span>
      </button>
      <ShowInThreadButton
        label={title}
        onClick={() => props.onShowInThread(artifact.messageId)}
        // A plate of its own, so it reads over any thumbnail.
        className="absolute end-1.5 top-1.5 border-border bg-background/85 text-foreground/75 opacity-0 shadow-sm/10 backdrop-blur-sm transition-opacity hover:bg-background hover:text-foreground focus-visible:opacity-100 group-hover/artifact:opacity-100 pointer-coarse:opacity-100"
      />
      {artifact.handoff ? (
        <div className="flex min-w-0 px-1 pt-1">
          <HandoffSource
            environmentId={props.environmentId}
            handoff={artifact.handoff}
            onOpenThread={props.onOpenThread}
          />
        </div>
      ) : null}
    </div>
  );
});

const ArtifactFileCard = memo(function ArtifactFileCard(props: {
  readonly artifact: ThreadFileArtifact;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onImageExpand: (preview: ExpandedImagePreview) => void;
  readonly onShowInThread: (messageId: MessageId) => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { artifact } = props;
  const attachments = useMemo(() => [artifact.attachment], [artifact.attachment]);
  return (
    <div data-artifact-file="">
      {/* The file as the thread shows it: opened on request, then previewed. */}
      <MessageAttachments
        environmentId={props.environmentId}
        threadId={props.threadId}
        messageId={artifact.messageId}
        attachments={attachments}
        onImageExpand={props.onImageExpand}
        variant="assistant"
      />
      <div className="-mt-1 flex min-w-0 items-center justify-between gap-2 ps-1">
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="shrink-0">{formatRelativeTimeLabel(artifact.createdAt)}</span>
          {artifact.handoff ? (
            <>
              <span aria-hidden>·</span>
              <HandoffSource
                environmentId={props.environmentId}
                handoff={artifact.handoff}
                onOpenThread={props.onOpenThread}
              />
            </>
          ) : null}
        </span>
        <ShowInThreadButton
          label={artifact.attachment.name}
          onClick={() => props.onShowInThread(artifact.messageId)}
          className="text-muted-foreground"
        />
      </div>
    </div>
  );
});

function EarlierArtifacts(props: { readonly earlier: EarlierThreadArtifacts }) {
  const { earlier } = props;
  if (earlier.loading) {
    return (
      <p className="flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground">
        <Spinner className="size-3.5" />
        Looking further back…
      </p>
    );
  }
  if (earlier.failed) {
    return (
      <div role="status" className="flex flex-col items-center gap-2 py-2 text-center">
        <p className="text-xs text-muted-foreground">Unable to look further back in this thread.</p>
        <Button variant="outline" size="xs" onClick={earlier.loadMore}>
          Retry
        </Button>
      </div>
    );
  }
  if (!earlier.hasMore) return null;
  return (
    <div className="flex justify-center">
      <Button
        variant="ghost"
        size="xs"
        className="text-muted-foreground"
        onClick={earlier.loadMore}
      >
        Show earlier artifacts
      </Button>
    </div>
  );
}

function ArtifactsEmptyState(props: { readonly children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <ShapesIcon aria-hidden className="size-6 text-muted-foreground/60" />
      <p className="text-sm font-medium">No artifacts yet</p>
      <p className="max-w-60 text-xs text-muted-foreground">
        Pages and files the agent publishes in this thread, like interactive mockups, charts and
        exports, collect here.
      </p>
      {props.children}
    </div>
  );
}

/**
 * The workspace panel's artifacts tab: every page and file the agent
 * published into the thread, and the ones handed over to it from another
 * thread, newest first. A page opens full size in the page tab; a file opens
 * as the thread shows it. Either can be found in the thread.
 * Artifacts further back than the thread as loaded are read on their own.
 */
export function ArtifactsPanel(props: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  /** The thread's messages as loaded. */
  readonly messages: ReadonlyArray<ChatMessage> | undefined;
  readonly onOpenPage: (artifact: ThreadPageArtifact) => void;
  readonly onShowInThread: (messageId: MessageId) => void;
  /** Opens the thread a handed-over artifact came from. */
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { environmentId, threadId, onOpenPage, onShowInThread, onOpenThread } = props;
  const { resolvedTheme } = useTheme();
  const detailLoaded = useStore((state) =>
    environmentId && threadId
      ? selectThreadDetailLoaded(state, scopeThreadRef(environmentId, threadId))
      : false,
  );
  const history = useStore((state) =>
    environmentId && threadId
      ? state.environmentStateById[environmentId]?.threadHistoryByThreadId?.[threadId]?.messages
      : undefined,
  );
  const earlier = useEarlierThreadArtifacts({
    environmentId,
    threadId,
    startCursor: history?.hasMoreBefore ? history.oldestCursor : null,
    enabled: detailLoaded,
  });
  const { messages } = props;
  const artifacts = useMemo(
    () => deriveThreadArtifacts(messages ?? [], earlier.messages),
    [earlier.messages, messages],
  );
  const { pages, files } = useMemo(
    () => ({
      pages: artifacts.filter((artifact) => artifact.kind === "page"),
      files: artifacts.filter((artifact) => artifact.kind === "file"),
    }),
    [artifacts],
  );
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  const expandedImageReady = useLazyComponentReady(LazyExpandedImageDialog, expandedImage !== null);

  if (!environmentId || !threadId) return <ArtifactsEmptyState />;
  // The thread is still arriving: no verdict yet.
  if (!detailLoaded) return <div aria-busy className="min-h-0 flex-1" />;
  if (artifacts.length === 0) {
    return earlier.loading ? (
      <div aria-busy className="flex min-h-0 flex-1 items-center justify-center">
        <EarlierArtifacts earlier={earlier} />
      </div>
    ) : (
      <ArtifactsEmptyState>
        <EarlierArtifacts earlier={earlier} />
      </ArtifactsEmptyState>
    );
  }

  return (
    <div data-artifacts-panel="" className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-5 p-4">
          {pages.length > 0 ? (
            <section aria-labelledby="workspace-artifacts-pages">
              <h3 id="workspace-artifacts-pages" className={SECTION_LABEL_CLASS}>
                Pages
                <span className="tabular-nums text-muted-foreground/70">{pages.length}</span>
              </h3>
              <ul className="mt-1.5 grid grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))] gap-3">
                {pages.map((artifact) => (
                  <li key={artifact.key} className="min-w-0">
                    <ArtifactPageCard
                      artifact={artifact}
                      environmentId={environmentId}
                      appearance={resolvedTheme}
                      onOpen={onOpenPage}
                      onShowInThread={onShowInThread}
                      onOpenThread={onOpenThread}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {files.length > 0 ? (
            <section aria-labelledby="workspace-artifacts-files">
              <h3 id="workspace-artifacts-files" className={SECTION_LABEL_CLASS}>
                Files
                <span className="tabular-nums text-muted-foreground/70">{files.length}</span>
              </h3>
              <ul className="mt-1.5 flex flex-col gap-2">
                {files.map((artifact) => (
                  <li key={artifact.key} className="min-w-0">
                    <ArtifactFileCard
                      artifact={artifact}
                      environmentId={environmentId}
                      threadId={threadId}
                      onImageExpand={setExpandedImage}
                      onShowInThread={onShowInThread}
                      onOpenThread={onOpenThread}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <EarlierArtifacts earlier={earlier} />
        </div>
      </ScrollArea>
      {expandedImage && expandedImageReady ? (
        <LazyExpandedImageDialog preview={expandedImage} onClose={() => setExpandedImage(null)} />
      ) : null}
    </div>
  );
}

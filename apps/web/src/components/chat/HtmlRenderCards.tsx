import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import {
  HTML_RENDER_THUMBNAIL_MAX_HEIGHT,
  HTML_RENDER_THUMBNAIL_WIDTH,
  htmlRenderThumbnail,
} from "@ryco/shared/htmlRender";
import type { ThemeAppearance } from "@ryco/shared/themePalettes";
import { AppWindowIcon, ArrowUpRightIcon } from "lucide-react";
import { memo, useRef } from "react";

import { useHtmlRenderOpener, type HtmlRenderTarget } from "./HtmlRenderDialog";
import type { TimelineTurnHtmlRender } from "./MessagesTimeline.logic";

// The stored thumbnail's proportions (the top of the page), at card size.
const CARD_THUMBNAIL_WIDTH = 72;
const CARD_THUMBNAIL_HEIGHT = Math.round(
  (CARD_THUMBNAIL_WIDTH * HTML_RENDER_THUMBNAIL_MAX_HEIGHT) / HTML_RENDER_THUMBNAIL_WIDTH,
);

function HtmlRenderCard(props: {
  readonly target: HtmlRenderTarget;
  readonly appearance: ThemeAppearance;
  readonly onOpen: (target: HtmlRenderTarget, origin: () => HTMLElement | null) => void;
}) {
  const { target } = props;
  const { title } = target.htmlRender;
  // Only data URLs the shared reader validated ever reach `src`.
  const thumbnail = htmlRenderThumbnail(target.htmlRender, props.appearance);
  const cardRef = useRef<HTMLButtonElement>(null);
  return (
    <button
      ref={cardRef}
      type="button"
      aria-label={`Open ${title}`}
      data-html-render-card=""
      className="group/html-render-card flex w-full min-w-0 max-w-72 items-center gap-2.5 rounded-[0.65rem] border border-border/70 bg-muted/25 p-1.5 pe-3 text-left transition-[background-color,border-color] duration-(--app-motion-duration-chip) ease-(--app-motion-ease) hover:border-border hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      onClick={() => props.onOpen(target, () => cardRef.current)}
    >
      {/* A ring rather than a border, so the thumbnail fills its declared size. */}
      <span
        className="flex shrink-0 items-center justify-center overflow-hidden rounded-[0.45rem] bg-background ring-1 ring-border/50"
        style={{ width: CARD_THUMBNAIL_WIDTH, height: CARD_THUMBNAIL_HEIGHT }}
      >
        {thumbnail ? (
          // Anchored at the page's top left, where it starts: a page shorter
          // or wider than the card is cut on the right, never on the left.
          <img
            src={thumbnail}
            alt=""
            width={CARD_THUMBNAIL_WIDTH}
            height={CARD_THUMBNAIL_HEIGHT}
            loading="lazy"
            decoding="async"
            draggable={false}
            className="size-full object-cover object-left-top"
          />
        ) : (
          <AppWindowIcon aria-hidden className="size-4 text-muted-foreground/55" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] text-foreground/92">{title}</span>
        <span className="flex items-center gap-0.5 text-[12px] text-muted-foreground transition-colors duration-(--app-motion-duration-chip) ease-(--app-motion-ease) group-hover/html-render-card:text-foreground">
          Open
          <ArrowUpRightIcon aria-hidden className="size-3" />
        </span>
      </span>
    </button>
  );
}

/**
 * The pages a turn published, listed again at the end of its reply: a small
 * thumbnail in the reader's appearance, the title, and Open, which shows the
 * page full size (the workspace panel's page tab, else a dialog).
 */
export const HtmlRenderCards = memo(function HtmlRenderCards(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | undefined;
  readonly renders: ReadonlyArray<TimelineTurnHtmlRender>;
  readonly appearance: ThemeAppearance;
}) {
  const { open, dialog } = useHtmlRenderOpener();
  if (props.renders.length === 0) return null;
  return (
    <div data-html-render-cards="" className="mt-2 mb-1 flex flex-wrap gap-2">
      {props.renders.map((render) => (
        <HtmlRenderCard
          key={`${render.messageId}:${render.attachment.id}`}
          target={{
            environmentId: props.environmentId,
            threadId: props.threadId,
            messageId: render.messageId,
            attachment: render.attachment,
            htmlRender: render.htmlRender,
          }}
          appearance={props.appearance}
          onOpen={(target, origin) => open({ target, origin })}
        />
      ))}
      {dialog}
    </div>
  );
});

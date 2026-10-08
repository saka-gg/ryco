import type { ChatFileAttachment } from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import { htmlRenderFrameHeight, type HtmlRenderMetadata } from "@ryco/shared/htmlRender";
import { useEffect, useRef, useState } from "react";
import { Pressable, useWindowDimensions, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";

import { SymbolView } from "../../components/AppSymbol";
import { appMotion } from "../../lib/motion";
import { useThemeColor } from "../../lib/useThemeColor";
import { useHtmlRenderFullScreen } from "./HtmlRenderFullScreen";
import {
  HtmlRenderLoadingIndicator,
  HtmlRenderPagePlaceholder,
  HtmlRenderWebView,
} from "./HtmlRenderWebView";
import { useHtmlRenderSource } from "./useHtmlRenderSource";

/**
 * Horizontal space around an assistant message's content: `ThreadMessage`'s
 * `px-4` row and `px-1` column. Only the first width estimate uses it; the
 * frame measures its real width before the page loads.
 */
export const ASSISTANT_COLUMN_INSET = 40;

const MEGABYTE = 1024 * 1024;

/**
 * An agent HTML render in the thread: the page itself on the thread's own
 * background, in the reply column, with a button that opens it full screen.
 * Loading and failure hold the frame's box, so the reply below never jumps.
 */
export function ThreadHtmlRender(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly attachment: ChatFileAttachment;
  /**
   * The attachment's render metadata, validated once by the message that
   * carries it: a thumbnail can run to tens of kilobytes, and the row
   * re-renders with the feed.
   */
  readonly htmlRender: HtmlRenderMetadata;
}) {
  const render = props.htmlRender;
  const { title } = render;
  const { width: windowWidth } = useWindowDimensions();
  // The frame takes the page's measured height at its own width, so the row
  // reserves the right box before the page loads and nothing below it moves.
  const [width, setWidth] = useState(() => Math.max(1, windowWidth - ASSISTANT_COLUMN_INSET));
  // Phone fonts can wrap a page taller than the server measured it, so the
  // page's own report wins once it arrives.
  const [contentHeight, setContentHeight] = useState<number>();
  const frameHeight = htmlRenderFrameHeight(render, width, contentHeight);
  const source = useHtmlRenderSource({
    environmentId: props.environmentId,
    threadId: props.threadId,
    messageId: props.messageId,
    attachmentId: props.attachment.id,
    sizeBytes: props.attachment.sizeBytes,
  });
  const [pageFailed, setPageFailed] = useState(false);
  const [pageAttempt, setPageAttempt] = useState(0);
  const fullScreen = useHtmlRenderFullScreen();
  const iconColor = useThemeColor("--color-icon");

  // The first size report snaps the frame to the page; later changes (the
  // page resizing itself, rotation) ease to the new height.
  const height = useSharedValue(frameHeight);
  const sizedToPage = useRef(false);
  useEffect(() => {
    height.set(sizedToPage.current ? withTiming(frameHeight, appMotion.resize) : frameHeight);
    if (contentHeight !== undefined) sizedToPage.current = true;
  }, [contentHeight, frameHeight, height]);
  const frameStyle = useAnimatedStyle(() => ({ height: height.get() }));

  return (
    <View
      className="w-full"
      onLayout={(event) => {
        const measured = Math.round(event.nativeEvent.layout.width);
        if (measured > 0) setWidth(measured);
      }}
    >
      <Animated.View style={[{ width: "100%", overflow: "hidden" }, frameStyle]}>
        {source.status === "ready" ? (
          pageFailed ? (
            <HtmlRenderPagePlaceholder
              accessibilityLabel={`Reload ${title}`}
              label="Page unavailable"
              detail="Tap to retry"
              onPress={() => {
                setPageFailed(false);
                setPageAttempt((value) => value + 1);
              }}
            />
          ) : (
            <HtmlRenderWebView
              key={pageAttempt}
              html={source.html}
              title={title}
              variant="inline"
              scrollable={contentHeight !== undefined && contentHeight > frameHeight + 1}
              onContentHeight={setContentHeight}
              onFailure={() => setPageFailed(true)}
            />
          )
        ) : source.status === "failed" ? (
          <HtmlRenderPagePlaceholder
            accessibilityLabel={`Reload ${title}`}
            label="Page unavailable"
            detail="Tap to retry"
            onPress={source.retry}
          />
        ) : source.status === "idle" ? (
          <HtmlRenderPagePlaceholder
            accessibilityLabel={`Load ${title}`}
            label={title}
            detail={`Tap to load ${(props.attachment.sizeBytes / MEGABYTE).toFixed(1)} MB`}
            onPress={source.load}
          />
        ) : (
          <HtmlRenderLoadingIndicator title={title} />
        )}
        {source.status === "ready" && !pageFailed ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open ${title} full size`}
            hitSlop={8}
            onPress={() =>
              fullScreen.open({
                environmentId: props.environmentId,
                threadId: props.threadId,
                messageId: props.messageId,
                attachment: props.attachment,
                title,
                // The page is in hand, so full screen shows it without reading it again.
                html: source.html,
              })
            }
            className="absolute right-1.5 top-1.5 h-7 w-7 items-center justify-center rounded-full border border-border bg-card-translucent active:opacity-70"
          >
            <SymbolView
              name="arrow.up.left.and.arrow.down.right"
              size={12}
              tintColor={iconColor}
              type="monochrome"
            />
          </Pressable>
        ) : null}
      </Animated.View>
      {fullScreen.modal}
    </View>
  );
}

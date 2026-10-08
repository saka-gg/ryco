import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { defaultHtmlRenderTheme, htmlRenderThumbnail } from "@ryco/shared/htmlRender";
import type { ThemeAppearance } from "@ryco/shared/themePalettes";
import { Image } from "expo-image";
import { Pressable, useColorScheme, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { useThemeColor } from "../../lib/useThemeColor";
import { useHtmlRenderFullScreen } from "./HtmlRenderFullScreen";
import type { TurnHtmlRender } from "./threadActivityFold";

/**
 * The thumbnail's box, in points: the 240 × 150 ratio of the tallest
 * thumbnail the server captures. A shorter page's thumbnail is as wide and
 * less tall.
 */
export const HTML_RENDER_CARD_THUMBNAIL = { width: 72, height: 45 } as const;

/**
 * The page background thumbnails are captured on (Ryco's default theme), per
 * appearance: it continues below a short page's thumbnail, so the box reads as
 * the page's top, scaled down.
 */
export const HTML_RENDER_CARD_THUMBNAIL_BACKGROUND: Readonly<Record<ThemeAppearance, string>> = {
  dark: defaultHtmlRenderTheme("dark").variables["--background"],
  light: defaultHtmlRenderTheme("light").variables["--background"],
};

function HtmlRenderCard(props: {
  readonly title: string;
  readonly appearance: ThemeAppearance;
  /** A validated `data:image/...` URL, or undefined for the placeholder. */
  readonly thumbnail: string | undefined;
  readonly onOpen: () => void;
}) {
  const iconColor = useThemeColor("--color-icon-muted");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${props.title}`}
      onPress={props.onOpen}
      className="flex-row items-center gap-3 rounded-2xl border border-border bg-card-translucent p-2 pr-3 active:opacity-70"
    >
      <View
        style={[
          HTML_RENDER_CARD_THUMBNAIL,
          props.thumbnail === undefined
            ? null
            : { backgroundColor: HTML_RENDER_CARD_THUMBNAIL_BACKGROUND[props.appearance] },
        ]}
        className={`items-center justify-center overflow-hidden rounded-lg border border-border-subtle ${
          props.thumbnail === undefined ? "bg-subtle" : ""
        }`}
      >
        {props.thumbnail === undefined ? (
          <SymbolView name="macwindow" size={18} tintColor={iconColor} type="monochrome" />
        ) : (
          <Image
            source={{ uri: props.thumbnail }}
            style={HTML_RENDER_CARD_THUMBNAIL}
            // The page's top as the reader first sees it, whole: a wide or
            // short page is scaled to the box's width from its top-left
            // corner, never cropped at the sides or blown up.
            contentFit="contain"
            contentPosition="top left"
            // Node-owned pixels stay in memory; nothing reaches the disk cache.
            cachePolicy="none"
            accessible={false}
          />
        )}
      </View>
      <Text numberOfLines={1} className="min-w-0 flex-1 font-ryco-medium text-sm text-foreground">
        {props.title}
      </Text>
      <Text className="font-ryco-bold text-xs text-foreground-muted">Open</Text>
    </Pressable>
  );
}

/**
 * The pages a turn published, listed at the foot of its reply: a reader who
 * has scrolled past them, or past a long answer, opens one full screen from
 * here. The pages themselves stay inline above the reply.
 */
export function HtmlRenderCards(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly renders: ReadonlyArray<TurnHtmlRender>;
}) {
  const appearance = useColorScheme() === "light" ? "light" : "dark";
  const fullScreen = useHtmlRenderFullScreen();
  return (
    <View className="mt-3 w-full gap-2">
      {props.renders.map(({ attachment, htmlRender, messageId }) => (
        <HtmlRenderCard
          key={`${messageId}:${attachment.id}`}
          title={htmlRender.title}
          appearance={appearance}
          thumbnail={htmlRenderThumbnail(htmlRender, appearance)}
          onOpen={() =>
            fullScreen.open({
              environmentId: props.environmentId,
              threadId: props.threadId,
              messageId,
              attachment,
              title: htmlRender.title,
            })
          }
        />
      ))}
      {fullScreen.modal}
    </View>
  );
}

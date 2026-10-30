import { useFontFamily } from "../lib/useFontFamily";
import { resolveNativeMarkdownTypography } from "../lib/appearancePreferences";
import { useThemeColor } from "../lib/useThemeColor";
import { useScaledTextRole } from "../features/settings/appearance/useScaledTextRole";
import type { NativeMarkdownTextStyle } from "./SelectableMarkdownText";

/**
 * The native Markdown text style for body copy (messages, file previews, pull
 * request descriptions and comments): the theme's Markdown colours and the
 * reader's scaled body size.
 */
export function useNativeMarkdownTextStyle(): NativeMarkdownTextStyle {
  const bodyText = useScaledTextRole("body");
  const typography = resolveNativeMarkdownTypography(bodyText.fontSize);
  const regularFont = useFontFamily("regular");
  const boldFont = useFontFamily("bold");
  const bodyColor = useThemeColor("--color-md-body");
  const strongColor = useThemeColor("--color-md-strong");
  const mutedColor = useThemeColor("--color-foreground-muted");
  const linkColor = useThemeColor("--color-md-link");
  const codeColor = useThemeColor("--color-md-code-text");
  const codeBackground = useThemeColor("--color-md-code-bg");
  const codeBlockBackground = useThemeColor("--color-card-alt");
  const skillTextColor = useThemeColor("--color-inline-skill-foreground");
  const quoteMarkerColor = useThemeColor("--color-md-blockquote-border");
  const dividerColor = useThemeColor("--color-md-hr");
  return {
    color: String(bodyColor),
    strongColor: String(strongColor),
    mutedColor: String(mutedColor),
    linkColor: String(linkColor),
    inlineCodeColor: String(codeColor),
    codeColor: String(codeColor),
    codeBackgroundColor: String(codeBackground),
    codeBlockBackgroundColor: String(codeBlockBackground),
    fileTextColor: String(linkColor),
    skillTextColor: String(skillTextColor),
    quoteMarkerColor: String(quoteMarkerColor),
    dividerColor: String(dividerColor),
    fontSize: typography.fontSize,
    lineHeight: typography.lineHeight,
    fontFamily: regularFont,
    headingFontFamily: boldFont,
    boldFontFamily: boldFont,
    headingFontSizes: typography.headingFontSizes,
  };
}

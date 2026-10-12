import {
  SelectableMarkdownText as NativeSelectableMarkdownText,
  type SelectableMarkdownTextProps,
} from "@ryco/mobile-markdown-text/renderer";

import type { highlightCodeSnippet as HighlightCodeSnippet } from "../features/review/shikiReviewHighlighter";

type MobileSelectableMarkdownTextProps = Omit<SelectableMarkdownTextProps, "highlightCode">;

// Thread messages render through this module, so a static import would put
// shiki (core, engines, grammars, themes) on the launch path for every user.
// Code blocks highlight asynchronously anyway; the highlighter module loads on
// the first one (or earlier, from the idle prewarm after Home paints).
const highlightCodeSnippet: typeof HighlightCodeSnippet = async (input) =>
  (await import("../features/review/shikiReviewHighlighter")).highlightCodeSnippet(input);

export type {
  NativeMarkdownTextStyle,
  SelectableMarkdownSkill,
} from "@ryco/mobile-markdown-text/types";

export function hasNativeSelectableMarkdownText(): boolean {
  return true;
}

export function SelectableMarkdownText(props: MobileSelectableMarkdownTextProps) {
  return <NativeSelectableMarkdownText {...props} highlightCode={highlightCodeSnippet} />;
}

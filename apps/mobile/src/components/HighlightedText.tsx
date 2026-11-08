import { AppText as Text } from "./AppText";
import { splitSnippet } from "../features/inbox/inboxMessageSearchModel";

/**
 * Text with every word of a search query in bold, as a search result or a
 * message match shows it. Both class names carry the size and colour, so a
 * caller can use it at any text style.
 */
export function HighlightedText(props: {
  readonly text: string;
  readonly query: string;
  readonly className: string;
  readonly highlightClassName: string;
  readonly numberOfLines?: number;
}) {
  return (
    <Text className={props.className} numberOfLines={props.numberOfLines}>
      {splitSnippet(props.text, props.query).map((part) => (
        <Text
          key={part.start}
          className={part.highlighted ? props.highlightClassName : props.className}
        >
          {part.text}
        </Text>
      ))}
    </Text>
  );
}

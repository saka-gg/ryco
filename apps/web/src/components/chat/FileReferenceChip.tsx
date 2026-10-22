import {
  type FileReference,
  formatFileReferenceLabel,
  formatFileReferenceTitle,
} from "@ryco/client-runtime/state/composer";
import { XIcon } from "lucide-react";

import {
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
} from "../composerInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { VscodeEntryIcon } from "./VscodeEntryIcon";

/** Excerpt lines a chip's tooltip shows; the agent receives the whole bounded excerpt. */
const TOOLTIP_EXCERPT_LINES = 8;

function excerptPreview(reference: FileReference): string[] {
  const lines = reference.snippet.length > 0 ? reference.snippet.split("\n") : [];
  const shown = lines
    .slice(0, TOOLTIP_EXCERPT_LINES)
    .map((line, index) => `${reference.lineStart + index} | ${line}`);
  if (lines.length > TOOLTIP_EXCERPT_LINES || reference.truncated) shown.push("…");
  return shown;
}

/**
 * Lines of a workspace file handed to the agent ("app.ts:12-18"), in the
 * composer while they wait to be sent (with `onRemove`) and on the sent
 * message. The tooltip names the file and shows the note and the excerpt.
 */
export function FileReferenceChip(props: {
  readonly reference: FileReference;
  readonly theme: "light" | "dark";
  readonly onRemove?: (() => void) | undefined;
}) {
  const { reference, onRemove } = props;
  const title = formatFileReferenceTitle(reference);
  const excerpt = excerptPreview(reference);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={COMPOSER_INLINE_CHIP_CLASS_NAME}
            data-file-reference-chip={reference.path}
          >
            <VscodeEntryIcon
              className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME}
              kind="file"
              pathValue={reference.path}
              theme={props.theme}
            />
            <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>
              {formatFileReferenceLabel(reference)}
            </span>
            {onRemove ? (
              <button
                type="button"
                aria-label={`Remove ${formatFileReferenceLabel(reference)}`}
                className={COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME}
                onClick={onRemove}
              >
                <XIcon className="size-3" aria-hidden="true" />
              </button>
            ) : null}
          </span>
        }
      />
      <TooltipPopup side="top" className="max-w-96 leading-tight">
        <div className="wrap-anywhere font-medium">{title}</div>
        {reference.comment ? (
          <div className="mt-1 whitespace-pre-wrap wrap-anywhere">{reference.comment}</div>
        ) : null}
        {excerpt.length > 0 ? (
          <pre className="mt-1.5 overflow-hidden font-mono text-[11px] whitespace-pre text-muted-foreground">
            {excerpt.join("\n")}
          </pre>
        ) : null}
      </TooltipPopup>
    </Tooltip>
  );
}

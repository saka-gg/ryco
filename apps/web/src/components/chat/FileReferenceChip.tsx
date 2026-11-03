import {
  type BrowserElementReference,
  type ComposerReference,
  type FileReference,
  formatBrowserElementBox,
  formatBrowserElementLabel,
  formatBrowserElementTitle,
  formatFileReferenceLabel,
  formatFileReferencePreview,
  formatFileReferenceTitle,
  isBrowserElementReference,
} from "@ryco/client-runtime/state/composer";
import { GlobeIcon, XIcon } from "lucide-react";

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
  const excerpt = formatFileReferencePreview(reference, TOOLTIP_EXCERPT_LINES);
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

/**
 * A page element picked in the project browser (`button "Save changes"`), in
 * the composer while it waits to be sent (with `onRemove`) and on the sent
 * message. The tooltip names the element and its page and shows the note, then
 * the selector, role, page title and box the agent receives.
 */
export function BrowserElementChip(props: {
  readonly element: BrowserElementReference;
  readonly onRemove?: (() => void) | undefined;
}) {
  const { element, onRemove } = props;
  const label = formatBrowserElementLabel(element);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className={COMPOSER_INLINE_CHIP_CLASS_NAME} data-browser-element-chip={label}>
            <GlobeIcon className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME} aria-hidden="true" />
            <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{label}</span>
            {onRemove ? (
              <button
                type="button"
                aria-label={`Remove ${label}`}
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
        <div className="wrap-anywhere font-medium">{formatBrowserElementTitle(element)}</div>
        {element.comment ? (
          <div className="mt-1 whitespace-pre-wrap wrap-anywhere">{element.comment}</div>
        ) : null}
        <div className="mt-1.5 font-mono text-[11px] wrap-anywhere text-muted-foreground">
          <div>{element.selector}</div>
          {element.role ? <div>role: {element.role}</div> : null}
          {element.pageTitle ? <div>page: {element.pageTitle}</div> : null}
          {element.box ? <div>box: {formatBrowserElementBox(element.box)}</div> : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

/** A composer reference chip of either kind: file lines or a picked page element. */
export function ComposerReferenceChip(props: {
  readonly reference: ComposerReference;
  readonly theme: "light" | "dark";
  readonly onRemove?: (() => void) | undefined;
}) {
  return isBrowserElementReference(props.reference) ? (
    <BrowserElementChip element={props.reference} onRemove={props.onRemove} />
  ) : (
    <FileReferenceChip reference={props.reference} theme={props.theme} onRemove={props.onRemove} />
  );
}

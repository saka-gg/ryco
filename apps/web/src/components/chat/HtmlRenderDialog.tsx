import type { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import type { HtmlRenderMetadata } from "@ryco/shared/htmlRender";
import { createContext, use, useCallback, useState, type ReactNode } from "react";

import { preloadableLazy, useLazyComponentReady } from "../../lib/preloadableLazy";
import type { ChatFileAttachment } from "../../types";
import { Dialog } from "../ui/dialog";

/** An HTML render of a thread: the stored page and what it is called. */
export interface HtmlRenderTarget {
  readonly environmentId: EnvironmentId | undefined;
  readonly threadId: ThreadId | undefined;
  readonly messageId: MessageId | undefined;
  readonly attachment: ChatFileAttachment;
  readonly htmlRender: HtmlRenderMetadata;
  /** The page may send the reader's answers to its thread (see `HtmlRenderFrame`). */
  readonly canSendMessages?: boolean | undefined;
}

/** A render to show full size, and the element its dialog grows out of. */
export interface HtmlRenderOpenRequest {
  readonly target: HtmlRenderTarget;
  readonly origin?: (() => HTMLElement | null) | undefined;
}

type OpenHtmlRender = (request: HtmlRenderOpenRequest) => void;

const HtmlRenderOpenerContext = createContext<OpenHtmlRender | null>(null);

const LazyHtmlRenderDialogPopup = preloadableLazy(() =>
  import("./HtmlRenderDialogPopup").then((module) => module.HtmlRenderDialogPopup),
);

/** Loads the dialog's body ahead of a click: the reader is about to open a page full size. */
export function preloadHtmlRenderDialog(): void {
  void LazyHtmlRenderDialogPopup.preload();
}

/** An HTML render at full size, with its source and a download. */
export function HtmlRenderDialog(props: {
  readonly request: HtmlRenderOpenRequest | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onClosed?: () => void;
}) {
  const { request } = props;
  // The body is its own chunk; the dialog opens once it is in (at once after the first).
  const ready = useLazyComponentReady(LazyHtmlRenderDialogPopup, props.open && request !== null);
  return (
    <Dialog
      open={props.open && request !== null}
      onOpenChange={props.onOpenChange}
      onOpenChangeComplete={(open) => {
        if (!open) props.onClosed?.();
      }}
    >
      {request && ready && (
        <LazyHtmlRenderDialogPopup
          // Another page starts over: its own source toggle, its own frame.
          key={`${request.target.messageId}:${request.target.attachment.id}`}
          request={request}
          onClose={() => props.onOpenChange(false)}
        />
      )}
    </Dialog>
  );
}

interface HtmlRenderOpener {
  readonly open: OpenHtmlRender;
  /** The fallback dialog; render it wherever its owner lives. */
  readonly dialog: ReactNode;
}

function useOwnHtmlRenderDialog(): HtmlRenderOpener {
  const [state, setState] = useState<{
    readonly request: HtmlRenderOpenRequest | null;
    readonly open: boolean;
  }>({ request: null, open: false });
  const open = useCallback<OpenHtmlRender>((request) => setState({ request, open: true }), []);
  return {
    open,
    dialog: (
      <HtmlRenderDialog
        request={state.request}
        open={state.open}
        onOpenChange={(next) => setState((current) => ({ ...current, open: next }))}
        onClosed={() => setState({ request: null, open: false })}
      />
    ),
  };
}

/**
 * Decides where every render beneath it opens full size: the workspace
 * panel's page tab when the thread view has one, else a dialog owned here,
 * so the view outlives the row that opened it (a virtualized row can unmount
 * while the dialog is open and the thread keeps streaming).
 */
export function HtmlRenderOpenerProvider(props: {
  /** Opens a render in the workspace panel; absent where there is no panel. */
  readonly onOpenInPanel?: ((messageId: MessageId, attachmentId: string) => void) | undefined;
  readonly children: ReactNode;
}) {
  const { onOpenInPanel } = props;
  const { open: openDialog, dialog } = useOwnHtmlRenderDialog();
  const open = useCallback<OpenHtmlRender>(
    (request) => {
      const { messageId, attachment } = request.target;
      if (onOpenInPanel && messageId) onOpenInPanel(messageId, attachment.id);
      else openDialog(request);
    },
    [onOpenInPanel, openDialog],
  );
  return (
    <HtmlRenderOpenerContext value={open}>
      {props.children}
      {dialog}
    </HtmlRenderOpenerContext>
  );
}

/**
 * Opens a render full size through the nearest provider, or through a dialog
 * of the caller's own (returned as `dialog`) when it renders outside one.
 */
export function useHtmlRenderOpener(): HtmlRenderOpener {
  const provided = use(HtmlRenderOpenerContext);
  const own = useOwnHtmlRenderDialog();
  return provided === null ? own : { open: provided, dialog: null };
}

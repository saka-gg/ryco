import type { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import type { HtmlRenderMetadata } from "@ryco/shared/htmlRender";
import { createContext, use, useCallback, useState, type ReactNode } from "react";

import type { ChatFileAttachment } from "../../types";
import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { HtmlRenderFullView, HtmlRenderViewActions } from "./HtmlRenderView";
import { useHtmlRenderSource } from "./useHtmlRenderSource";

/** An HTML render of a thread: the stored page and what it is called. */
export interface HtmlRenderTarget {
  readonly environmentId: EnvironmentId | undefined;
  readonly threadId: ThreadId | undefined;
  readonly messageId: MessageId | undefined;
  readonly attachment: ChatFileAttachment;
  readonly htmlRender: HtmlRenderMetadata;
}

/** A render to show full size, and the element its dialog grows out of. */
export interface HtmlRenderOpenRequest {
  readonly target: HtmlRenderTarget;
  readonly origin?: (() => HTMLElement | null) | undefined;
}

type OpenHtmlRender = (request: HtmlRenderOpenRequest) => void;

const HtmlRenderOpenerContext = createContext<OpenHtmlRender | null>(null);

function HtmlRenderDialogPopup(props: {
  readonly request: HtmlRenderOpenRequest;
  readonly onClose: () => void;
}) {
  const { target, origin } = props.request;
  const { title } = target.htmlRender;
  // A page already shown inline comes from memory.
  const source = useHtmlRenderSource(target);
  const [showSource, setShowSource] = useState(false);
  return (
    <DialogPopup
      className="h-[85dvh] max-w-5xl overflow-hidden"
      bottomStickOnMobile={false}
      morph={origin ? { origin } : "auto"}
    >
      <DialogHeader className="shrink-0 flex-row items-center gap-2 border-b py-3 pr-14 pl-5 max-sm:pb-3">
        <DialogTitle className="min-w-0 flex-1 truncate text-base" title={title}>
          {title}
        </DialogTitle>
        <DialogDescription className="sr-only">
          A page the agent published, running in a sandbox.
        </DialogDescription>
        <HtmlRenderViewActions
          html={source.html}
          title={title}
          showSource={showSource}
          onShowSourceChange={setShowSource}
        />
      </DialogHeader>
      {/* A gutter, so the page's content never meets the dialog's edge. */}
      <HtmlRenderFullView
        source={source}
        title={title}
        sizeBytes={target.attachment.sizeBytes}
        showSource={showSource}
        onEscape={props.onClose}
        className="rounded-b-[calc(min(var(--radius-2xl),1.25rem)-1px)] px-4 pt-4 sm:px-6"
      />
    </DialogPopup>
  );
}

/** An HTML render at full size, with its source and a download. */
export function HtmlRenderDialog(props: {
  readonly request: HtmlRenderOpenRequest | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onClosed?: () => void;
}) {
  const { request } = props;
  return (
    <Dialog
      open={props.open && request !== null}
      onOpenChange={props.onOpenChange}
      onOpenChangeComplete={(open) => {
        if (!open) props.onClosed?.();
      }}
    >
      {request && (
        <HtmlRenderDialogPopup
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

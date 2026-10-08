import type { HtmlRenderAttachment } from "@ryco/client-runtime/state/session";
import type { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import { AppWindowIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { parseWorkspaceRenderKey } from "../../workspaceRouteSearch";
import { Button } from "../ui/button";
import { HtmlRenderFullView, HtmlRenderViewActions } from "./HtmlRenderView";
import { useHtmlRenderSource } from "./useHtmlRenderSource";
import type { WorkspaceHtmlRender } from "./useWorkspaceHtmlRender";

function HtmlRenderPanelPage(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly render: HtmlRenderAttachment;
}) {
  const { attachment, htmlRender } = props.render;
  const { title } = htmlRender;
  // A page already shown inline comes from memory.
  const source = useHtmlRenderSource({
    environmentId: props.environmentId,
    threadId: props.threadId,
    messageId: props.messageId,
    attachment,
  });
  const [showSource, setShowSource] = useState(false);
  return (
    <div data-html-render-panel="" className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 py-2 ps-4 pe-3">
        {/* The tab already names the page; the heading is for assistive tech. */}
        <h2 className="sr-only">{title}</h2>
        <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">Agent page</span>
        <HtmlRenderViewActions
          html={source.html}
          title={title}
          showSource={showSource}
          onShowSourceChange={setShowSource}
        />
      </div>
      {/* Escape inside the page stays with the page: this is a tab, not a dialog. */}
      <HtmlRenderFullView
        source={source}
        title={title}
        sizeBytes={attachment.sizeBytes}
        showSource={showSource}
        className="px-4 pt-3"
      />
    </div>
  );
}

function HtmlRenderPanelNotice(props: {
  readonly title: string;
  readonly detail: string;
  readonly children?: ReactNode;
}) {
  return (
    <div role="status" className="flex min-h-0 flex-1 items-center justify-center p-6 text-center">
      <div className="max-w-72">
        <div className="mx-auto flex size-10 items-center justify-center rounded-md border border-border/70 bg-card/60 text-muted-foreground">
          <AppWindowIcon className="size-4" />
        </div>
        <p className="mt-3 text-sm font-medium text-foreground">{props.title}</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{props.detail}</p>
        {props.children}
      </div>
    </div>
  );
}

/**
 * The workspace panel's page tab: one of the thread's HTML renders at full
 * size beside the conversation. `useWorkspaceHtmlRender` resolves it; a page
 * whose message is gone (deleted, reverted away) says so quietly.
 */
export function HtmlRenderPanel(props: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly renderKey: string;
  readonly resolution: WorkspaceHtmlRender;
}) {
  const { environmentId, threadId, renderKey, resolution } = props;
  const messageId = parseWorkspaceRenderKey(renderKey)?.messageId;
  if (resolution.status === "found" && environmentId && threadId && messageId) {
    return (
      <HtmlRenderPanelPage
        // Another page is another document; never reuse the frame.
        key={renderKey}
        environmentId={environmentId}
        threadId={threadId}
        messageId={messageId}
        render={resolution.render}
      />
    );
  }
  if (resolution.status === "pending") return <div aria-busy className="min-h-0 flex-1" />;
  if (resolution.status === "failed") {
    return (
      <HtmlRenderPanelNotice
        title="Unable to find this page"
        detail="It is further back in the thread, and the lookup did not finish."
      >
        <Button variant="outline" size="xs" className="mt-3" onClick={resolution.retry}>
          Retry
        </Button>
      </HtmlRenderPanelNotice>
    );
  }
  return (
    <HtmlRenderPanelNotice
      title="This page is no longer available"
      detail="The message that carried it is no longer in this thread."
    />
  );
}

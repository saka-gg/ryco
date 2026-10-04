import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import type { SidebarThreadSummary } from "@ryco/client-runtime/state/threads";
import { useRouter } from "@tanstack/react-router";

import { cn } from "../../lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import { inboxGlyphLabel, resolveInboxGlyph } from "../inboxSidebar/inboxRowPresentation";
import { resolveInboxThreadStatus } from "../inboxSidebar/inboxSidebarModel";
import { InboxStatusGlyph } from "../inboxSidebar/InboxStatusGlyph";
import { RelativeTime } from "../pullRequests/primitives";
import { threadLinkActivityAt } from "./threadLinkActivity";

/**
 * Rows linking to other threads: status glyph, title and relative time; a click
 * opens the thread. Renders only the row buttons, so the caller owns the
 * container (Agents on the pull request rail, Delegated threads in a chat).
 */
export function ThreadLinkList(props: {
  readonly threads: ReadonlyArray<SidebarThreadSummary>;
  readonly tone: "rail" | "band";
}) {
  const router = useRouter({ warn: false });
  const open = (thread: SidebarThreadSummary) => {
    if (!router) return;
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
    });
  };
  return (
    <>
      {props.threads.map((thread) => {
        const status = resolveInboxThreadStatus(thread);
        const glyph = resolveInboxGlyph(status, false);
        return (
          <button
            key={thread.id}
            type="button"
            disabled={!router}
            onClick={() => open(thread)}
            className={cn(
              "group/agent flex h-7 min-w-0 items-center gap-2 rounded-md text-left outline-hidden transition-colors duration-(--app-motion-duration-chip) focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default",
              props.tone === "rail"
                ? "-mx-1.5 px-1.5 hover:bg-accent/50"
                : "-mx-1.5 px-1.5 hover:bg-accent/60",
            )}
          >
            <InboxStatusGlyph key={glyph} kind={glyph} label={inboxGlyphLabel(status, false)} />
            <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/90">
              {thread.title}
            </span>
            <RelativeTime
              value={threadLinkActivityAt(thread)}
              className="text-xs text-muted-foreground"
            />
          </button>
        );
      })}
    </>
  );
}

import { useMemo } from "react";
import { fullThreadEntry } from "../../../types";
import { useShallow } from "zustand/react/shallow";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";

import { selectSidebarThreadsAcrossEnvironments, useStore } from "../../../store";
import { HostedConnectionPill } from "../../hostedHub/HostedConnectionControls";
import { ThreadRowLeadingStatus } from "../../ThreadStatusIndicators";
import { Button } from "../../ui/button";

export interface PhoneThreadAppBarProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
}

/**
 * The compact phone app bar for the thread surface (L2 of the phone
 * navigation stack): back to Home, the title with always-visible status, and
 * the hosted connection indicator.
 *
 * That is the whole bar. The workspace toggle and the thread-actions kebab
 * used to sit in its top-right corner; both moved into `PhoneThreadDock` at
 * the bottom of the screen, together with find-in-thread, source control and
 * the session list, so no primary or frequent action is left out of thumb
 * reach. Back stays here deliberately — the design keeps back, title and the
 * connection indicator as top-anchored chrome on this surface.
 */
export function PhoneThreadAppBar(props: PhoneThreadAppBarProps) {
  const navigate = useNavigate();
  const summaries = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  // An archived stub has no status to show until its full summary loads.
  const summary = useMemo(
    () =>
      fullThreadEntry(
        summaries.find(
          (thread) => thread.id === props.threadId && thread.environmentId === props.environmentId,
        ),
      ) ?? null,
    [props.environmentId, props.threadId, summaries],
  );

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5 py-2">
      <Button
        size="icon"
        variant="ghost"
        aria-label="Back to threads"
        className="shrink-0"
        onClick={() => void navigate({ to: "/" })}
      >
        <ArrowLeftIcon />
      </Button>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{props.title}</p>
        {summary ? (
          <span className="flex items-center gap-1.5">
            <ThreadRowLeadingStatus thread={summary} alwaysShowStatusLabel />
          </span>
        ) : null}
      </div>
      <HostedConnectionPill />
    </div>
  );
}

import { cn } from "~/lib/utils";

import type { ThreadSubagentView } from "~/threadWorkspaceViewModel";
import { SubagentAvatar } from "../../../sidebar/SubagentAvatar";
import { subagentStatusLabel } from "../../overviewSections";
import { getOverviewSummary } from "../../overviewSummary.logic";
import {
  CrownDetailEmpty,
  CrownDetailHeading,
  type CrownDetailViewProps,
} from "./crownDetailPrimitives";

const STATUS_PILL_TONE: Record<ThreadSubagentView["status"], string> = {
  running: "text-[color:var(--crown-agent,#38bdf8)]",
  finished: "text-muted-foreground/60",
  failed: "text-destructive-foreground",
  interrupted: "text-muted-foreground/60",
  idle: "text-muted-foreground/60",
};

/** The status pill (`.as`); running agents get a pulsing dot in the agent colour. */
function SubagentStatusPill({ status }: { status: ThreadSubagentView["status"] }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-[5px] text-[10.5px] font-semibold",
        STATUS_PILL_TONE[status],
      )}
    >
      {status === "running" ? (
        <span
          aria-hidden="true"
          className="crown-agent-pulse size-1.5 rounded-full bg-[color:var(--crown-agent,#38bdf8)]"
        />
      ) : null}
      {subagentStatusLabel(status)}
    </span>
  );
}

function SubagentRow({
  subagent,
  onOpen,
}: {
  subagent: ThreadSubagentView;
  onOpen: ((subagent: ThreadSubagentView) => void) | undefined;
}) {
  const meta = [subagent.role, subagent.model ?? subagent.tool].filter(Boolean).join(" · ");
  return (
    <li>
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-1 py-[5px] text-left transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
        onClick={() => onOpen?.(subagent)}
        aria-label={`${subagent.name} — ${subagentStatusLabel(subagent.status)}`}
        title={subagent.detail ?? undefined}
        data-slot="crown-subagent-row"
      >
        <span className="grid size-[22px] shrink-0 place-items-center rounded-full bg-muted">
          <SubagentAvatar name={subagent.avatarKey ?? subagent.key} className="size-3.5" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate text-[12px] font-semibold">{subagent.name}</span>
          {meta ? <span className="truncate text-[11px] text-muted-foreground">{meta}</span> : null}
        </span>
        <SubagentStatusPill status={subagent.status} />
      </button>
    </li>
  );
}

export function AgentsDetail({ layout, variant }: CrownDetailViewProps) {
  const subagents = layout.subagents ?? [];
  const { agentsRunning } = getOverviewSummary(layout);
  return (
    <>
      <CrownDetailHeading
        section="agents"
        variant={variant}
        meta={subagents.length > 0 ? `${agentsRunning} live` : undefined}
      />
      {subagents.length > 0 ? (
        <ul className="flex flex-col gap-px">
          {subagents.map((subagent) => (
            <SubagentRow key={subagent.key} subagent={subagent} onOpen={layout.onOpenSubagent} />
          ))}
        </ul>
      ) : (
        <CrownDetailEmpty>No subagents in this thread</CrownDetailEmpty>
      )}
    </>
  );
}

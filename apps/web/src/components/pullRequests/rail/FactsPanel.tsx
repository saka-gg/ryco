import type { ReactNode } from "react";

import { cn } from "../../../lib/utils";
import { AgentsSection, useLinkedAgentThreads } from "./AgentsSection";
import { MergeSection } from "./MergeSection";
import { PeopleSection } from "./PeopleSection";
import { StackSection } from "./StackSection";

/**
 * The Conversation tab's facts: merge verdict and next action, the stack,
 * people and labels, and agent work. Each fact appears here once.
 *
 * - `rail` (reader ≥ 800): a 264px column that scrolls on its own. Sections
 *   are separated by hairlines and whitespace only; the caller places it
 *   beside the timeline (full height of the tab) and owns the gutter.
 * - `band` (narrower): an untinted band under the masthead — verdict and
 *   button on one line, status lines in a row, then one compact row with the
 *   stack, reviewers, assignees, labels and the latest agent thread. The
 *   caller supplies horizontal padding and any surrounding hairlines.
 */
export function FactsPanel(props: {
  readonly layout: "rail" | "band";
  readonly className?: string | undefined;
}) {
  const agents = useLinkedAgentThreads();

  if (props.layout === "band") {
    return (
      <div
        data-pr-facts="band"
        aria-label="Pull request facts"
        role="complementary"
        className={cn("flex min-w-0 flex-col gap-1.5", props.className)}
      >
        <MergeSection layout="band" />
        <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-0.5">
          <StackSection layout="band" />
          <PeopleSection layout="band" />
          <AgentsSection threads={agents} layout="band" />
        </div>
      </div>
    );
  }

  return (
    <aside
      data-pr-facts="rail"
      aria-label="Pull request facts"
      className={cn(
        "flex min-h-0 w-[264px] shrink-0 flex-col overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        "*:not-first:border-t *:not-first:border-border/60 *:py-4 *:first:pt-0",
        props.className,
      )}
    >
      <div>
        <MergeSection layout="rail" />
      </div>
      <RailSlot>
        <StackSection layout="rail" />
      </RailSlot>
      <div>
        <PeopleSection layout="rail" />
      </div>
      {agents.length > 0 ? (
        <div>
          <AgentsSection threads={agents} layout="rail" />
        </div>
      ) : null}
    </aside>
  );
}

/** A rail slot that disappears (with its hairline) when its section has nothing to say. */
function RailSlot(props: { readonly children: ReactNode }) {
  return <div className="empty:hidden">{props.children}</div>;
}

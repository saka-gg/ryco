import { LayersIcon } from "lucide-react";

import { cn } from "../../../lib/utils";
import { FACT_TONE_TEXT } from "./FactGlyph";
import type { StackFacts } from "./useStackFacts";

/** "Stack #14 · 3 of 4 · #701 can land" — the stack in one line. */
export function StackSummary(props: {
  readonly facts: StackFacts;
  readonly className?: string | undefined;
  /** Leave out "3 of 4" where the trigger right above already shows the position. */
  readonly withoutPosition?: boolean | undefined;
}) {
  const { facts } = props;
  const foot = facts.assessment.foot;
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", props.className)}>
      <LayersIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 truncate">
        <span className="text-foreground">Stack #{facts.stack.number}</span>
        {props.withoutPosition ? null : (
          <>
            <span className="text-muted-foreground"> · </span>
            <span className="text-muted-foreground tabular-nums">{facts.position}</span>
          </>
        )}
        {facts.incomplete ? (
          <span className="text-muted-foreground"> · Stack details unavailable</span>
        ) : foot ? (
          <>
            <span className="text-muted-foreground"> · </span>
            <span className={FACT_TONE_TEXT[foot.tone]}>{foot.text}</span>
          </>
        ) : null}
      </span>
    </span>
  );
}

import { LayersIcon } from "lucide-react";
import { useState } from "react";

import { KeyHint } from "../primitives";
import { usePullRequestsShortcut } from "../pullRequestsShortcuts";
import { StackPopover } from "./StackPopover";
import { useStackFacts } from "./useStackFacts";

/**
 * Stack position in the bar off Conversation ("≋ 3/4"), opening the stack
 * popover. `S` opens it too. Renders nothing for a pull request outside a stack.
 */
export function StackChip() {
  const facts = useStackFacts();
  const [open, setOpen] = useState(false);
  usePullRequestsShortcut(
    "s",
    () => {
      if (!facts) return false;
      setOpen((current) => !current);
    },
    { enabled: facts !== null },
  );
  if (!facts) return null;
  return (
    <StackPopover
      facts={facts}
      open={open}
      onOpenChange={setOpen}
      triggerShows="position"
      tooltip={
        <span className="inline-flex items-center gap-1.5">
          Stack #{facts.stack.number}
          <KeyHint>S</KeyHint>
        </span>
      }
      trigger={
        <button
          type="button"
          aria-label={`Stack #${facts.stack.number}, layer ${facts.position}`}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground tabular-nums outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent data-popup-open:text-foreground"
        >
          <LayersIcon className="size-3.5" aria-hidden />
          {facts.stack.position}/{facts.stack.size}
        </button>
      }
    />
  );
}

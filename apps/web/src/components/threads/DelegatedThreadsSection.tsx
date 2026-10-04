import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { selectDelegatedChildThreadsForThreadRef, useStore, type AppState } from "../../store";
import { Button } from "../ui/button";
import { ThreadLinkList } from "./ThreadLinkList";

/**
 * The threads this thread delegated (server lineage), direct children only,
 * oldest first. Row glyphs are the only child progress shown here; aggregate
 * child results stay in the Agent Control block. Collapsed by default.
 */
export function DelegatedThreadsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly parentThreadId: ThreadId | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const parentRef = useMemo(
    () =>
      props.parentThreadId === null
        ? null
        : scopeThreadRef(props.environmentId, props.parentThreadId),
    [props.environmentId, props.parentThreadId],
  );
  const children = useStore(
    useShallow(
      useMemo(
        () => (state: AppState) => selectDelegatedChildThreadsForThreadRef(state, parentRef),
        [parentRef],
      ),
    ),
  );
  if (children.length === 0) return null;
  const Chevron = expanded ? ChevronDownIcon : ChevronRightIcon;
  return (
    <div className="mx-auto mb-2 w-full min-w-0 max-w-208" data-testid="delegated-threads">
      <Button
        aria-expanded={expanded}
        className="h-auto w-full min-w-0 justify-start gap-2 py-1.5 text-xs text-muted-foreground"
        onClick={() => setExpanded((current) => !current)}
        size="xs"
        variant="ghost"
      >
        <Chevron aria-hidden className="size-3 shrink-0" />
        <span className="shrink-0">Delegated threads · {children.length}</span>
      </Button>
      {expanded ? (
        <div
          className="flex max-h-[min(18rem,35dvh)] min-w-0 flex-col overflow-y-auto overscroll-contain px-2"
          data-testid="delegated-threads-list"
        >
          <ThreadLinkList threads={children} tone="rail" />
        </div>
      ) : null}
    </div>
  );
}

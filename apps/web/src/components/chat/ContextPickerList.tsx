import type { SourceControlIssueSummary } from "@ryco/contracts";
import { DateTime, Option } from "effect";
import { memo } from "react";
import { cn } from "~/lib/utils";

/** An issue or change request row: what the list shows of either. */
type Item = Pick<SourceControlIssueSummary, "provider" | "number" | "title" | "updatedAt">;

const dateFmt = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "numeric",
  day: "numeric",
});

function formatItemDate(updatedAt: SourceControlIssueSummary["updatedAt"]): string {
  if (!updatedAt || Option.isNone(updatedAt)) return "";
  return dateFmt.format(DateTime.toDate(updatedAt.value));
}

function ContextPickerListImpl<T extends Item>(props: {
  items: ReadonlyArray<T>;
  isLoading: boolean;
  emptyText: string;
  onSelect: (item: T) => void;
}) {
  if (props.isLoading && props.items.length === 0) {
    return <div className="px-3 py-4 text-xs text-muted-foreground">Loading…</div>;
  }
  if (props.items.length === 0) {
    return <div className="px-3 py-4 text-xs text-muted-foreground">{props.emptyText}</div>;
  }
  return (
    <ul className="max-h-72 overflow-y-auto" role="listbox">
      {props.items.map((item) => (
        <li key={`${item.provider}:${item.number}`}>
          <button
            type="button"
            onClick={() => props.onSelect(item)}
            className={cn(
              "flex w-full items-center gap-2 px-3 py-2 text-left text-sm",
              "hover:bg-accent",
            )}
          >
            <span className="shrink-0 text-muted-foreground">#{item.number}</span>
            <span className="min-w-0 flex-1 truncate">{item.title}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {formatItemDate(item.updatedAt)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export const ContextPickerList = memo(ContextPickerListImpl) as typeof ContextPickerListImpl;

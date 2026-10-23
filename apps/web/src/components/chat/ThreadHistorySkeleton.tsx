import { Skeleton } from "../ui/skeleton";

/**
 * Stands in for the transcript of an existing thread while its history window
 * is on its way, so the thread never presents as a new one (hero, work
 * location and their branch reads) in the meantime.
 */
export function ThreadHistorySkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading conversation"
      className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden px-3 pt-[var(--chat-header-clearance,0px)] pb-[var(--chat-composer-clearance,0px)] sm:px-5"
    >
      <div className="mx-auto flex w-full max-w-(--chat-timeline-max-width) flex-col gap-3 py-6">
        <Skeleton className="ml-auto h-9 w-2/5 rounded-2xl" />
        <Skeleton className="h-3.5 w-11/12" />
        <Skeleton className="h-3.5 w-4/5" />
        <Skeleton className="h-3.5 w-3/5" />
      </div>
    </div>
  );
}

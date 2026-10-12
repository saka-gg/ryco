import { cn } from "../../../lib/utils";
import { Skeleton } from "../../ui/skeleton";

/**
 * The quiet rows that hold the diff layout while it loads. Its own module so the
 * reader can show it while the Files tab chunk (the diff renderer) is still
 * downloading, without importing that chunk.
 */
export function PullRequestDiffSkeleton(props: { readonly className?: string | undefined }) {
  return (
    <div className={cn("min-h-0 flex-1 overflow-hidden px-6 pt-5", props.className)}>
      <div aria-busy className="space-y-8" aria-label="Loading the diff">
        {[0.62, 0.44, 0.7].map((width) => (
          <div key={width} className="space-y-3">
            <Skeleton className="h-3.5" style={{ width: `${width * 100}%` }} />
            <Skeleton className="h-28 w-full rounded-md opacity-60" />
          </div>
        ))}
      </div>
    </div>
  );
}

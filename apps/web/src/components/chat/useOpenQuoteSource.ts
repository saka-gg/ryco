import type { QuoteCitation } from "@ryco/shared/quoteCitations";
import { useRouter } from "@tanstack/react-router";

import { openQuoteSource } from "../../quoteSourceJumpStore";

/**
 * Opens a quote's source from a chip shown in `currentThreadKey`'s thread
 * (a sent message or a draft): the passage in view, its thread opened first
 * when it is another one.
 */
export function useOpenQuoteSource(
  currentThreadKey: string | null,
): (citation: QuoteCitation) => void {
  // Absent outside a router (isolated renders): only same-thread quotes open there.
  const router: ReturnType<typeof useRouter> | null = useRouter({ warn: false });
  return (citation) =>
    openQuoteSource(citation, {
      currentThreadKey,
      openThread:
        router === null
          ? null
          : (thread) =>
              void router.navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId: thread.environmentId, threadId: thread.threadId },
              }),
    });
}

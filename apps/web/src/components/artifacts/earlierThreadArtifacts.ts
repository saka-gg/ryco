import {
  readMessageArtifacts,
  type ThreadArtifactSource,
} from "@ryco/client-runtime/state/session";
import type {
  OrchestrationGetThreadHistoryPageInput,
  OrchestrationThreadHistoryCursor,
  OrchestrationThreadHistoryPage,
  ThreadId,
} from "@ryco/contracts";

/**
 * A thread's artifacts further back than the thread as loaded, read on their
 * own: only the messages that carry them, beside the thread store and never
 * merged into it, so the timeline's window and paging stay exactly as they are.
 */

export type ReadArtifactHistoryPage = (
  input: OrchestrationGetThreadHistoryPageInput,
) => Promise<OrchestrationThreadHistoryPage>;

/** Artifact messages per page; each page carries its pages' thumbnails. */
export const ARTIFACT_HISTORY_PAGE_LIMIT = 30;
// An older environment ignores the filter and pages every message; a read
// goes on through pages without artifacts, this far, before it reports back.
const MAX_PAGES_PER_READ = 5;

export interface EarlierArtifactMessages {
  /** The messages read that carry artifacts. */
  readonly messages: ReadonlyArray<ThreadArtifactSource>;
  /** Where the next read starts, or null at the start of the thread. */
  readonly cursor: OrchestrationThreadHistoryCursor | null;
}

/** Reads the artifact messages before `cursor`, until it has some or reaches the start. */
export async function readEarlierArtifactMessages(
  readPage: ReadArtifactHistoryPage,
  threadId: ThreadId,
  cursor: OrchestrationThreadHistoryCursor,
): Promise<EarlierArtifactMessages> {
  const messages: ThreadArtifactSource[] = [];
  let next: OrchestrationThreadHistoryCursor | null = cursor;
  for (let read = 0; read < MAX_PAGES_PER_READ && next !== null; read += 1) {
    const page: OrchestrationThreadHistoryPage = await readPage({
      threadId,
      collection: "messages",
      mode: { kind: "before", cursor: next },
      limit: ARTIFACT_HISTORY_PAGE_LIMIT,
      messageFilter: "artifacts",
    });
    if (page.collection !== "messages") return { messages, cursor: null };
    messages.push(...page.items.filter((message) => readMessageArtifacts(message).length > 0));
    next = page.page.hasMoreBefore ? page.page.oldestCursor : null;
    if (messages.length > 0) break;
  }
  return { messages, cursor: next };
}

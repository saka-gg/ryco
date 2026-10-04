import type { SidebarThreadSummary } from "@ryco/client-runtime/state/threads";

type ThreadActivityLike = Pick<
  SidebarThreadSummary,
  "latestUserMessageAt" | "updatedAt" | "createdAt"
>;

/** When a linked thread last moved: its latest prompt, else its last update, else creation. */
export function threadLinkActivityAt(thread: ThreadActivityLike): string {
  return thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt;
}

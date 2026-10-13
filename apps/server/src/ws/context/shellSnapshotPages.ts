import type { Array as Arr } from "effect";
import type {
  OrchestrationShellSnapshot,
  OrchestrationShellStreamItem,
  OrchestrationThreadShell,
} from "@ryco/contracts";

import { ORCHESTRATION_SHELL_SNAPSHOT_PAGE_MAX_BYTES } from "./constants.ts";

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
// The JSON around the threads of one message: the page wrapper, the end marker
// and the separators, with room to spare.
const PAGE_FRAMING_BYTES = 128;

/**
 * A shell snapshot as the RPC chunks of a paged delivery
 * (`snapshotDelivery: "paged"`): `snapshot-begin`, `snapshot-threads` pages,
 * `snapshot-end`. Each returned array is sent as one message and stays within
 * `maxBytes` unless a single thread is larger, which then travels alone.
 *
 * Unarchived threads come first, in snapshot order, then the archived ones,
 * and the archived threads always start a new message: a client can show the
 * unarchived shell as soon as that part has arrived, without decoding the
 * archive first.
 */
export const pageShellSnapshot = (
  snapshot: OrchestrationShellSnapshot,
  maxBytes: number = ORCHESTRATION_SHELL_SNAPSHOT_PAGE_MAX_BYTES,
): ReadonlyArray<Arr.NonEmptyReadonlyArray<OrchestrationShellStreamItem>> => {
  const unarchived: Array<OrchestrationThreadShell> = [];
  const archived: Array<OrchestrationThreadShell> = [];
  for (const thread of snapshot.threads) {
    (thread.archivedAt === null ? unarchived : archived).push(thread);
  }
  const begin: OrchestrationShellStreamItem = {
    kind: "snapshot-begin",
    snapshotSequence: snapshot.snapshotSequence,
    updatedAt: snapshot.updatedAt,
    projects: snapshot.projects,
    ...(snapshot.worktrees === undefined ? {} : { worktrees: snapshot.worktrees }),
    threadCount: snapshot.threads.length,
    archivedThreadCount: archived.length,
  };

  const messages: Array<Arr.NonEmptyArray<OrchestrationShellStreamItem>> = [];
  let message: Array<OrchestrationShellStreamItem> = [begin];
  let messageBytes = jsonBytes(begin);
  let page: Array<OrchestrationThreadShell> = [];
  const closePage = () => {
    if (page.length === 0) return;
    message.push({ kind: "snapshot-threads", threads: page });
    page = [];
  };
  const closeMessage = () => {
    closePage();
    if (message.length > 0) {
      messages.push(message as Arr.NonEmptyArray<OrchestrationShellStreamItem>);
    }
    message = [];
    messageBytes = 0;
  };
  const addThreads = (threads: ReadonlyArray<OrchestrationThreadShell>) => {
    for (const thread of threads) {
      const threadBytes = jsonBytes(thread) + 1;
      if (messageBytes > 0 && messageBytes + threadBytes > maxBytes - PAGE_FRAMING_BYTES) {
        closeMessage();
      }
      page.push(thread);
      messageBytes += threadBytes;
    }
  };

  addThreads(unarchived);
  if (archived.length > 0 && (page.length > 0 || message.length > 0)) closeMessage();
  addThreads(archived);
  closePage();
  message.push({ kind: "snapshot-end" });
  messages.push(message as Arr.NonEmptyArray<OrchestrationShellStreamItem>);
  return messages;
};

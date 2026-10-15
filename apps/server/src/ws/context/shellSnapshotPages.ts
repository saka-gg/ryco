import type { Array as Arr } from "effect";
import type {
  OrchestrationArchivedThreadStub,
  OrchestrationShellStreamItem,
  OrchestrationStubbedShellSnapshot,
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
 * filling the same byte budget. The archive does not start a message of its
 * own: every message costs an ack round trip, and clients apply the snapshot
 * only at `snapshot-end`, so a shell within the budget is exactly one message.
 *
 * A stubbed snapshot (`archivedThreadStubs`, for `archivedThreads: "stub"`)
 * sends its archived threads as `snapshot-archived-threads` pages of stubs
 * after every full shell, in the same byte budget.
 */
export const pageShellSnapshot = (
  snapshot: OrchestrationStubbedShellSnapshot,
  maxBytes: number = ORCHESTRATION_SHELL_SNAPSHOT_PAGE_MAX_BYTES,
): ReadonlyArray<Arr.NonEmptyReadonlyArray<OrchestrationShellStreamItem>> => {
  const unarchived: Array<OrchestrationThreadShell> = [];
  const archived: Array<OrchestrationThreadShell> = [];
  for (const thread of snapshot.threads) {
    (thread.archivedAt === null ? unarchived : archived).push(thread);
  }
  const stubs = snapshot.archivedThreadStubs ?? [];
  const archivedThreadCount = archived.length + stubs.length;
  const begin: OrchestrationShellStreamItem = {
    kind: "snapshot-begin",
    snapshotSequence: snapshot.snapshotSequence,
    updatedAt: snapshot.updatedAt,
    projects: snapshot.projects,
    ...(snapshot.worktrees === undefined ? {} : { worktrees: snapshot.worktrees }),
    threadCount: snapshot.threads.length + stubs.length,
    archivedThreadCount,
  };

  const messages: Array<Arr.NonEmptyArray<OrchestrationShellStreamItem>> = [];
  let message: Array<OrchestrationShellStreamItem> = [begin];
  let messageBytes = jsonBytes(begin);
  let page: Array<OrchestrationThreadShell> = [];
  let stubPage: Array<OrchestrationArchivedThreadStub> = [];
  const closePage = () => {
    if (page.length > 0) {
      message.push({ kind: "snapshot-threads", threads: page });
      page = [];
    }
    if (stubPage.length > 0) {
      message.push({ kind: "snapshot-archived-threads", threads: stubPage });
      stubPage = [];
    }
  };
  const closeMessage = () => {
    closePage();
    if (message.length > 0) {
      messages.push(message as Arr.NonEmptyArray<OrchestrationShellStreamItem>);
    }
    message = [];
    messageBytes = 0;
  };
  const fit = (threadBytes: number) => {
    if (messageBytes > 0 && messageBytes + threadBytes > maxBytes - PAGE_FRAMING_BYTES) {
      closeMessage();
    }
    messageBytes += threadBytes;
  };
  const addThreads = (threads: ReadonlyArray<OrchestrationThreadShell>) => {
    for (const thread of threads) {
      fit(jsonBytes(thread) + 1);
      page.push(thread);
    }
  };
  const addStubs = (threads: ReadonlyArray<OrchestrationArchivedThreadStub>) => {
    // Full shells of the message come first: its pages keep the snapshot order.
    if (threads.length > 0 && page.length > 0) {
      message.push({ kind: "snapshot-threads", threads: page });
      page = [];
      messageBytes += PAGE_FRAMING_BYTES / 2;
    }
    for (const thread of threads) {
      fit(jsonBytes(thread) + 1);
      stubPage.push(thread);
    }
  };

  addThreads(unarchived);
  addThreads(archived);
  addStubs(stubs);
  closePage();
  message.push({ kind: "snapshot-end" });
  messages.push(message as Arr.NonEmptyArray<OrchestrationShellStreamItem>);
  return messages;
};

/**
 * A message sent while some of its attachments were still uploading. It waits in the thread's
 * queue, in its place, and goes out unchanged once every upload finished: a message sent after
 * it never overtakes it. Platform-neutral: web and mobile hold sends the same way.
 *
 * This module is the part the queue's store, drain and coordinator read, so it loads with them at
 * boot. What a held message shows and how it settles lives in `uploadHoldSettle.ts`, which loads
 * with the composer.
 */
export interface QueuedMessageUploadHold {
  /** The attachments still uploading. The message goes out once this is empty. */
  readonly awaiting: ReadonlyArray<string>;
  /**
   * How the user sent it. `send`: an ordinary send, shown in the timeline as the message about
   * to go out, and sent from this device as its own turn. `queue`: a follow-up, shown in the
   * queue. `steer`: a follow-up that steers into the running turn once its uploads finish, if
   * that turn still runs, and otherwise waits for it like any queued message.
   */
  readonly sentAs: "send" | "queue" | "steer";
}

/** The part of a queued entry the upload hold reads. */
export interface UploadHeldEntry {
  readonly uploadHold?: QueuedMessageUploadHold | undefined;
}

/** True while the entry waits for its uploads: it is not sent, moved or steered yet. */
export function awaitsUploads(entry: UploadHeldEntry | undefined): boolean {
  return (entry?.uploadHold?.awaiting.length ?? 0) > 0;
}

/**
 * A send made while the queue holds an entry sent during its uploads waits behind that entry,
 * even once the uploads finished and until it went out: otherwise it would overtake it.
 */
export function queueHasUploadHeldSend(queue: ReadonlyArray<UploadHeldEntry> | undefined): boolean {
  return queue?.some((entry) => entry.uploadHold !== undefined) ?? false;
}

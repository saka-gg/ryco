import {
  LOCAL_TASK_MAX_FILE_TOTAL_BYTES,
  LOCAL_TASK_MAX_FILES,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@ryco/contracts";
import { RELAY_MAX_RPC_MESSAGE_BYTES } from "@ryco/contracts/relay";

/**
 * The pure half of adding files to a task: which files it can take, under
 * what names, and how large a file can be on each connection. `taskFiles.ts`
 * does the reads and uploads.
 */

/** Room in an inline add's message for everything but the file: the RPC envelope, the name, the E2EE framing. */
const INLINE_MESSAGE_RESERVE_BYTES = 64 * 1024;

/**
 * The largest file that can go inline: as a data URL inside one
 * `addLocalTaskFile` call, which the hosted relay refuses once the message is
 * over `RELAY_MAX_RPC_MESSAGE_BYTES`. Base64 takes four bytes for every three.
 */
export const TASK_FILE_INLINE_MAX_BYTES = Math.floor(
  ((RELAY_MAX_RPC_MESSAGE_BYTES - INLINE_MESSAGE_RESERVE_BYTES) * 3) / 4,
);

const MIME_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;
const FALLBACK_MIME_TYPE = "application/octet-stream";

/** A name the node stores as is: no path separators or control characters, at most 255 characters. */
export function sanitizeTaskFileName(name: string, type: "image" | "file"): string {
  const cleaned = name
    .replace(/[/\\\p{Cc}]+/gu, "_")
    .trim()
    .slice(0, 255)
    .trim();
  return cleaned.length > 0 ? cleaned : type;
}

function taskFileMimeType(file: Pick<File, "type">): string {
  const mimeType = file.type.split(";", 1)[0]!.trim();
  return mimeType.length <= 100 && MIME_TYPE_PATTERN.test(mimeType) ? mimeType : FALLBACK_MIME_TYPE;
}

const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))}MB`;

export interface TaskFileCandidate {
  readonly file: File;
  readonly name: string;
  readonly mimeType: string;
  readonly type: "image" | "file";
}

/**
 * The files a task can take, in order, and why any were refused: an image
 * or file over a message's size limit (or over what fits one message when it
 * goes inline), more files than a message carries, or more bytes than it
 * holds altogether (counting what the task holds and what is on its way).
 */
export function planTaskFileAdds(input: {
  readonly files: ReadonlyArray<File>;
  readonly heldCount: number;
  readonly heldBytes: number;
  /** The node's streaming limit for files, when uploads stream. */
  readonly streamingMaxBytes: number | null;
  /** The most one file can be when it goes inline (`TASK_FILE_INLINE_MAX_BYTES`), when it does. */
  readonly inlineMaxBytes: number | null;
}): { readonly accepted: ReadonlyArray<TaskFileCandidate>; readonly error: string | null } {
  const accepted: TaskFileCandidate[] = [];
  let count = input.heldCount;
  let bytes = input.heldBytes;
  let error: string | null = null;
  for (const file of input.files) {
    const type = file.type.startsWith("image/") ? "image" : "file";
    const name = sanitizeTaskFileName(file.name, type);
    const messageLimit =
      type === "image"
        ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
        : Math.min(
            input.streamingMaxBytes ?? PROVIDER_SEND_TURN_MAX_FILE_BYTES,
            PROVIDER_SEND_TURN_MAX_FILE_BYTES,
          );
    const limit = Math.min(messageLimit, input.inlineMaxBytes ?? messageLimit);
    if (file.size <= 0 || file.size > limit) {
      error =
        file.size > 0 && limit < messageLimit
          ? `'${name}' is larger than ${megabytes(limit)}, the most this connection can send.`
          : `'${name}' must be non-empty and no larger than ${megabytes(limit)}.`;
      continue;
    }
    if (count >= LOCAL_TASK_MAX_FILES) {
      error = `A task holds up to ${LOCAL_TASK_MAX_FILES} files.`;
      break;
    }
    if (bytes + file.size > LOCAL_TASK_MAX_FILE_TOTAL_BYTES) {
      error = `A task’s files can total at most ${megabytes(LOCAL_TASK_MAX_FILE_TOTAL_BYTES)}.`;
      continue;
    }
    accepted.push({ file, name, mimeType: taskFileMimeType(file), type });
    count += 1;
    bytes += file.size;
  }
  return { accepted, error };
}

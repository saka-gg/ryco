// Adapted from Synara v1.0.4 (d36a31a29); see docs/licenses/synara-computer-use.txt.
/**
 * Reads and bounds what `computer_paste` and the `paste` run step may put on
 * the clipboard: text, or one image or file from the caller's workspace.
 */
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { MAX_COMPUTER_CLIPBOARD_BYTES, type ComputerClipboardPayload } from "../ComputerBackend.ts";
import {
  boundedWorkspacePath,
  canonicalComputerWorkspaceRoot,
  type ComputerWorkspaceRootResolver,
} from "./computerWorkspacePath.ts";
import { ToolInputError } from "./toolInput.ts";
import type { ToolContext } from "./toolRuntime.ts";

const PASTE_FIELDS = ["text", "image_path", "file_path"] as const;

/** Bounded in bytes rather than characters: the backend pipes it to a process. */
export function readClipboardText(args: Record<string, unknown>): string {
  const value = args.text;
  if (typeof value !== "string") throw new ToolInputError('Argument "text" must be a string.');
  if (Buffer.byteLength(value, "utf8") > MAX_COMPUTER_CLIPBOARD_BYTES) {
    throw new ToolInputError(
      `Argument "text" is longer than the ${MAX_COMPUTER_CLIPBOARD_BYTES} byte clipboard limit.`,
    );
  }
  return value;
}

/**
 * Exactly one payload field. The tool schema cannot say so: a top-level
 * oneOf is rejected by provider tool-schema validators, so this is the check.
 * A null field counts as absent.
 */
export function readComputerPastePayload(args: Record<string, unknown>): ComputerClipboardPayload {
  const fields = PASTE_FIELDS.filter((field) => args[field] !== undefined && args[field] !== null);
  const [field] = fields;
  if (fields.length !== 1 || field === undefined)
    throw new ToolInputError('Paste requires exactly one of "text", "image_path" or "file_path".');
  if (field === "text") return { text: readClipboardText(args) };
  const value = args[field];
  if (typeof value !== "string" || !isAbsolute(value))
    throw new ToolInputError(`Argument "${field}" must be an absolute path.`);
  return field === "image_path" ? { imagePath: value } : { filePath: value };
}

/**
 * Text passes through. A path must be a canonical regular file inside the
 * caller thread's workspace; the canonical path is what reaches the driver,
 * which re-checks its identity before reading it.
 */
export async function boundComputerPastePayload(
  payload: ComputerClipboardPayload,
  context: ToolContext,
  signal: AbortSignal | undefined,
  resolveWorkspaceRoot: ComputerWorkspaceRootResolver | undefined,
): Promise<ComputerClipboardPayload> {
  signal?.throwIfAborted();
  if ("text" in payload) return payload;
  const workspaceRoot = await canonicalComputerWorkspaceRoot(
    resolveWorkspaceRoot,
    context,
    signal,
    "No canonical workspace is available for native file paste.",
  );
  const image = "imagePath" in payload;
  const path = await boundedWorkspacePath(
    image ? payload.imagePath : payload.filePath,
    workspaceRoot,
    image ? "image_path" : "file_path",
  );
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) throw new ToolInputError("Paste requires an existing regular file.");
  signal?.throwIfAborted();
  return image ? { imagePath: path } : { filePath: path };
}

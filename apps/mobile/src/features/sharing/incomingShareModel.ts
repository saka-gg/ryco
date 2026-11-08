// What other apps share into Ryco (the iOS share extension, expo-sharing)
// becomes a new task draft: shared text and links become the prompt, small
// common images attach inline like photos, and everything else attaches as a
// file that streams to the node once the user picks a machine. The user
// chooses machine and project in New Task after the hand-off.
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
} from "@ryco/contracts/orchestration";

import { attachesInline } from "../../lib/composerAttachmentBudget";
import type { DraftComposerAttachment } from "../../lib/composerFiles";

/** The fields of an expo-sharing payload this model reads. */
export interface IncomingSharePayload {
  readonly value: string;
  readonly shareType: "text" | "url" | "audio" | "image" | "video" | "file";
  readonly mimeType?: string | undefined;
}

/** File access, injected so the model stays testable off the device. */
export interface IncomingShareFileAccess {
  readonly readBase64: (uri: string) => Promise<string>;
  readonly readSize: (uri: string) => Promise<number | null>;
  /** Copies a shared file into app-owned storage, which outlives the hand-off. */
  readonly copyToOwned: (uri: string, name: string) => Promise<string>;
  readonly newId: () => string;
}

export interface IncomingShareDraft {
  readonly text: string;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly warnings: ReadonlyArray<string>;
}

const FILE_SHARE_TYPES = new Set(["image", "audio", "video", "file"]);

/** Where the app keeps its copies of shared files, inside its cache directory. */
export const INCOMING_SHARE_COPY_DIRECTORY = "incoming-shares";

/** Whether a file is one of the app's copies of a shared file. */
export function isIncomingShareCopyUri(uri: string): boolean {
  return uri.startsWith("file:") && uri.includes(`/${INCOMING_SHARE_COPY_DIRECTORY}/`);
}

/** Shared text and links, each once, in the order they came. */
export function incomingShareText(payloads: ReadonlyArray<IncomingSharePayload>): string {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const payload of payloads) {
    if (payload.shareType !== "text" && payload.shareType !== "url") continue;
    const value = payload.value.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
  }
  return values.join("\n\n");
}

/** A name for a shared file that came without one: its path's last part, else its kind. */
export function fallbackShareName(uri: string, index: number, mimeType: string): string {
  try {
    const last = new URL(uri).pathname.split("/").findLast((segment) => segment.length > 0);
    if (last) return decodeURIComponent(last);
  } catch {
    // Not a URL: name it by kind below.
  }
  const family = mimeType.split("/")[0]?.toLowerCase();
  const kind = family === "image" || family === "audio" || family === "video" ? family : "file";
  const extension =
    mimeType.split("/")[1]?.replace(/[^a-z0-9.+-]/gi, "") || (kind === "image" ? "png" : "bin");
  return `shared-${kind}-${index + 1}.${extension}`;
}

/** Strips iOS's /private prefix so /var and /private/var paths compare equal. */
function normalizedFileUriPath(uri: string): string | null {
  try {
    const url = new URL(uri);
    if (url.protocol !== "file:") return null;
    const path = decodeURIComponent(url.pathname);
    if (path.split("/").includes("..")) return null;
    return path.startsWith("/private/var/") ? path.slice("/private".length) : path;
  } catch {
    return null;
  }
}

/**
 * Whether a file lies inside one of the app's own directories, the only place
 * a share may be deleted from: an open-in-place share points at the sender's
 * original document.
 */
export function isShareFileUriUnderOwnedRoots(
  uri: string,
  ownedRootUris: ReadonlyArray<string>,
): boolean {
  const path = normalizedFileUriPath(uri);
  if (path === null) return false;
  return ownedRootUris.some((rootUri) => {
    const rootPath = normalizedFileUriPath(rootUri);
    if (rootPath === null) return false;
    const root = rootPath.endsWith("/") ? rootPath : `${rootPath}/`;
    return path.startsWith(root) && path.length > root.length;
  });
}

function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * The draft for a share. Only the payloads' own file copies are read: links
 * are never fetched from the phone (expo-sharing's resolver would GET each
 * one, spending one-time links and waiting on slow hosts).
 */
export async function buildIncomingShareDraft(input: {
  readonly payloads: ReadonlyArray<IncomingSharePayload>;
  readonly files: IncomingShareFileAccess;
}): Promise<IncomingShareDraft> {
  const attachments: DraftComposerAttachment[] = [];
  const warnings: string[] = [];
  let warnedLimit = false;

  for (const [index, payload] of input.payloads.entries()) {
    if (!FILE_SHARE_TYPES.has(payload.shareType)) continue;
    const uri = payload.value;
    if (attachments.length >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      if (!warnedLimit) {
        warnings.push(
          `Only the first ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} shared items were attached.`,
        );
        warnedLimit = true;
      }
      continue;
    }
    const mimeType = (
      payload.mimeType ?? (payload.shareType === "image" ? "image/png" : "application/octet-stream")
    ).toLowerCase();
    const name = fallbackShareName(uri, index, mimeType);
    try {
      const sizeBytes = await input.files.readSize(uri);
      if (sizeBytes === null || sizeBytes <= 0) {
        warnings.push(`'${name}' is empty or could not be read.`);
        continue;
      }
      if (attachesInline(mimeType, sizeBytes)) {
        const dataUrl = `data:${mimeType};base64,${await input.files.readBase64(uri)}`;
        attachments.push({
          type: "image",
          id: input.files.newId(),
          name,
          mimeType,
          sizeBytes,
          dataUrl,
          // A data preview outlives the temporary share file.
          previewUri: dataUrl,
        });
        continue;
      }
      if (sizeBytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
        warnings.push(
          `'${name}' is larger than the ${formatMegabytes(PROVIDER_SEND_TURN_MAX_FILE_BYTES)} file limit.`,
        );
        continue;
      }
      attachments.push({
        type: "file",
        id: input.files.newId(),
        name,
        mimeType,
        sizeBytes,
        readUri: await input.files.copyToOwned(uri, name),
      });
    } catch {
      warnings.push(`Could not read '${name}'.`);
    }
  }

  return { text: incomingShareText(input.payloads), attachments, warnings };
}

/** The prompt with the shared text after whatever the user already wrote. */
export function mergeIncomingShareText(prompt: string, shared: string): string {
  if (!shared) return prompt;
  return prompt.trim().length > 0 ? `${prompt.trimEnd()}\n\n${shared}` : shared;
}

/**
 * The share extension opens `<scheme>://expo-sharing`; the app reads it as a
 * New Task that takes the share.
 */
export const INCOMING_SHARE_NEW_TASK_PATH = "tasks/new?share=incoming";

export function rewriteIncomingSharePath(path: string): string {
  return /^\/?expo-sharing(?:[/?#]|$)/.test(path) ? INCOMING_SHARE_NEW_TASK_PATH : path;
}

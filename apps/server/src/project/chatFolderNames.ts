/**
 * ChatFolderNames - the names Ryco gives chat folders, `<YYYY-MM-DD>-<slug>-<8hex>`.
 *
 * The suffix ties a folder to its chat, so cleanup and deletion only ever touch a folder Ryco
 * allocated for that chat. Kept free of service dependencies: provider sessions and terminals
 * check it before they recreate a chat's folder (`chatFolderRestore.ts`).
 *
 * @module ChatFolderNames
 */
import { createHash } from "node:crypto";
import path from "node:path";

/** Fresh suffixes tried after the stable one collides; a full run means something is wrong. */
export const CHAT_FOLDER_ALLOCATION_ATTEMPTS = 8;

/** Stable for a project on the first attempt; a collision retry derives a fresh one. */
export const chatFolderSuffix = (projectId: string, attempt: number): string =>
  createHash("sha256")
    .update(attempt === 0 ? projectId : `${projectId}\0${attempt}`)
    .digest("hex")
    .slice(0, 8);

/** Whether a folder's name is one `createChatFolder` could have given this chat. */
export const isChatFolderNameOf = (folder: string, projectId: string): boolean => {
  const name = path.basename(folder);
  for (let attempt = 0; attempt < CHAT_FOLDER_ALLOCATION_ATTEMPTS; attempt += 1) {
    if (name.endsWith(`-${chatFolderSuffix(projectId, attempt)}`)) return true;
  }
  return false;
};

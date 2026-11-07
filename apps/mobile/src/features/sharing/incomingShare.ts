import Constants from "expo-constants";
import { clearSharedPayloads, getSharedPayloads, type SharePayload } from "expo-sharing";
import { Platform } from "react-native";

import { uuidv4 } from "../../lib/uuid";
import {
  buildIncomingShareDraft,
  INCOMING_SHARE_COPY_DIRECTORY,
  isIncomingShareCopyUri,
  isShareFileUriUnderOwnedRoots,
  type IncomingShareDraft,
} from "./incomingShareModel";

const APP_GROUP_UNAVAILABLE = "ERR_FAILED_TO_RESOLVE_APP_GROUP_ID";

/** Personal Team builds have no share extension (app.config.ts), and so no App Group to read. */
function receivesShares(): boolean {
  return Platform.OS === "ios" && Constants.expoConfig?.extra?.iosPersonalTeamBuild !== true;
}

function readPayloads(): ReadonlyArray<SharePayload> {
  try {
    return getSharedPayloads();
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === APP_GROUP_UNAVAILABLE) return [];
    throw error;
  }
}

async function ownedRootUris(): Promise<string[]> {
  const { Paths } = await import("expo-file-system");
  return [
    Paths.cache.uri,
    Paths.document.uri,
    ...Object.values(Paths.appleSharedContainers ?? {}).map((directory) => directory.uri),
  ];
}

/** The extension's temporary copies in the App Group; a sender's own document stays. */
async function removeHandoffCopies(payloads: ReadonlyArray<SharePayload>): Promise<void> {
  const { File } = await import("expo-file-system");
  const roots = await ownedRootUris();
  for (const payload of payloads) {
    if (payload.shareType === "text" || payload.shareType === "url") continue;
    if (!isShareFileUriUnderOwnedRoots(payload.value, roots)) continue;
    try {
      const file = new File(payload.value);
      if (file.exists) file.delete();
    } catch {
      // A leftover copy in the App Group is harmless.
    }
  }
}

let taking: Promise<IncomingShareDraft | null> | null = null;

/**
 * Takes what the share extension handed over, once: builds the new task draft,
 * then acknowledges the hand-off. Until then the payload stays in the App
 * Group, so an app that is closed mid-way reads it again on the next hand-off.
 */
export function takeIncomingShare(): Promise<IncomingShareDraft | null> {
  if (!receivesShares()) return Promise.resolve(null);
  taking ??= (async () => {
    try {
      const payloads = readPayloads();
      if (payloads.length === 0) return null;
      const draft = await buildIncomingShareDraft({
        payloads,
        files: {
          readBase64: async (uri) => {
            const { File } = await import("expo-file-system");
            return new File(uri).base64();
          },
          readSize: async (uri) => {
            const { File } = await import("expo-file-system");
            return new File(uri).size ?? null;
          },
          copyToOwned: async (uri, name) => {
            const { Directory, File, Paths } = await import("expo-file-system");
            const directory = new Directory(Paths.cache, INCOMING_SHARE_COPY_DIRECTORY, uuidv4());
            directory.create({ intermediates: true, idempotent: true });
            const target = new File(directory, name);
            new File(uri).copy(target);
            return target.uri;
          },
          newId: uuidv4,
        },
      });
      clearSharedPayloads();
      await removeHandoffCopies(payloads);
      return draft;
    } finally {
      taking = null;
    }
  })();
  return taking;
}

/**
 * Deletes the app's own copy of a shared file once the draft no longer needs
 * it (removed, sent, or the draft closed). Other files are left alone.
 */
export async function releaseIncomingShareCopy(uri: string): Promise<void> {
  if (!isIncomingShareCopyUri(uri)) return;
  try {
    const { File, Paths } = await import("expo-file-system");
    if (!isShareFileUriUnderOwnedRoots(uri, [Paths.cache.uri])) return;
    const file = new File(uri);
    const directory = file.parentDirectory;
    if (file.exists) file.delete();
    // Each copy has its own directory (copyToOwned): drop it with the file.
    if (directory.exists && directory.list().length === 0) directory.delete();
  } catch {
    // The OS clears the cache directory eventually.
  }
}

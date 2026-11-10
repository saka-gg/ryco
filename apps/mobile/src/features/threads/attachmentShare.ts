import { Share } from "react-native";

import { readEnvironmentApi } from "../../connection/environmentApi";
import { acquireAttachmentFile, type AttachmentFileReference } from "./attachmentFiles";

/**
 * Hands an attachment to the system share sheet as a file, read over its
 * machine's own connection first if this run has not read it yet. Rejects
 * when the file cannot be read; a dismissed share sheet is not an error.
 */
export async function shareAttachment(reference: AttachmentFileReference): Promise<void> {
  const lease = acquireAttachmentFile({
    reference,
    currentTransport: () => readEnvironmentApi(reference.environmentId)?.attachments,
  });
  try {
    const uri = await lease.promise;
    await Share.share({ url: uri }).catch(() => undefined);
  } finally {
    lease.release();
  }
}

import type { ChatFileUploadTransport } from "@ryco/client-runtime/state/composer";
import type { EnvironmentId } from "@ryco/contracts";

import { resolveEnvironmentHttpUrl } from "../environments/runtime";

// ---------------------------------------------------------------------------
// Single upload endpoint construction (change the server route here only).
// ---------------------------------------------------------------------------

export function buildChatAttachmentUploadUrl(input: {
  readonly environmentId: EnvironmentId;
  readonly uploadToken: string;
}): string {
  return resolveEnvironmentHttpUrl({
    environmentId: input.environmentId,
    pathname: "/attachments/upload",
    searchParams: { token: input.uploadToken },
  });
}

interface ChatAttachmentUploadResponse {
  readonly name?: unknown;
  readonly mimeType?: unknown;
  readonly sizeBytes?: unknown;
}

/**
 * Streams raw bytes to the environment over XHR so upload progress events are
 * available. The server answers 2xx with `{ name, mimeType, sizeBytes }`.
 */
function uploadBytesWithProgress(input: {
  readonly url: string;
  readonly bytes: Uint8Array;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: number) => void;
}): Promise<ChatAttachmentUploadResponse> {
  return new Promise((resolve, reject) => {
    if (input.signal?.aborted) {
      reject(new Error("The upload was cancelled."));
      return;
    }
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    request.addEventListener("loadend", () => input.signal?.removeEventListener("abort", abort));
    request.open("POST", input.url, true);
    request.withCredentials = true;
    request.responseType = "text";
    request.upload.addEventListener("progress", (event) => {
      if (!input.onProgress || !event.lengthComputable || event.total <= 0) {
        return;
      }
      input.onProgress(Math.min(1, event.loaded / event.total));
    });
    request.addEventListener("load", () => {
      if (request.status < 200 || request.status >= 300) {
        reject(new Error(`The upload was rejected (${request.status}).`));
        return;
      }
      input.onProgress?.(1);
      try {
        const parsed = JSON.parse(request.responseText || "{}") as ChatAttachmentUploadResponse;
        resolve(parsed);
      } catch {
        resolve({});
      }
    });
    request.addEventListener("error", () => {
      reject(new Error("The upload could not reach the server."));
    });
    request.addEventListener("abort", () => {
      reject(new Error("The upload was cancelled."));
    });
    request.setRequestHeader("Content-Type", "application/octet-stream");
    request.send(new Uint8Array(input.bytes));
  });
}

export const webChatFileUploadTransport: ChatFileUploadTransport = {
  createFileUploadUrl: async (input) => {
    // Dynamic import: this module sits upstream of the composer draft store,
    // which the environment connection service imports back.
    const { readEnvironmentConnection } = await import("../environments/runtime/service");
    const connection = readEnvironmentConnection(input.environmentId);
    if (!connection) {
      throw new Error("The environment is not connected.");
    }
    if (input.signal?.aborted) throw new Error("The upload was cancelled.");
    const { environmentId: _environmentId, signal: _signal, ...createInput } = input;
    return connection.client.chatAttachments.createFileUpload(createInput);
  },
  transferBytes: async (input) => {
    const url = buildChatAttachmentUploadUrl({
      environmentId: input.environmentId,
      uploadToken: input.uploadToken,
    });
    const confirmed = await uploadBytesWithProgress({
      url,
      bytes: input.bytes,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.onProgress ? { onProgress: input.onProgress } : {}),
    });
    return {
      ...(typeof confirmed.name === "string" ? { name: confirmed.name } : {}),
      ...(typeof confirmed.mimeType === "string" ? { mimeType: confirmed.mimeType } : {}),
      ...(typeof confirmed.sizeBytes === "number" ? { sizeBytes: confirmed.sizeBytes } : {}),
    };
  },
};

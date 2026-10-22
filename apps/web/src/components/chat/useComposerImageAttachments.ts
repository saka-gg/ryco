import type {
  EnvironmentId,
  ProviderDriverKind,
  RuntimeMode,
  ScopedThreadRef,
  ThreadId,
} from "@ryco/contracts";
import {
  PROJECT_STAGE_FILE_MAX_BYTES,
  PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@ryco/contracts";
import {
  PASTED_TEXT_MIME_TYPE,
  nextPastedTextFileName,
  resolvePastedTextDisposition,
  wouldTextPasteExceedInputLimit,
} from "@ryco/client-runtime/state/composer";
import { providerSupportsGeneralFileAttachments } from "@ryco/shared/providerCapabilities";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  formatComposerFileReference,
  shouldUseNativeComposerFileReference,
} from "../../composer-logic";
import {
  type ComposerImageAttachment,
  type DraftId,
  useComposerDraftStore,
} from "../../composerDraftStore";
import {
  composerFileUploadEngine,
  useEnvironmentFileUploadCapability,
} from "../../composerFileUpload";
import { readEnvironmentApi } from "~/environmentApi";
import { getPrimaryKnownEnvironment } from "~/environments/primary";
import { getEnvironmentHttpBaseUrl } from "~/environments/runtime/catalog";
import { readLocalApi } from "~/localApi";
import { randomUUID } from "~/lib/utils";
import { toastManager } from "../ui/toast";
import type { ComposerPromptEditorHandle, ComposerTextPaste } from "../ComposerPromptEditor";

const IMAGE_SIZE_LIMIT_LABEL = `${Math.round(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / (1024 * 1024))}MB`;
const FILE_SIZE_LIMIT_LABEL = `${Math.round(PROVIDER_SEND_TURN_MAX_FILE_BYTES / (1024 * 1024))}MB`;
const STAGED_FILE_SIZE_LIMIT_LABEL = `${Math.round(PROJECT_STAGE_FILE_MAX_BYTES / (1024 * 1024))}MB`;
const COMPOSER_FILE_REFERENCE_SEPARATOR = " ";

function formatUploadSizeLimitLabel(maxBytes: number): string {
  const streamingLimit = Math.min(maxBytes, PROVIDER_SEND_TURN_MAX_FILE_BYTES);
  return streamingLimit % (1024 * 1024) === 0
    ? `${Math.round(streamingLimit / (1024 * 1024))}MB`
    : `${Math.round(streamingLimit / 1024)}KB`;
}

async function readFileAsBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export interface ComposerAttachmentRouting {
  /** Files attached directly to the composer (images, or files when supported). */
  readonly direct: File[];
  /** Files degraded into workspace file references in the prompt. */
  readonly references: File[];
}

/**
 * Capability-based routing: the environment's `fileAttachments` capability
 * sends every file straight to the composer (non-images stream through the
 * upload queue). Without it, the legacy provider gate keeps the old split —
 * inline dataUrl files where the provider ingests bytes, file references
 * everywhere else.
 */
export function resolveComposerAttachmentRouting(input: {
  fileUploadMaxBytes: number | null;
  selectedProvider: ProviderDriverKind;
  files: readonly File[];
}): ComposerAttachmentRouting {
  const supportsDirectFiles =
    input.fileUploadMaxBytes !== null ||
    providerSupportsGeneralFileAttachments(input.selectedProvider);
  if (supportsDirectFiles) {
    return { direct: [...input.files], references: [] };
  }
  const direct: File[] = [];
  const references: File[] = [];
  for (const file of input.files) {
    if (file.type.startsWith("image/")) {
      direct.push(file);
    } else {
      references.push(file);
    }
  }
  return { direct, references };
}

export interface UseComposerImageAttachmentsParams {
  composerDraftTarget: ScopedThreadRef | DraftId;
  environmentId: EnvironmentId;
  activeThreadId: ThreadId | null;
  draftId: DraftId | null;
  routeThreadRef: ScopedThreadRef;
  runtimeMode: RuntimeMode;
  selectedProvider: ProviderDriverKind;
  gitCwd: string | null;
  pendingUserInputCount: number;
  composerImagesRef: React.MutableRefObject<ComposerImageAttachment[]>;
  editorRef: React.RefObject<ComposerPromptEditorHandle | null>;
  setThreadError: (threadId: ThreadId | null, error: string | null) => void;
  focusComposer: () => void;
}

export interface UseComposerImageAttachmentsResult {
  isDragOverComposer: boolean;
  addComposerAttachments: (files: File[]) => Promise<void>;
  removeComposerImage: (imageId: string) => void;
  retryComposerFileUpload: (imageId: string) => void;
  onComposerPaste: (event: React.ClipboardEvent<HTMLElement>) => void;
  /** Folds a large text paste into a `pasted-text.txt` attachment; true when it did. */
  onComposerPasteText: (paste: ComposerTextPaste) => boolean;
  onComposerDragEnter: (event: React.DragEvent<HTMLDivElement>) => void;
  onComposerDragOver: (event: React.DragEvent<HTMLDivElement>) => void;
  onComposerDragLeave: (event: React.DragEvent<HTMLDivElement>) => void;
  onComposerDrop: (event: React.DragEvent<HTMLDivElement>) => void;
}

/**
 * Owns composer image/file attachment handling: staging, drag-and-drop, paste,
 * and the drag-over visual state. Extracted from ChatComposer so the editor
 * shell and footer can share the same attachment pipeline.
 *
 * Routing is capability-based: when the environment advertises
 * `fileAttachments`, non-image files attach directly and stream through the
 * upload queue; otherwise the legacy provider gate decides between inline
 * dataUrl attach and workspace file-reference staging.
 */
export function useComposerImageAttachments(
  params: UseComposerImageAttachmentsParams,
): UseComposerImageAttachmentsResult {
  const {
    composerDraftTarget,
    environmentId,
    activeThreadId,
    draftId,
    routeThreadRef,
    runtimeMode,
    selectedProvider,
    gitCwd,
    pendingUserInputCount,
    composerImagesRef,
    editorRef,
    setThreadError,
    focusComposer,
  } = params;

  const advertisedFileUploadMaxBytes = useEnvironmentFileUploadCapability(environmentId);
  // Streaming also needs an environment HTTP base URL to transfer bytes
  // against; hosted-relay environments keep the legacy attach paths.
  const fileUploadMaxBytes =
    advertisedFileUploadMaxBytes !== null && getEnvironmentHttpBaseUrl(environmentId) !== null
      ? advertisedFileUploadMaxBytes
      : null;

  const addComposerDraftImage = useComposerDraftStore((store) => store.addImage);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const removeComposerDraftImage = useComposerDraftStore((store) => store.removeImage);
  const getComposerDraftSession = useComposerDraftStore((store) => store.getDraftSession);

  const [isDragOverComposer, setIsDragOverComposer] = useState(false);
  const dragDepthRef = useRef(0);

  useEffect(() => {
    dragDepthRef.current = 0;
    setIsDragOverComposer(false);
  }, [draftId, activeThreadId]);

  const addComposerImage = useCallback(
    (image: ComposerImageAttachment) => {
      addComposerDraftImage(composerDraftTarget, image);
    },
    [composerDraftTarget, addComposerDraftImage],
  );

  const addComposerImagesToDraft = useCallback(
    (images: ComposerImageAttachment[]) => {
      addComposerDraftImages(composerDraftTarget, images);
    },
    [composerDraftTarget, addComposerDraftImages],
  );

  const removeComposerImageFromDraft = useCallback(
    (imageId: string) => {
      removeComposerDraftImage(composerDraftTarget, imageId);
    },
    [composerDraftTarget, removeComposerDraftImage],
  );

  const resolveUploadThreadId = useCallback((): ThreadId | null => {
    if (typeof composerDraftTarget !== "string") {
      return composerDraftTarget.threadId;
    }
    return (draftId ? getComposerDraftSession(draftId)?.threadId : null) ?? routeThreadRef.threadId;
  }, [composerDraftTarget, draftId, getComposerDraftSession, routeThreadRef]);

  const enqueueFileUpload = useCallback(
    (file: File, attachmentId: string) => {
      if (fileUploadMaxBytes === null) {
        return;
      }
      const threadId = resolveUploadThreadId();
      if (!threadId) {
        return;
      }
      composerFileUploadEngine.enqueue({
        attachmentId,
        threadId,
        environmentId,
        name: file.name || "file",
        mimeType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        readBytes: async () => new Uint8Array(await file.arrayBuffer()),
      });
    },
    [environmentId, fileUploadMaxBytes, resolveUploadThreadId],
  );

  const addDirectComposerAttachments = useCallback(
    (files: File[]) => {
      if (!activeThreadId || files.length === 0) return;
      if (pendingUserInputCount > 0) {
        toastManager.add({
          type: "error",
          title: "Attach files after answering plan questions.",
        });
        return;
      }
      const nextImages: ComposerImageAttachment[] = [];
      let nextAttachmentCount = composerImagesRef.current.length;
      let nextTotalBytes = composerImagesRef.current.reduce(
        (total, attachment) => total + attachment.sizeBytes,
        0,
      );
      let error: string | null = null;
      for (const file of files) {
        const isImage = file.type.startsWith("image/");
        const attachmentName = file.name || (isImage ? "image" : "file");
        if (!/^[^/\\\p{Cc}]+$/u.test(attachmentName)) {
          error = `'${attachmentName}' has an unsafe filename. Rename it without path separators or control characters.`;
          continue;
        }
        const streamsUpload = !isImage && fileUploadMaxBytes !== null;
        const fileLimit = isImage
          ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
          : streamsUpload
            ? Math.min(fileUploadMaxBytes, PROVIDER_SEND_TURN_MAX_FILE_BYTES)
            : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
        const limitLabel = isImage
          ? IMAGE_SIZE_LIMIT_LABEL
          : streamsUpload
            ? formatUploadSizeLimitLabel(fileUploadMaxBytes)
            : `${Math.round(PROVIDER_SEND_TURN_MAX_FILE_BYTES / (1024 * 1024))}MB`;
        if (file.size <= 0 || file.size > fileLimit) {
          error = `'${attachmentName}' must be non-empty and no larger than the ${limitLabel} attachment limit.`;
          continue;
        }
        if (nextAttachmentCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
          error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`;
          break;
        }
        if (nextTotalBytes + file.size > PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES) {
          error = `Attachments can total at most ${FILE_SIZE_LIMIT_LABEL} per message.`;
          continue;
        }
        const attachmentId = randomUUID();
        const previewUrl = isImage ? URL.createObjectURL(file) : "";
        nextImages.push({
          type: isImage ? "image" : "file",
          id: attachmentId,
          name: attachmentName,
          mimeType: file.type || "application/octet-stream",
          sizeBytes: file.size,
          previewUrl,
          file,
        });
        if (streamsUpload) {
          enqueueFileUpload(file, attachmentId);
        }
        nextAttachmentCount += 1;
        nextTotalBytes += file.size;
      }
      if (nextImages.length === 1 && nextImages[0]) {
        addComposerImage(nextImages[0]);
      } else if (nextImages.length > 1) {
        addComposerImagesToDraft(nextImages);
      }
      setThreadError(activeThreadId, error);
    },
    [
      activeThreadId,
      addComposerImage,
      addComposerImagesToDraft,
      composerImagesRef,
      enqueueFileUpload,
      fileUploadMaxBytes,
      pendingUserInputCount,
      setThreadError,
    ],
  );

  const insertComposerFileReferences = useCallback(
    (references: readonly string[]) => {
      if (references.length === 0) return;
      const editor = editorRef.current;
      if (!editor) return;

      const snapshot = editor.readSnapshot();
      const insertion = references.join(COMPOSER_FILE_REFERENCE_SEPARATOR);
      const left = snapshot.value[snapshot.cursor - 1] ?? "";
      const right = snapshot.value[snapshot.cursor] ?? "";
      const needsLeadingSpace = left.length > 0 && !/\s/.test(left);
      const needsTrailingSpace = right.length > 0 && !/\s/.test(right);
      editor.insertTextAndFocus(
        `${needsLeadingSpace ? COMPOSER_FILE_REFERENCE_SEPARATOR : ""}${insertion}${needsTrailingSpace ? COMPOSER_FILE_REFERENCE_SEPARATOR : ""}`,
      );
    },
    [editorRef],
  );

  const isLocalDesktopEnvironment = useCallback(() => {
    const primaryEnvironment = getPrimaryKnownEnvironment();
    return (
      window.desktopBridge !== undefined &&
      primaryEnvironment?.source === "desktop-managed" &&
      primaryEnvironment.environmentId === environmentId
    );
  }, [environmentId]);

  const stageComposerFileReference = useCallback(
    async (file: File): Promise<string | null> => {
      if (!gitCwd) {
        toastManager.add({
          type: "error",
          title: `Couldn't stage '${file.name || "file"}'.`,
          description: "No active workspace is available for this composer.",
        });
        return null;
      }
      if (file.size > PROJECT_STAGE_FILE_MAX_BYTES) {
        toastManager.add({
          type: "error",
          title: `'${file.name || "file"}' exceeds the ${STAGED_FILE_SIZE_LIMIT_LABEL} file staging limit.`,
        });
        return null;
      }
      const environmentApi = readEnvironmentApi(environmentId);
      if (!environmentApi) {
        toastManager.add({
          type: "error",
          title: `Couldn't stage '${file.name || "file"}'.`,
          description: "The active environment is not connected.",
        });
        return null;
      }

      try {
        const result = await environmentApi.projects.stageFileReference({
          cwd: gitCwd,
          scopeId: String(activeThreadId ?? draftId ?? routeThreadRef.threadId),
          name: file.name || "file",
          ...(file.type ? { mimeType: file.type } : {}),
          sizeBytes: file.size,
          dataBase64: await readFileAsBase64(file),
        });
        return result.relativePath;
      } catch (error) {
        toastManager.add({
          type: "error",
          title: `Couldn't stage '${file.name || "file"}'.`,
          description: error instanceof Error ? error.message : "File staging failed.",
        });
        return null;
      }
    },
    [activeThreadId, draftId, environmentId, gitCwd, routeThreadRef.threadId],
  );

  const resolveComposerFileReference = useCallback(
    async (file: File): Promise<string | null> => {
      let resolvedPath: string | null = null;
      try {
        resolvedPath = (await readLocalApi()?.shell.getPathForFile?.(file)) ?? null;
      } catch {
        resolvedPath = null;
      }

      if (
        shouldUseNativeComposerFileReference({
          resolvedPath,
          cwd: gitCwd,
          runtimeMode,
          isLocalDesktopEnvironment: isLocalDesktopEnvironment(),
        })
      ) {
        return resolvedPath;
      }

      return stageComposerFileReference(file);
    },
    [gitCwd, isLocalDesktopEnvironment, runtimeMode, stageComposerFileReference],
  );

  const addComposerAttachments = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;

      const { direct, references } = resolveComposerAttachmentRouting({
        fileUploadMaxBytes,
        selectedProvider,
        files,
      });

      if (direct.length > 0) {
        addDirectComposerAttachments(direct);
      }

      if (references.length === 0) {
        return;
      }

      const fileReferences = (
        await Promise.all(
          references.map(async (file) => {
            const reference = await resolveComposerFileReference(file);
            return reference ? formatComposerFileReference(reference) : null;
          }),
        )
      ).filter((reference): reference is string => reference !== null);
      insertComposerFileReferences(fileReferences);
    },
    [
      addDirectComposerAttachments,
      fileUploadMaxBytes,
      insertComposerFileReferences,
      resolveComposerFileReference,
      selectedProvider,
    ],
  );

  const removeComposerImage = useCallback(
    (imageId: string) => {
      composerFileUploadEngine.release(imageId);
      removeComposerImageFromDraft(imageId);
    },
    [removeComposerImageFromDraft],
  );

  const retryComposerFileUpload = useCallback((imageId: string) => {
    composerFileUploadEngine.retry(imageId);
  }, []);

  const onComposerPaste = useCallback(
    (event: React.ClipboardEvent<HTMLElement>) => {
      const files = Array.from(event.clipboardData.files);
      if (files.length === 0) return;
      event.preventDefault();
      void addComposerAttachments(files);
    },
    [addComposerAttachments],
  );

  const onComposerPasteText = useCallback(
    (paste: ComposerTextPaste): boolean => {
      const attachments = composerImagesRef.current;
      const disposition = resolvePastedTextDisposition({
        text: paste.text,
        // A plan question's answer is the editor's text, and a full composer keeps the paste
        // visible instead of failing it.
        canAttach:
          activeThreadId !== null &&
          pendingUserInputCount === 0 &&
          attachments.length < PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
        pasteAsText: paste.pasteAsText,
        wouldExceedInputLimit: wouldTextPasteExceedInputLimit({
          promptLength: paste.promptLength,
          selectedLength: paste.selectedLength,
          pastedLength: paste.text.length,
        }),
      });
      if (disposition === "inline") return false;
      const name = nextPastedTextFileName(attachments.map((attachment) => attachment.name));
      void addComposerAttachments([new File([paste.text], name, { type: PASTED_TEXT_MIME_TYPE })]);
      return true;
    },
    [activeThreadId, addComposerAttachments, composerImagesRef, pendingUserInputCount],
  );

  const onComposerDragEnter = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDragOverComposer(true);
  }, []);

  const onComposerDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDragOverComposer(true);
  }, []);

  const onComposerDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDragOverComposer(false);
    }
  }, []);

  const onComposerDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      dragDepthRef.current = 0;
      setIsDragOverComposer(false);
      const files = Array.from(event.dataTransfer.files);
      const requiresFileReferences =
        resolveComposerAttachmentRouting({ fileUploadMaxBytes, selectedProvider, files }).references
          .length > 0;
      void addComposerAttachments(files);
      if (!requiresFileReferences) {
        focusComposer();
      }
    },
    [addComposerAttachments, fileUploadMaxBytes, focusComposer, selectedProvider],
  );

  return {
    isDragOverComposer,
    addComposerAttachments,
    removeComposerImage,
    retryComposerFileUpload,
    onComposerPaste,
    onComposerPasteText,
    onComposerDragEnter,
    onComposerDragOver,
    onComposerDragLeave,
    onComposerDrop,
  };
}

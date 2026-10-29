import type { EnvironmentId } from "@ryco/contracts";
import { Suspense, useEffect, useState } from "react";

import { errorMessage } from "../lib/errorMessage";
import { preloadableLazy } from "../lib/preloadableLazy";
import { formatAttachmentBytes } from "./chat/attachmentPreview";
import { DiffPanelLoadingState } from "./DiffPanelShell";
import { PreviewReadFailure, usePreviewRetryKey } from "./PreviewReadFailure";
import { readEnvironmentWorkspaceFileBytes } from "./previewWorkspaceFileBytes";

// The same lazy chunk chat attachments use: pdf.js loads only once a PDF opens,
// alongside the file's chunks, so the viewer is usually ready when they arrive.
const PdfDocumentPreview = preloadableLazy(() =>
  import("./chat/PdfAttachmentPreview").then((module) => module.default),
);

type PreviewPdfState =
  | {
      readonly status: "loading";
      readonly loadedBytes: number;
      readonly totalBytes: number | null;
    }
  | { readonly status: "ready"; readonly bytes: Uint8Array<ArrayBuffer> }
  | { readonly status: "error"; readonly message: string };

const LOADING: PreviewPdfState = { status: "loading", loadedBytes: 0, totalBytes: null };

interface PreviewPdfProps {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly relativePath: string;
  /** Changes when the agent touched the file, so it is read again (as PreviewImage). */
  readonly refreshKey: string | null;
}

/**
 * A workspace PDF read in bounded chunks over the thread's node, then rendered
 * by the attachment viewer from those bytes: no URL, token or same-origin blob
 * ever names the file. Switching files or closing the panel aborts the read,
 * so no further chunk is requested; a failed read can be tried again in place.
 */
export function PreviewPdf(props: PreviewPdfProps) {
  const [attempt, retry] = usePreviewRetryKey();
  return <PreviewPdfRead key={attempt} {...props} onRetry={retry} />;
}

function PreviewPdfRead({
  environmentId,
  cwd,
  relativePath,
  refreshKey,
  onRetry,
}: PreviewPdfProps & { readonly onRetry: () => void }) {
  const readKey = JSON.stringify([environmentId, cwd, relativePath, refreshKey]);
  const [state, setState] = useState<{ key: string; pdf: PreviewPdfState } | null>(null);

  useEffect(() => {
    if (!environmentId || !cwd) return;
    void PdfDocumentPreview.preload();
    const controller = new AbortController();
    const update = (pdf: PreviewPdfState) => {
      if (!controller.signal.aborted) setState({ key: readKey, pdf });
    };
    void readEnvironmentWorkspaceFileBytes({
      environmentId,
      cwd,
      relativePath,
      signal: controller.signal,
      onProgress: ({ loadedBytes, totalBytes }) =>
        update({ status: "loading", loadedBytes, totalBytes }),
    })
      .then((file) => {
        if (file.mimeType !== "application/pdf") throw new Error("Not a PDF.");
        update({ status: "ready", bytes: file.bytes });
      })
      .catch((error: unknown) => {
        update({ status: "error", message: errorMessage(error, "Couldn’t load this PDF.") });
      });
    return () => controller.abort();
  }, [cwd, environmentId, readKey, relativePath]);

  const pdf = state?.key === readKey ? state.pdf : LOADING;
  if (pdf.status === "loading") {
    return (
      <DiffPanelLoadingState
        label={
          pdf.totalBytes === null
            ? "Loading PDF..."
            : `Loading PDF… ${formatAttachmentBytes(pdf.loadedBytes)} of ${formatAttachmentBytes(pdf.totalBytes)}`
        }
      />
    );
  }
  if (pdf.status === "error") return <PreviewReadFailure message={pdf.message} onRetry={onRetry} />;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-preview-pdf>
      <Suspense fallback={<DiffPanelLoadingState label="Loading PDF viewer..." />}>
        <PdfDocumentPreview
          key={readKey}
          source={{ kind: "data", data: pdf.bytes }}
          name={relativePath}
          unavailableHint="Download or open it outside Ryco to view it."
        />
      </Suspense>
    </div>
  );
}

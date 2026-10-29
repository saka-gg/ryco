import { useEffect, useRef, useState } from "react";
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { PdfAttachmentBinaryDataFactory } from "./pdfAttachmentAssets";
import { Button } from "../ui/button";

GlobalWorkerOptions.workerSrc = workerUrl;

export type PdfPreviewSource =
  | { readonly kind: "url"; readonly url: string }
  /** Bytes already read over an authorized transport. Never mutated here: pdf.js gets a copy. */
  | { readonly kind: "data"; readonly data: Uint8Array };

const DEFAULT_UNAVAILABLE_HINT = "Download it to open it.";

/** Lazy-loaded, one-page renderer. No document scripts, embedded frames, or external viewer. */
export default function PdfAttachmentPreview({
  source,
  name,
  unavailableHint = DEFAULT_UNAVAILABLE_HINT,
}: {
  source: PdfPreviewSource;
  name: string;
  /** Appended to load failures; attachments offer a download. */
  unavailableHint?: string | undefined;
}) {
  const [document, setDocument] = useState<PDFDocumentProxy>();
  const [pageNumber, setPageNumber] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState<string>();
  const [rendering, setRendering] = useState(true);
  const container = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const sourceInput = source.kind === "url" ? source.url : source.data;
  useEffect(() => {
    const task = getDocument({
      // pdf.js transfers (detaches) a typed array it is given, so it gets a copy:
      // a re-run of this effect must still find the caller's bytes intact.
      ...(typeof sourceInput === "string"
        ? { url: sourceInput, withCredentials: true }
        : { data: sourceInput.slice() }),
      enableXfa: false,
      useWorkerFetch: false,
      BinaryDataFactory: PdfAttachmentBinaryDataFactory,
    });
    let active = true;
    void task.promise
      .then((pdf) => {
        if (active) setDocument(pdf);
      })
      .catch((cause: unknown) => {
        if (active)
          setError(
            cause instanceof Error && cause.name === "PasswordException"
              ? `This PDF is password protected. ${unavailableHint}`
              : `Could not preview this PDF. ${unavailableHint}`,
          );
      });
    return () => {
      active = false;
      void task.destroy();
    };
  }, [sourceInput, unavailableHint]);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(100, entry.contentRect.width - 32));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!document) return;
    let active = true;
    let cancel: (() => void) | undefined;
    void (async () => {
      const page = await document.getPage(pageNumber);
      if (!active || !canvas.current) return;
      setRendering(true);
      const naturalViewport = page.getViewport({ scale: 1 });
      const outputScale = Math.min(window.devicePixelRatio || 1, 2);
      // Bound canvas allocations even for documents with extreme page dimensions.
      const scale = Math.min(
        (Math.min(width, 1600) / naturalViewport.width) * zoom,
        4096 / (Math.max(naturalViewport.width, naturalViewport.height) * outputScale),
      );
      const viewport = page.getViewport({ scale });
      const element = window.document.createElement("canvas");
      element.className = "mx-auto bg-white";
      element.setAttribute("role", "img");
      element.setAttribute("aria-label", `${name}, page ${pageNumber}`);
      element.width = Math.ceil(viewport.width * outputScale);
      element.height = Math.ceil(viewport.height * outputScale);
      element.style.width = `${viewport.width}px`;
      element.style.height = `${viewport.height}px`;
      const task = page.render({
        canvas: element,
        viewport,
        transform: [outputScale, 0, 0, outputScale, 0, 0],
      });
      cancel = () => task.cancel();
      try {
        await task.promise;
      } finally {
        page.cleanup();
      }
      if (active && canvas.current) {
        canvas.current.replaceChildren(element);
        setRendering(false);
      }
    })().catch(() => {
      if (active) setError(`Could not render this page. ${unavailableHint}`);
    });
    return () => {
      active = false;
      cancel?.();
    };
  }, [document, pageNumber, width, zoom, name, unavailableHint]);
  return (
    <>
      <div
        className="flex shrink-0 items-center justify-center gap-2 border-b p-2"
        aria-label="PDF controls"
      >
        <Button
          variant="ghost"
          size="sm"
          disabled={!document || pageNumber <= 1}
          onClick={() => setPageNumber((page) => page - 1)}
          aria-label="Previous page"
        >
          Previous
        </Button>
        <span className="text-xs" aria-live="polite">
          Page {pageNumber} of {document?.numPages ?? "…"}
        </span>
        <Button
          variant="ghost"
          size="sm"
          disabled={!document || pageNumber >= document.numPages}
          onClick={() => setPageNumber((page) => page + 1)}
          aria-label="Next page"
        >
          Next
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={zoom <= 0.5}
          onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}
          aria-label="Zoom out"
        >
          −
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setZoom(1)} aria-label="Fit to width">
          {Math.round(zoom * 100)}%
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={zoom >= 2}
          onClick={() => setZoom((value) => Math.min(2, value + 0.25))}
          aria-label="Zoom in"
        >
          +
        </Button>
      </div>
      <div ref={container} className="min-h-0 flex-1 overflow-auto bg-muted/50 p-4">
        {error ? (
          <p role="status" className="text-sm">
            {error}
          </p>
        ) : (
          <>
            {rendering && (
              <p role="status" className="text-sm">
                Rendering page…
              </p>
            )}
            <div ref={canvas} style={{ visibility: rendering ? "hidden" : "visible" }} />
          </>
        )}
      </div>
    </>
  );
}

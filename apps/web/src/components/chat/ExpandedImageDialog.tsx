import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { usePaneEffect, usePaneFocus } from "./PaneFocus";
import { memo, useCallback, useEffect, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { hasNoShortcutModifiers } from "../../keybindings";
import { Button } from "../ui/button";
import { ExpandedImageContent } from "./ExpandedImageContent";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

interface ExpandedImageDialogProps {
  preview: ExpandedImagePreview;
  onClose: () => void;
  /** Fit the desktop chat column rather than the full window. */
  contained?: boolean;
}

/** The shown preview, re-synced whenever the parent hands over a new one. */
function useExpandedImageNavigation(initialPreview: ExpandedImagePreview) {
  const [preview, setPreview] = useState(initialPreview);

  // Sync when the parent hands us a new preview reference.
  useEffect(() => {
    setPreview(initialPreview);
  }, [initialPreview]);

  const navigateImage = useCallback((direction: -1 | 1) => {
    setPreview((existing) => {
      if (existing.images.length <= 1) return existing;
      const nextIndex =
        (existing.index + direction + existing.images.length) % existing.images.length;
      if (nextIndex === existing.index) return existing;
      return { ...existing, index: nextIndex };
    });
  }, []);

  return [preview, navigateImage] as const;
}

/** The arrow key's direction, when it should page through more than one image. */
function navigationDirection(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  imageCount: number,
): -1 | 1 | null {
  if (imageCount <= 1 || !hasNoShortcutModifiers(event)) return null;
  if (event.key === "ArrowLeft") return -1;
  if (event.key === "ArrowRight") return 1;
  return null;
}

export const ExpandedImageDialog = memo(function ExpandedImageDialog({
  preview: initialPreview,
  onClose,
  contained = false,
}: ExpandedImageDialogProps) {
  const paneFocused = usePaneFocus();
  const [preview, navigateImage] = useExpandedImageNavigation(initialPreview);

  usePaneEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!hasNoShortcutModifiers(event)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      const direction = navigationDirection(event, preview.images.length);
      if (direction === null) return;
      event.preventDefault();
      event.stopPropagation();
      navigateImage(direction);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigateImage, onClose, preview.images.length]);

  if (!preview.images[preview.index]) return null;

  if (!paneFocused) return null;

  return (
    <div
      className={`${contained ? "absolute [container-type:size] overflow-hidden" : "fixed"} inset-0 z-50 flex items-center justify-center bg-black/75 ${contained && preview.images.length > 1 ? "px-12 sm:px-16" : "px-4"} py-6 [-webkit-app-region:no-drag]`}
      role="dialog"
      aria-modal="true"
      aria-label="Expanded image preview"
    >
      <ExpandedImageStage
        preview={preview}
        onClose={onClose}
        onNavigate={navigateImage}
        contained={contained}
      />
    </div>
  );
});

/**
 * The full-window preview as a real modal dialog, for images shown inside
 * other dialogs (Markdown bodies in the project explorer, for one). It nests
 * under any open dialog, so Escape and outside clicks close only the preview,
 * and focus stays inside it until it closes.
 */
export const ExpandedImageModal = memo(function ExpandedImageModal({
  preview: initialPreview,
  onClose,
}: Omit<ExpandedImageDialogProps, "contained">) {
  const [preview, navigateImage] = useExpandedImageNavigation(initialPreview);
  if (!preview.images[preview.index]) return null;

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Popup
          aria-label="Expanded image preview"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-4 py-6 outline-none transition-opacity duration-(--app-motion-duration-pop) data-ending-style:opacity-0 data-starting-style:opacity-0 [-webkit-app-region:no-drag]"
          onKeyDown={(event) => {
            const direction = navigationDirection(event, preview.images.length);
            if (direction === null) return;
            event.preventDefault();
            event.stopPropagation();
            navigateImage(direction);
          }}
        >
          <ExpandedImageStage preview={preview} onClose={onClose} onNavigate={navigateImage} />
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
});

function ExpandedImageStage({
  preview,
  onClose,
  onNavigate,
  contained = false,
}: {
  preview: ExpandedImagePreview;
  onClose: () => void;
  onNavigate: (direction: -1 | 1) => void;
  contained?: boolean;
}) {
  const item = preview.images[preview.index];
  if (!item) return null;
  return (
    <>
      <button
        type="button"
        className="absolute inset-0 z-0 cursor-zoom-out"
        aria-label="Close image preview"
        onClick={onClose}
      />
      {preview.images.length > 1 && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute left-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:left-6"
          aria-label="Previous image"
          onClick={() => onNavigate(-1)}
        >
          <ChevronLeftIcon className="size-5" />
        </Button>
      )}
      <div
        className={`relative isolate z-10 ${contained ? "min-h-0 min-w-0 max-h-full max-w-full" : "max-h-[92vh] max-w-[92vw]"}`}
      >
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="absolute right-2 top-2 z-20"
          onClick={onClose}
          aria-label="Close image preview"
        >
          <XIcon />
        </Button>
        <ExpandedImageContent
          image={item}
          {...(contained
            ? { className: "mx-auto max-h-[calc(100cqh-1.5rem)] max-w-[100cqw]" }
            : {})}
        />
        <p
          className={`mt-2 ${contained ? "max-w-full" : "max-w-[92vw]"} truncate text-center text-xs text-muted-foreground/80`}
        >
          {item.name}
          {preview.images.length > 1 ? ` (${preview.index + 1}/${preview.images.length})` : ""}
        </p>
      </div>
      {preview.images.length > 1 && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute right-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:right-6"
          aria-label="Next image"
          onClick={() => onNavigate(1)}
        >
          <ChevronRightIcon className="size-5" />
        </Button>
      )}
    </>
  );
}

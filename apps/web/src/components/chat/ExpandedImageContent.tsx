import { useState } from "react";
import type { ExpandedImageItem } from "./ExpandedImagePreview";

/** Shared image presentation for message expansion and the thread gallery. */
export function ExpandedImageContent({
  image,
  className = "max-h-[86vh] max-w-[92vw]",
}: {
  image: ExpandedImageItem;
  className?: string;
}) {
  const [failedSource, setFailedSource] = useState<string>();
  return failedSource === image.src ? (
    <p role="status" className="p-6 text-sm text-muted-foreground">
      Could not display this image. Download it to open it.
    </p>
  ) : (
    <img
      src={image.src}
      alt={image.name}
      {...(image.width !== undefined && image.height !== undefined
        ? { width: image.width, height: image.height }
        : {})}
      onError={() => setFailedSource(image.src)}
      className={`h-auto w-auto select-none rounded-lg border border-border/70 bg-background object-contain shadow-2xl ${className}`}
      draggable={false}
    />
  );
}

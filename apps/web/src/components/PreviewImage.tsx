import type { EnvironmentId } from "@ryco/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { ensureEnvironmentApi } from "../environmentApi";
import { errorMessage } from "../lib/errorMessage";
import { DiffPanelLoadingState } from "./DiffPanelShell";
import {
  decodeBase64Bytes,
  isInertRasterImageMimeType,
  previewSvgDataUrl,
  type PreviewImageSource,
} from "./PreviewPanel.logic";

type PreviewImageState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly url: string }
  | { readonly status: "error"; readonly message: string };

const LOADING: PreviewImageState = { status: "loading" };

interface PreviewImageInput {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly relativePath: string;
  readonly source: PreviewImageSource;
  /** SVG source from the regular text read; unused for raster images. */
  readonly svgContents: string | undefined;
  /** Changes when the agent touched the file, so the image is read again. */
  readonly refreshKey: string | null;
}

/**
 * Raster bytes come from the binary read and render through an object URL,
 * which avoids building (and keeping) a multi-megabyte data: URL string. Each
 * URL is revoked once it is replaced or the preview unmounts.
 */
function useRasterPreviewImageUrl(input: PreviewImageInput): PreviewImageState {
  const { environmentId, cwd, relativePath, source, refreshKey } = input;
  const requestKey = JSON.stringify([environmentId, cwd, relativePath]);
  const [state, setState] = useState<{ key: string; image: PreviewImageState } | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (source !== "raster" || !environmentId || !cwd) {
      return;
    }
    let active = true;
    void Promise.resolve()
      .then(() =>
        ensureEnvironmentApi(environmentId).projects.readFileBinary({ cwd, relativePath }),
      )
      .then((result) => {
        if (!active) return;
        if (!isInertRasterImageMimeType(result.mimeType)) {
          throw new Error("Not a supported image.");
        }
        const url = URL.createObjectURL(
          new Blob([decodeBase64Bytes(result.dataBase64)], { type: result.mimeType }),
        );
        const previous = objectUrlRef.current;
        objectUrlRef.current = url;
        setState({ key: requestKey, image: { status: "ready", url } });
        // An already decoded <img> keeps rendering after its URL is revoked.
        if (previous) URL.revokeObjectURL(previous);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setState({
          key: requestKey,
          image: { status: "error", message: errorMessage(error, "Couldn’t load this image.") },
        });
      });
    return () => {
      active = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- a new refresh key re-reads the image
  }, [cwd, environmentId, refreshKey, relativePath, requestKey, source]);

  useEffect(
    () => () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    },
    [],
  );

  return state?.key === requestKey ? state.image : LOADING;
}

/**
 * SVG markup comes from the text read and renders from a `data:` URL, never a
 * same-origin `blob:` one: opened in its own tab, a blob SVG would run its
 * scripts with the app's origin.
 */
function usePreviewImageUrl(input: PreviewImageInput): PreviewImageState {
  const raster = useRasterPreviewImageUrl(input);
  const { source, svgContents } = input;
  const svgUrl = useMemo(
    () => (source === "svg" && svgContents !== undefined ? previewSvgDataUrl(svgContents) : null),
    [source, svgContents],
  );
  if (source === "raster") return raster;
  return svgUrl === null ? LOADING : { status: "ready", url: svgUrl };
}

export function PreviewImage(props: PreviewImageInput) {
  const image = usePreviewImageUrl(props);
  if (image.status === "loading") {
    return <DiffPanelLoadingState label="Loading image..." />;
  }
  if (image.status === "error") {
    return (
      <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
        {image.message}
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 justify-center overflow-auto bg-background/70 p-3">
      <img
        alt={props.relativePath}
        className="max-h-full max-w-full object-contain"
        decoding="async"
        draggable={false}
        src={image.url}
      />
    </div>
  );
}

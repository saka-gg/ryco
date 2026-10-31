export interface NodeBrowserPainter {
  readonly paint: (jpeg: Uint8Array) => void;
  readonly stop: () => void;
}

/**
 * Paints frames onto a canvas: one decode at a time, drawn on the next
 * animation frame. A frame that arrives while one is decoding waits, and a
 * newer one replaces it, so a slow device shows the latest picture instead
 * of falling behind.
 */
export function createNodeBrowserPainter(
  canvas: HTMLCanvasElement,
  onPainted?: () => void,
): NodeBrowserPainter {
  const context = canvas.getContext("2d");
  let stopped = false;
  let decoding = false;
  let waiting: Uint8Array | null = null;
  let decoded: ImageBitmap | null = null;
  let frame: number | null = null;

  const draw = () => {
    frame = null;
    const bitmap = decoded;
    decoded = null;
    if (!bitmap) return;
    if (stopped || !context) {
      bitmap.close();
      return;
    }
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
    }
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    onPainted?.();
  };

  const decode = (jpeg: Uint8Array) => {
    decoding = true;
    void createImageBitmap(new Blob([jpeg as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }))
      .then((bitmap) => {
        if (stopped) {
          bitmap.close();
          return;
        }
        decoded?.close();
        decoded = bitmap;
        frame ??= requestAnimationFrame(draw);
      })
      .catch(() => undefined)
      .finally(() => {
        decoding = false;
        const next = waiting;
        waiting = null;
        if (next && !stopped) decode(next);
      });
  };

  return {
    paint: (jpeg) => {
      if (stopped) return;
      if (decoding) waiting = jpeg;
      else decode(jpeg);
    },
    stop: () => {
      stopped = true;
      waiting = null;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      decoded?.close();
      decoded = null;
    },
  };
}

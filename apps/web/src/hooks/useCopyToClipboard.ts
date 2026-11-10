import * as React from "react";

export function useCopyToClipboard<TContext = void>({
  timeout = 2000,
  onCopy,
  onError,
}: {
  timeout?: number;
  onCopy?: (ctx: TContext) => void;
  onError?: (error: Error, ctx: TContext) => void;
} = {}): {
  /** Copies `value`; a promise is the text still being read (see {@link writeClipboardText}). */
  copyToClipboard: (value: string | Promise<string>, ctx: TContext) => void;
  isCopied: boolean;
} {
  const [isCopied, setIsCopied] = React.useState(false);
  const timeoutIdRef = React.useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const onCopyRef = React.useRef(onCopy);
  const onErrorRef = React.useRef(onError);
  const timeoutRef = React.useRef(timeout);

  onCopyRef.current = onCopy;
  onErrorRef.current = onError;
  timeoutRef.current = timeout;

  const copyToClipboard = React.useCallback(
    (value: string | Promise<string>, ctx: TContext): void => {
      if (typeof window === "undefined" || !navigator.clipboard?.writeText) {
        onErrorRef.current?.(new Error("Clipboard API unavailable."), ctx);
        return;
      }

      if (!value) return;

      writeClipboardText(value).then(
        () => {
          if (timeoutIdRef.current) {
            clearTimeout(timeoutIdRef.current);
          }
          setIsCopied(true);

          onCopyRef.current?.(ctx);

          if (timeoutRef.current !== 0) {
            timeoutIdRef.current = setTimeout(() => {
              setIsCopied(false);
              timeoutIdRef.current = null;
            }, timeoutRef.current);
          }
        },
        (error) => {
          if (onErrorRef.current) {
            onErrorRef.current(error, ctx);
          } else {
            console.error(error);
          }
        },
      );
    },
    [],
  );

  // Cleanup timeout on unmount
  React.useEffect(() => {
    return (): void => {
      if (timeoutIdRef.current) {
        clearTimeout(timeoutIdRef.current);
      }
    };
  }, []);

  return { copyToClipboard, isCopied };
}

/**
 * Writes text to the clipboard. Text still being read (a promise) goes in a
 * `ClipboardItem` holding that promise: Safari lets a click write the
 * clipboard only while the click is handled, and a pending item keeps that
 * permission across the read. Where that is unavailable or refused, the text
 * is written once read. Rejects when the read or the write fails.
 */
export async function writeClipboardText(value: string | Promise<string>): Promise<void> {
  if (typeof value === "string") return navigator.clipboard.writeText(value);
  if (typeof ClipboardItem !== "undefined" && typeof navigator.clipboard.write === "function") {
    try {
      const blob = value.then((text) => new Blob([text], { type: "text/plain" }));
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
      return;
    } catch {
      // Fall through: a failed read rejects again below, with its own error.
    }
  }
  const text = await value;
  await navigator.clipboard.writeText(text);
}

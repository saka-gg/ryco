import { useCallback, useState } from "react";

import { Button } from "./ui/button";

/**
 * A key that changes on every retry: a preview keyed by it remounts and reads
 * its file again, dropping whatever the failed read left behind.
 */
export function usePreviewRetryKey(): readonly [key: number, retry: () => void] {
  const [key, setKey] = useState(0);
  const retry = useCallback(() => setKey((current) => current + 1), []);
  return [key, retry];
}

/**
 * A preview whose read failed. Most failures pass (a dropped or replaced
 * connection, a file that changed mid-read), so it offers to read again in
 * place instead of making the user open another file and come back.
 */
export function PreviewReadFailure(props: {
  readonly message: string;
  readonly onRetry: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-5 text-center text-xs text-muted-foreground/70">
      <span>{props.message}</span>
      <Button onClick={props.onRetry} size="xs" variant="outline">
        Try again
      </Button>
    </div>
  );
}

/** Keep Electron alive until its owned backend has exited or been force-stopped. */
export function createQuitCleanupHandler(options: {
  readonly cleanup: () => Promise<void> | undefined;
  readonly quit: () => void;
}): (event: { preventDefault: () => void }) => void {
  let started = false;
  let complete = false;
  return (event) => {
    if (complete) return;
    if (started) {
      event.preventDefault();
      return;
    }
    started = true;
    const pending = options.cleanup();
    if (pending === undefined) {
      complete = true;
      return;
    }
    event.preventDefault();
    void pending
      .catch(() => undefined)
      .then(() => {
        complete = true;
        options.quit();
      });
  };
}

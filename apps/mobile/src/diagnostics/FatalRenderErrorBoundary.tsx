import { Component, type ReactNode } from "react";

import { recordRenderCrash } from "./fatalErrorRecorder";
import { fatalErrorFileStore } from "./fatalErrorStore";

/**
 * Records a crash during rendering. React reports those to React Native directly, never through
 * the global handler the recorder wraps. Mounted around the whole app; it has no fallback: it
 * writes the record and throws the error on, so the app fails exactly as it would without it
 * (`recordRenderCrash`).
 */
export class FatalRenderErrorBoundary extends Component<{ readonly children: ReactNode }> {
  override componentDidCatch(error: unknown): void {
    recordRenderCrash(fatalErrorFileStore, error);
  }

  override render(): ReactNode {
    return this.props.children;
  }
}

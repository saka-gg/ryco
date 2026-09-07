import { lazy, Suspense } from "react";
import type { BrowserProject } from "./BrowserPanel";
const Panel = lazy(() =>
  import("./BrowserPanel").then((module) => ({ default: module.BrowserPanel })),
);
export function LazyBrowserPanel(props: BrowserProject) {
  return (
    <Suspense
      fallback={
        <p role="status" className="p-4 text-sm text-muted-foreground">
          Loading browser…
        </p>
      }
    >
      <Panel {...props} />
    </Suspense>
  );
}

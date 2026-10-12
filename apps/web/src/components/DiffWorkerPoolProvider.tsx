import { WorkerPoolContext, useWorkerPool } from "@pierre/diffs/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTheme } from "../hooks/useTheme";
import { resolveDiffThemeName, type DiffThemeName } from "../lib/diffRendering";
import { acquireDiffWorkerPool, getDiffWorkerPool } from "../lib/diffWorkerPool";

function DiffWorkerThemeSync({ themeName }: { themeName: DiffThemeName }) {
  const workerPool = useWorkerPool();

  useEffect(() => {
    if (!workerPool) {
      return;
    }

    const current = workerPool.getDiffRenderOptions();
    if (current.theme === themeName) {
      return;
    }

    void workerPool
      .setRenderOptions({
        ...current,
        theme: themeName,
      })
      .catch(() => undefined);
  }, [themeName, workerPool]);

  return null;
}

/**
 * Provides the shared diff highlight pool to `@pierre/diffs` components.
 *
 * Mount it only around surfaces that actually highlight through the pool
 * (review diffs, pull request files, read-only file previews): the pool and
 * its workers start on first use and outlive this provider for an idle grace
 * period, so reopening a diff reuses warm grammars and highlight caches.
 */
export function DiffWorkerPoolProvider({ children }: { children?: ReactNode }) {
  const { resolvedTheme } = useTheme();
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  const initialThemeNameRef = useRef(diffThemeName);
  // Components read the pool during their first render, so it is resolved
  // here rather than in the lease effect. An uncommitted render leaves an
  // unleased pool, which the owner retires after its idle grace.
  const [pool, setPool] = useState(() =>
    typeof window === "undefined" ? undefined : getDiffWorkerPool(diffThemeName),
  );

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const lease = acquireDiffWorkerPool(initialThemeNameRef.current);
    // The pool may have been retired between render and commit.
    setPool((current) => (current === lease.pool ? current : lease.pool));
    return lease.release;
  }, []);

  return (
    <WorkerPoolContext.Provider value={pool}>
      <DiffWorkerThemeSync themeName={diffThemeName} />
      {children}
    </WorkerPoolContext.Provider>
  );
}

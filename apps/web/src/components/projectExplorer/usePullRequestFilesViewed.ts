import type { EnvironmentId } from "@ryco/contracts";
import { createPullRequestReviewController } from "@ryco/client-runtime/state/pull-request-review";
import { useEffect, useRef, useState } from "react";
import { requireEnvironmentConnection } from "~/environments/runtime";
import { useSettings } from "~/hooks/useSettings";
import { webAppLifecycle } from "~/platform/appLifecycle";
import {
  resolveSourceControlFailureDelay,
  resolveSourceControlRefreshDelay,
} from "~/rpc/sourceControlRefreshPolicy";

type Controller = ReturnType<typeof createPullRequestReviewController>;
type Snapshot = ReturnType<Controller["getSnapshot"]>;
const EMPTY: Snapshot = { data: null, error: null, pendingPaths: new Set(), isLoading: false };

export function usePullRequestFilesViewed(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  reference: string;
  headSha: string | null;
  active: boolean;
}) {
  const { environmentId, cwd, reference, headSha, active } = input;
  const mode = useSettings((settings) => settings.sourceControlRefreshMode);
  const key = JSON.stringify([environmentId, cwd, reference, headSha, active, mode]);
  const current = useRef<{ key: string; controller: Controller } | null>(null);
  const [state, setState] = useState<{ key: string; snapshot: Snapshot } | null>(null);

  useEffect(() => {
    if (!active || !environmentId || !cwd) return;
    const controller = createPullRequestReviewController({
      read: () =>
        requireEnvironmentConnection(
          environmentId,
        ).client.sourceControl.getChangeRequestFilesViewed({ cwd, reference }),
      write: (payload) => {
        if (!headSha || payload.expectedHeadSha !== headSha) {
          return Promise.reject(
            new Error("The pull request changed. Refresh the files before marking them viewed."),
          );
        }
        return requireEnvironmentConnection(
          environmentId,
        ).client.sourceControl.setChangeRequestFileViewed({ cwd, reference, ...payload });
      },
    });
    current.current = { key, controller };
    const unsubscribe = controller.subscribe(() =>
      setState({ key, snapshot: controller.getSnapshot() }),
    );
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let refreshing = false;
    const refresh = async () => {
      if (stopped || refreshing) return;
      clearTimeout(timer);
      refreshing = true;
      if (webAppLifecycle.isForeground() && webAppLifecycle.isOnline()) {
        await controller.refresh();
        failures = controller.getSnapshot().error ? failures + 1 : 0;
      }
      refreshing = false;
      const delay =
        controller.getSnapshot().data?.capability.storage === "unsupported"
          ? false
          : resolveSourceControlRefreshDelay({ mode, phase: "active" });
      if (!stopped && delay !== false) {
        timer = setTimeout(
          () => void refresh(),
          resolveSourceControlFailureDelay({ baseDelayMs: delay, consecutiveFailures: failures }),
        );
      }
    };
    void refresh();
    const unsubscribeLifecycle = webAppLifecycle.subscribe((event) => {
      if (mode !== "manual" && (event === "foreground" || event === "online" || event === "resume"))
        void refresh();
    });
    return () => {
      stopped = true;
      clearTimeout(timer);
      unsubscribeLifecycle();
      unsubscribe();
      controller.dispose();
      if (current.current?.controller === controller) current.current = null;
    };
  }, [active, cwd, environmentId, headSha, key, mode, reference]);

  return {
    ...(state?.key === key ? state.snapshot : EMPTY),
    refresh: () =>
      current.current?.key === key ? current.current.controller.refresh() : Promise.resolve(),
    setViewed: (path: string, viewed: boolean) =>
      current.current?.key === key
        ? current.current.controller.setViewed(path, viewed)
        : Promise.resolve(),
  };
}

import { createPullRequestReviewController } from "@ryco/client-runtime/state/pull-request-review";
import type { EnvironmentId } from "@ryco/contracts";
import { useEffect, useRef, useState } from "react";

import { readRpcClient } from "../../connection/environmentApi";
import { mobileAppLifecycle } from "../../platform/appLifecycle";

type Controller = ReturnType<typeof createPullRequestReviewController>;
export type PullRequestFilesViewedSnapshot = ReturnType<Controller["getSnapshot"]>;

const EMPTY: PullRequestFilesViewedSnapshot = {
  data: null,
  error: null,
  pendingPaths: new Set(),
  isLoading: false,
};

const OFFLINE = "This node is not connected. Reconnect to it to mark files viewed.";

function sourceControl(environmentId: EnvironmentId) {
  const client = readRpcClient(environmentId);
  if (client === null) throw new Error(OFFLINE);
  return client.sourceControl;
}

export interface PullRequestFilesViewed extends PullRequestFilesViewedSnapshot {
  readonly refresh: () => Promise<void>;
  readonly setViewed: (path: string, viewed: boolean) => Promise<void>;
}

/**
 * Which files of a pull request the viewer marked viewed, kept on the host
 * (GitHub's own "Viewed" boxes) through the shared review controller, so the
 * phone, the web and github.com agree. Read when the screen opens and again
 * each time the app returns to the foreground.
 */
export function usePullRequestFilesViewed(input: {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly number: number | null;
  readonly headSha: string | null;
  readonly active: boolean;
}): PullRequestFilesViewed {
  const { environmentId, cwd, number, headSha, active } = input;
  const key = JSON.stringify([environmentId, cwd, number, headSha, active]);
  const current = useRef<{ key: string; controller: Controller } | null>(null);
  const [state, setState] = useState<{
    key: string;
    snapshot: PullRequestFilesViewedSnapshot;
  } | null>(null);

  useEffect(() => {
    if (!active || environmentId === null || cwd === null || number === null) return;
    const reference = String(number);
    const controller = createPullRequestReviewController({
      read: () => sourceControl(environmentId).getChangeRequestFilesViewed({ cwd, reference }),
      write: (payload) => {
        if (headSha === null || payload.expectedHeadSha !== headSha) {
          return Promise.reject(
            new Error("The pull request changed. Refresh the files before marking them viewed."),
          );
        }
        return sourceControl(environmentId).setChangeRequestFileViewed({
          cwd,
          reference,
          ...payload,
        });
      },
    });
    current.current = { key, controller };
    const unsubscribe = controller.subscribe(() =>
      setState({ key, snapshot: controller.getSnapshot() }),
    );
    void controller.refresh();
    const unsubscribeLifecycle = mobileAppLifecycle.subscribe((event) => {
      if (event === "foreground" || event === "online") void controller.refresh();
    });
    return () => {
      unsubscribeLifecycle();
      unsubscribe();
      controller.dispose();
      if (current.current?.controller === controller) current.current = null;
    };
  }, [active, cwd, environmentId, headSha, key, number]);

  return {
    ...(state?.key === key ? state.snapshot : EMPTY),
    refresh: () =>
      current.current?.key === key ? current.current.controller.refresh() : Promise.resolve(),
    setViewed: (path, viewed) =>
      current.current?.key === key
        ? current.current.controller.setViewed(path, viewed)
        : Promise.resolve(),
  };
}

import { scopeThreadRef, scopedThreadKey } from "@ryco/client-runtime/scoped";
import { ensureDeviceRuntime, useDeviceStateStore } from "@ryco/client-runtime/state/device";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { useEffect, useMemo } from "react";

import { useEnvironmentApi } from "../../connection/useEnvironmentApi";
import { threadDevicePreview } from "./deviceViewerModel";

/**
 * Reads already made, by environment, thread and connection generation. Reading a thread's
 * device state lists the node's simulators, so a thread is read once per connection, and not at
 * all on a node that said it has no device support; later changes arrive on the event stream.
 */
const readThreads = new Set<string>();
const unsupportedEnvironments = new Set<string>();
const readKey = (environmentId: EnvironmentId, generation: number, threadId?: ThreadId) =>
  JSON.stringify([environmentId, generation, threadId ?? null]);

/**
 * The device a thread's agent uses, kept current while a surface shows it: retains the
 * environment's device event stream (`ensureDeviceRuntime`) and reads the thread's device state
 * once per connection generation (see `readThreads`).
 */
export function useThreadDevice(environmentId: EnvironmentId, threadId: ThreadId) {
  const api = useEnvironmentApi(environmentId)?.device;
  useEffect(() => ensureDeviceRuntime(environmentId), [environmentId]);
  const generation = useDeviceStateStore(
    (state) => state.environmentById[environmentId]?.generation ?? null,
  );
  useEffect(() => {
    if (!api || generation === null) return;
    const threadKey = readKey(environmentId, generation, threadId);
    if (
      readThreads.has(threadKey) ||
      unsupportedEnvironments.has(readKey(environmentId, generation))
    )
      return;
    readThreads.add(threadKey);
    void api
      .getThreadState({ threadId })
      .then((snapshot) => {
        if (snapshot.availability.kind === "unsupported-platform")
          unsupportedEnvironments.add(readKey(environmentId, generation));
        useDeviceStateStore.getState().applyThreadSnapshot(environmentId, generation, snapshot);
      })
      // A failed read may be retried by the next surface that shows the thread.
      .catch(() => readThreads.delete(threadKey));
  }, [api, environmentId, generation, threadId]);
  const threadState = useDeviceStateStore(
    (state) => state.threadByKey[scopedThreadKey(scopeThreadRef(environmentId, threadId))],
  );
  const preview = useMemo(() => threadDevicePreview(threadState), [threadState]);
  return { api, preview };
}

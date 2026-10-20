import { EnvironmentId } from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import {
  getHostedEnvironmentSessions,
  hostedHubController,
  useHostedHubStore,
} from "../../hostedHub/state";
import { useHostedBrowserLifecycle } from "../../hostedHub/useHostedBrowserLifecycle";
import type { HostedHubNode } from "../../hostedHub/types";

function Lifecycle() {
  useHostedBrowserLifecycle();
  return null;
}
let mounted: Awaited<ReturnType<typeof render>> | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  hostedHubController.resetForTests();
  getHostedEnvironmentSessions().clear();
  vi.restoreAllMocks();
});

describe("persistent hosted browser lifecycle", () => {
  it.each(["current", "synchronizing"] as const)(
    "retains the %s relay generation across a plain hidden/visible round trip",
    async (browserStatus) => {
      const node = {
        id: "node-a",
        environmentId: EnvironmentId.make("environment-a"),
        presence: { online: true, lastHeartbeatAt: 1 },
        effectiveRole: "owner",
      } as HostedHubNode;
      hostedHubController.resetForTests();
      // The shared session fields show the selected environment's own record:
      // online, and established unless its session is still synchronizing.
      const sessions = getHostedEnvironmentSessions();
      const { generation } = sessions.ensureRecord(node);
      sessions.markConnectRequested(node.environmentId, generation);
      sessions.transportStatus(node.environmentId, generation, "online");
      if (browserStatus === "current") sessions.markSessionReady(node.environmentId, generation);
      useHostedHubStore.setState({
        accountStatus: "authenticated",
        directoryStatus: "ready",
        browserStatus,
        selectedNode: node,
        nodes: [node],
        generation: 42,
      });
      const resume = vi.spyOn(hostedHubController, "resumeBrowser");
      const suspend = vi.spyOn(hostedHubController, "suspendBrowser");
      const recover = vi.spyOn(hostedHubController, "recoverAfterConnectivity");
      const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      mounted = await render(<Lifecycle />);
      visibility.mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
      expect(suspend).not.toHaveBeenCalled();
      visibility.mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      await expect.poll(() => recover.mock.calls.length).toBe(1);
      expect(resume).not.toHaveBeenCalled();
      expect(useHostedHubStore.getState().generation).toBe(42);
      expect(sessions.read(node.environmentId)?.generation).toBe(generation);
      expect(useHostedHubStore.getState().transportStatus).toBe("online");
      expect(useHostedHubStore.getState().browserStatus).toBe(browserStatus);
    },
  );
});

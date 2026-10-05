import { EnvironmentId } from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { hostedHubController, useHostedHubStore } from "../../hostedHub/state";
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
      useHostedHubStore.setState({
        accountStatus: "authenticated",
        directoryStatus: "ready",
        browserStatus,
        selectedNode: node,
        nodes: [node],
        transportStatus: "online",
        generation: 42,
        sessionStatus: browserStatus === "current" ? "ready" : "synchronizing",
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
      expect(useHostedHubStore.getState().transportStatus).toBe("online");
      expect(useHostedHubStore.getState().browserStatus).toBe(browserStatus);
    },
  );
});

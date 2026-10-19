import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import type { ReactNode } from "react";

const navigate = vi.fn(async () => undefined);
// The shell reads route state that only a `RouterProvider` provides; these
// cases exercise which owners the gate state mounts, not routing.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
  useLocation: ({ select }: { readonly select: (location: { pathname: string }) => unknown }) =>
    select({ pathname: "/" }),
  useParams: () => undefined,
  Outlet: () => null,
}));

const mode = vi.hoisted(() => ({ hosted: true }));
vi.mock("../env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../env")>()),
  readRycoClientMode: () => (mode.hosted ? ("hosted-hub" as const) : ("standard" as const)),
  isHostedHubMode: () => mode.hosted,
}));

// Every owner whose mounting is the subject is replaced by a marker that records
// how it was mounted; the rest of the workspace is not under test here.
const coordinatorMounts = vi.hoisted(() => [] as Array<{ recoveryOwner: string | undefined }>);
vi.mock("./WebSocketConnectionSurface", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./WebSocketConnectionSurface")>()),
  WebSocketConnectionCoordinator: (props: { readonly recoveryOwner?: string }) => {
    coordinatorMounts.push({ recoveryOwner: props.recoveryOwner });
    return <div data-testid="connection-coordinator" data-owner={props.recoveryOwner} />;
  },
}));
vi.mock("./ServerStateBootstrap", () => ({
  ServerStateBootstrap: () => <div data-testid="server-state-bootstrap" />,
}));
vi.mock("./MessageQueueDrainBridge", () => ({
  MessageQueueDrainBridge: () => <div data-testid="message-queue-drain" />,
}));
vi.mock("./ThreadPriorityRefreshBridge", () => ({
  ThreadPriorityRefreshBridge: () => <div data-testid="thread-priority-refresh" />,
}));
vi.mock("./AppSidebarLayout", () => ({
  AppSidebarLayout: ({ children }: { readonly children?: ReactNode }) => (
    <div data-testid="app-sidebar-layout">{children}</div>
  ),
}));
vi.mock("./CommandPalette", () => ({
  CommandPalette: ({ children }: { readonly children?: ReactNode }) => <>{children}</>,
  preloadCommandPaletteDialog: () => Promise.resolve(),
}));
vi.mock("./onboarding/OnboardingCoordinator", () => ({ OnboardingCoordinator: () => null }));
vi.mock("./shell/phone/ContextMenuActionSheetHost", () => ({
  ContextMenuActionSheetHost: () => null,
}));
vi.mock("./desktop/SshPasswordPromptDialog", () => ({ SshPasswordPromptDialog: () => null }));
vi.mock("./worktrees/WorkspaceReviewDialog", () => ({ WorkspaceReviewDialog: () => null }));
vi.mock("./ProviderUpdateLaunchNotification", () => ({
  ProviderUpdateLaunchNotification: () => null,
}));
vi.mock("./automations/MissedAutomationRunsNotice", () => ({
  MissedAutomationRunsNotice: () => null,
}));

import { RootAppShell, type RootAppShellProps } from "./RootAppShell";

type GateStatus = RootAppShellProps["authGateState"]["status"];

let mounted: Awaited<ReturnType<typeof render>> | null = null;

async function mountShell(status: GateStatus) {
  mounted = await render(<RootAppShell authGateState={{ status }} />);
}

const mountedOwners = () => ({
  serverStateBootstrap: document.querySelector('[data-testid="server-state-bootstrap"]') !== null,
  messageQueueDrain: document.querySelector('[data-testid="message-queue-drain"]') !== null,
  coordinatorOwner:
    document.querySelector('[data-testid="connection-coordinator"]')?.getAttribute("data-owner") ??
    null,
});

beforeEach(() => {
  mode.hosted = true;
  coordinatorMounts.length = 0;
  navigate.mockClear();
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("hosted workspace owners by gate state", () => {
  it("runs the config projection and the follow-up queue, and no connection owner, for a cached shell", async () => {
    await mountShell("hosted-cached");

    await expect.element(page.getByTestId("app-sidebar-layout")).toBeInTheDocument();
    expect(mountedOwners()).toEqual({
      serverStateBootstrap: true,
      messageQueueDrain: true,
      coordinatorOwner: null,
    });
    expect(document.querySelector('[data-testid="thread-priority-refresh"]')).toBeNull();
    expect(coordinatorMounts).toEqual([]);
  });

  it("hands connection recovery to the hosted lifecycle for an established shell", async () => {
    await mountShell("hosted-hub");

    await expect.element(page.getByTestId("connection-coordinator")).toBeInTheDocument();
    expect(mountedOwners()).toEqual({
      serverStateBootstrap: true,
      messageQueueDrain: true,
      coordinatorOwner: "hosted-lifecycle",
    });
    expect(document.querySelector('[data-testid="thread-priority-refresh"]')).not.toBeNull();
  });

  it("mounts no connection owner for a static hosted shell", async () => {
    await mountShell("hosted-static");

    await expect.element(page.getByTestId("app-sidebar-layout")).toBeInTheDocument();
    expect(mountedOwners()).toEqual({
      serverStateBootstrap: false,
      messageQueueDrain: true,
      coordinatorOwner: null,
    });
  });

  it("never mounts the generic recovery owner in hosted mode, whatever the gate state", async () => {
    for (const status of [
      "authenticated",
      "hosted-static",
      "hosted-hub",
      "hosted-cached",
    ] as const) {
      await mountShell(status);
      await expect.element(page.getByTestId("app-sidebar-layout")).toBeInTheDocument();
      const owner = mountedOwners().coordinatorOwner;
      expect(owner, status).not.toBe("generic");
      expect(owner === null || owner === "hosted-lifecycle", status).toBe(true);
      await mounted?.unmount();
      mounted = null;
    }
    // Not at any render either, including the ones an unmounted tree never commits.
    expect(coordinatorMounts.length).toBeGreaterThan(0);
    expect(coordinatorMounts.map((mount) => mount.recoveryOwner)).not.toContain("generic");
  });

  it("keeps the workspace and its owners mounted while the gate moves between cached and established", async () => {
    await mountShell("hosted-hub");
    await expect.element(page.getByTestId("app-sidebar-layout")).toBeInTheDocument();
    const layout = page.getByTestId("app-sidebar-layout").element();
    const bootstrap = page.getByTestId("server-state-bootstrap").element();
    const queue = page.getByTestId("message-queue-drain").element();

    await mounted!.rerender(<RootAppShell authGateState={{ status: "hosted-cached" }} />);
    expect(mountedOwners().coordinatorOwner).toBeNull();
    expect(page.getByTestId("app-sidebar-layout").element()).toBe(layout);
    expect(page.getByTestId("server-state-bootstrap").element()).toBe(bootstrap);
    expect(page.getByTestId("message-queue-drain").element()).toBe(queue);

    await mounted!.rerender(<RootAppShell authGateState={{ status: "hosted-hub" }} />);
    expect(mountedOwners().coordinatorOwner).toBe("hosted-lifecycle");
    expect(page.getByTestId("app-sidebar-layout").element()).toBe(layout);
    expect(page.getByTestId("server-state-bootstrap").element()).toBe(bootstrap);
    expect(page.getByTestId("message-queue-drain").element()).toBe(queue);
    expect(coordinatorMounts.map((mount) => mount.recoveryOwner)).not.toContain("generic");
  });

  it("keeps the generic owner for a standard authenticated client", async () => {
    mode.hosted = false;
    await mountShell("authenticated");

    await expect.element(page.getByTestId("connection-coordinator")).toBeInTheDocument();
    expect(mountedOwners().coordinatorOwner).toBe("generic");
  });
});

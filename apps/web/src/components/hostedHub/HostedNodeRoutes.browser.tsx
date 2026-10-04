import "../../index.css";

import { EnvironmentId, ThreadId, OrchestrationShellSnapshot } from "@ryco/contracts";
import { Schema } from "effect";
import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const navigate = vi.fn(async () => undefined);
// These suites render the hosted root outside a `RouterProvider`. The toast
// host the entry surfaces now mount reads route params to scope thread-scoped
// toasts, which is neither what these suites exercise nor reachable here, so
// the read is stubbed alongside the navigation that was already stubbed.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
  useParams: () => undefined,
}));

// Hosted mode, which no browser test gets by default: there is no `.env` in
// this harness, so `isHostedHubMode()` answers false and every hosted gate runs
// as the standard client. See `HostedNodeDirectory.browser.tsx` for the full
// note.
vi.mock("../../env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../env")>()),
  readRycoClientMode: () => "hosted-hub" as const,
  isHostedHubMode: () => true,
}));

vi.mock("../RootAppShell", () => ({
  RootAppShell: ({ authGateState }: { authGateState: { status: string } }) => {
    const environments = useStore((state) => state.environmentStateById);
    return (
      <div data-testid="root-app-shell">
        {authGateState.status}
        {Object.values(environments).flatMap((environment) =>
          Object.values(environment.messageByThreadId ?? {}).flatMap((messages) =>
            Object.values(messages).map((message) => <p key={message.id}>{message.text}</p>),
          ),
        )}
      </div>
    );
  },
}));

import { hostedHubController, useHostedHubStore } from "../../hostedHub/state";
import { navigateHub, resetHubRoutesForTests } from "../../hostedHub/hubRoutes";
import {
  installHostedNodeHistory,
  resetHostedNodeRoutesForTests,
} from "../../hostedHub/nodeRoutes";
import { resetHostedNodeRouteOrchestratorForTests } from "../../hostedHub/nodeRouteOrchestrator";
import type { HostedHubNode } from "../../hostedHub/types";
import { type EnvironmentState, useStore } from "../../store";
import { createFakeHistoryWindow, type FakeHistoryWindow } from "../../../test/fakeHistoryWindow";
import { HostedHubRoot } from "./HostedHubRoot";
import { hostedHubApi, HostedHubApiError } from "../../hostedHub/api";
import { readHostedNodeMutationLease } from "../../hostedHub/hostedConnectionCoordinator";

const account = {
  id: "acct_sensitive-route-browser-canary",
  displayName: "Ada",
  role: "owner" as const,
  createdAt: 1,
  disabledAt: null,
};
const session = {
  id: "sess_sensitive-route-browser-canary",
  accountId: account.id,
  createdAt: 1,
  expiresAt: 2,
  lastSeenAt: 1,
  revokedAt: null,
  revocationReasonCode: null,
};

function node(id: string, online = true): HostedHubNode {
  return {
    id,
    environmentId: EnvironmentId.make(`env_${id.slice(5).padEnd(22, "a").slice(0, 22)}`),
    label: "Studio online",
    platformOs: "linux",
    platformArch: "x64",
    clientVersion: "0.9.0",
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    revokedAt: null,
    revocationReasonCode: null,
    grant: { id: `grant_${id.slice(5)}`, role: "operator" },
    effectiveRole: "operator",
    presence: { online, lastHeartbeatAt: online ? 1 : null },
  };
}

let mounted: Awaited<ReturnType<typeof render>> | null = null;
let fakeWindow: FakeHistoryWindow | null = null;

function installRoute(initialUrl: string): FakeHistoryWindow {
  fakeWindow = createFakeHistoryWindow(initialUrl);
  installHostedNodeHistory(fakeWindow as unknown as Window & typeof globalThis);
  return fakeWindow;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  hostedHubController.resetForTests();
  resetHubRoutesForTests();
  resetHostedNodeRouteOrchestratorForTests();
  resetHostedNodeRoutesForTests();
  navigate.mockClear();
  useStore.setState({ activeEnvironmentId: null, environmentStateById: {} });
  vi.spyOn(hostedHubApi, "readThreadCacheShell").mockRejectedValue(
    new HostedHubApiError("not_found", 404),
  );
  vi.spyOn(hostedHubApi, "readThreadCacheThread").mockRejectedValue(
    new HostedHubApiError("not_found", 404),
  );
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  hostedHubController.resetForTests();
  resetHubRoutesForTests();
  resetHostedNodeRouteOrchestratorForTests();
  resetHostedNodeRoutesForTests();
  fakeWindow = null;
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("hosted node route surfaces", () => {
  it("opens cloud history in a fresh browser while the target Mac is offline", async () => {
    const target = node("node_aaaaaaaaaaaaaaaaaaaaaa", false);
    const threadId = ThreadId.make("cloud-thread");
    const date = "2026-10-04T12:00:00.000Z";
    installRoute(`/node/${target.id}/${target.environmentId}/${threadId}`);
    const snapshot = Schema.decodeUnknownSync(OrchestrationShellSnapshot)({
      snapshotSequence: 1,
      updatedAt: date,
      projects: [
        {
          id: "project-a",
          title: "Project",
          workspaceRoot: "/repo",
          defaultModelSelection: null,
          scripts: [],
          createdAt: date,
          updatedAt: date,
        },
      ],
      worktrees: [],
      threads: [
        {
          id: threadId,
          projectId: "project-a",
          title: "Cloud thread",
          modelSelection: { instanceId: "codex", model: "gpt-5" },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          latestTurn: null,
          createdAt: date,
          updatedAt: date,
          session: null,
          latestUserMessageAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
        },
      ],
    });
    vi.mocked(hostedHubApi.readThreadCacheShell).mockResolvedValue({
      protocolVersion: 1,
      generation: 1,
      revision: 1,
      storedAt: 100,
      snapshot,
    });
    vi.mocked(hostedHubApi.readThreadCacheThread).mockResolvedValue({
      protocolVersion: 1,
      generation: 1,
      revision: 1,
      storedAt: 100,
      threadId,
      snapshot: {
        messages: [
          {
            id: "message-a" as never,
            role: "assistant",
            text: "Cloud history is readable before this Mac reconnects",
            createdAt: date,
          },
        ],
      },
    });
    vi.spyOn(hostedHubController, "selectNode").mockImplementation(async () => {
      useHostedHubStore.setState({
        selectedNode: target,
        selectionStatus: "offline",
        transportStatus: "reconnecting",
        sessionStatus: "synchronizing",
        sessionEstablished: false,
      });
    });
    useHostedHubStore.setState({
      accountStatus: "authenticated",
      account,
      session,
      directoryStatus: "ready",
      nodes: [target],
    });
    expect(useStore.getState().environmentStateById).toEqual({});
    expect(localStorage.getItem("ryco:remember-hosted-browser:v1")).toBeNull();

    mounted = await render(<HostedHubRoot />);

    await expect.element(page.getByTestId("root-app-shell")).toHaveTextContent("hosted-cached");
    await expect
      .element(page.getByText("Cloud history is readable before this Mac reconnects"))
      .toBeVisible();
    expect(useHostedHubStore.getState().sessionEstablished).toBe(false);
    expect(readHostedNodeMutationLease(target.environmentId)).toBeNull();
    expect(fakeWindow!.location.pathname).toBe(
      `/node/${target.id}/${target.environmentId}/${threadId}`,
    );
  });

  it("keeps the exact cached routed thread mounted while its node reconnects", async () => {
    const target = node("node_aaaaaaaaaaaaaaaaaaaaaa");
    const threadId = ThreadId.make("cached-thread");
    installRoute(`/node/${target.id}/${target.environmentId}/${threadId}`);
    const selectNode = vi
      .spyOn(hostedHubController, "selectNode")
      .mockImplementation(async (nodeId: string) => {
        const found = useHostedHubStore.getState().nodes.find((entry) => entry.id === nodeId);
        useHostedHubStore.setState({
          selectedNode: found ?? null,
          selectionStatus: "online",
          sessionStatus: "synchronizing",
          sessionEstablished: false,
        });
      });
    useStore.setState({
      activeEnvironmentId: target.environmentId,
      environmentStateById: {
        [target.environmentId]: {
          threadShellById: { [threadId]: {} },
        } as unknown as EnvironmentState,
      },
    });
    useHostedHubStore.setState({
      accountStatus: "authenticated",
      account,
      session,
      directoryStatus: "ready",
      nodes: [target],
    });

    mounted = await render(<HostedHubRoot />);

    await expect.element(page.getByTestId("root-app-shell")).toHaveTextContent("hosted-cached");
    await expect
      .element(page.getByRole("heading", { name: `Connecting to ${target.label}` }))
      .not.toBeInTheDocument();
    expect(selectNode).toHaveBeenCalledWith(target.id);
  });

  it("keeps a routed node on the blocked restoring surface instead of the directory", async () => {
    const target = node("node_aaaaaaaaaaaaaaaaaaaaaa");
    installRoute(`/node/${target.id}/${target.environmentId}/t_1?workspaceTab=diff`);
    const selectNode = vi
      .spyOn(hostedHubController, "selectNode")
      .mockImplementation(async (nodeId: string) => {
        const found = useHostedHubStore.getState().nodes.find((entry) => entry.id === nodeId);
        useHostedHubStore.setState({
          selectedNode: found ?? null,
          selectionStatus: "online",
          sessionStatus: "synchronizing",
          sessionEstablished: false,
        });
      });
    useHostedHubStore.setState({
      accountStatus: "authenticated",
      account,
      session,
      directoryStatus: "loading",
      nodes: [],
    });
    mounted = await render(<HostedHubRoot />);

    await expect.element(page.getByRole("heading", { name: "Restoring your node" })).toBeVisible();
    await expect.element(page.getByRole("status")).toHaveTextContent(/Checking your access/);
    expect(document.body.textContent).not.toContain("Your nodes");
    expect(selectNode).not.toHaveBeenCalled();

    useHostedHubStore.setState({ directoryStatus: "ready", nodes: [target] });
    await expect
      .element(page.getByRole("heading", { name: `Connecting to ${target.label}` }))
      .toBeVisible();
    expect(selectNode).toHaveBeenCalledWith(target.id);
    // The deep-linked thread and panel URL is untouched by the restore.
    expect(fakeWindow!.location.pathname).toBe(`/node/${target.id}/${target.environmentId}/t_1`);
    expect(fakeWindow!.location.search).toBe("?workspaceTab=diff");
  });

  it("preserves an offline deep link while its bounded session restore recovers", async () => {
    const target = node("node_aaaaaaaaaaaaaaaaaaaaaa", false);
    const threadId = ThreadId.make("t_1");
    installRoute(`/node/${target.id}/${target.environmentId}/${threadId}?workspaceTab=diff`);
    const selectNode = vi
      .spyOn(hostedHubController, "selectNode")
      .mockImplementation(async (nodeId: string) => {
        const found = useHostedHubStore.getState().nodes.find((entry) => entry.id === nodeId);
        useHostedHubStore.setState({
          selectedNode: found ?? null,
          selectionStatus: "offline",
          transportStatus: "reconnecting",
          sessionStatus: "synchronizing",
          sessionEstablished: false,
        });
      });
    useHostedHubStore.setState({
      accountStatus: "authenticated",
      account,
      session,
      directoryStatus: "ready",
      nodes: [target],
    });
    useStore.setState({
      activeEnvironmentId: target.environmentId,
      environmentStateById: {
        [target.environmentId]: {
          threadShellById: { [threadId]: {} },
        } as unknown as EnvironmentState,
      },
    });

    mounted = await render(<HostedHubRoot />);

    // Cached content survives, but the auth gate remains explicitly read-only
    // until the current shell snapshot establishes mutation readiness.
    await expect.element(page.getByTestId("root-app-shell")).toHaveTextContent("hosted-cached");
    expect(selectNode).toHaveBeenCalledWith(target.id);
    expect(fakeWindow!.location.pathname).toBe(
      `/node/${target.id}/${target.environmentId}/${threadId}`,
    );
    expect(fakeWindow!.location.search).toBe("?workspaceTab=diff");

    const recovered = node(target.id, true);
    useHostedHubStore.setState({
      nodes: [recovered],
      selectedNode: recovered,
      selectionStatus: "online",
      transportStatus: "online",
      sessionStatus: "ready",
      sessionEstablished: true,
    });

    await expect.element(page.getByTestId("root-app-shell")).toHaveTextContent("hosted-hub");
    expect(fakeWindow!.location.pathname).toBe(
      `/node/${target.id}/${target.environmentId}/${threadId}`,
    );
    expect(fakeWindow!.location.search).toBe("?workspaceTab=diff");
  });

  it("fails an unknown routed node closed to the directory with a bounded explanation", async () => {
    const other = node("node_bbbbbbbbbbbbbbbbbbbbbb");
    installRoute("/node/node_gone");
    const selectNode = vi.spyOn(hostedHubController, "selectNode").mockResolvedValue();
    useHostedHubStore.setState({
      accountStatus: "authenticated",
      account,
      session,
      directoryStatus: "ready",
      nodes: [other],
    });
    mounted = await render(<HostedHubRoot />);

    await expect.element(page.getByRole("heading", { name: /^Your nodes?$/ })).toBeVisible();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent(/not in your authorized node directory/);
    expect(selectNode).not.toHaveBeenCalled();
    expect(fakeWindow!.location.pathname).toBe("/");
  });

  it("rejects a colliding thread id when the node segment does not own its environment", async () => {
    const first = node("node_aaaaaaaaaaaaaaaaaaaaaa");
    const second = node("node_bbbbbbbbbbbbbbbbbbbbbb");
    installRoute(`/node/${first.id}/${second.environmentId}/same_thread`);
    const selectNode = vi.spyOn(hostedHubController, "selectNode").mockResolvedValue();
    useHostedHubStore.setState({
      accountStatus: "authenticated",
      account,
      session,
      directoryStatus: "ready",
      nodes: [first, second],
    });
    mounted = await render(<HostedHubRoot />);

    await expect.element(page.getByRole("heading", { name: /^Your nodes?$/ })).toBeVisible();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent(/not in your authorized node directory/);
    expect(selectNode).not.toHaveBeenCalled();
  });

  it("normalizes a malformed node route to the directory with a bounded explanation", async () => {
    installRoute("/node/a%20b/env_a/t_1");
    useHostedHubStore.setState({
      accountStatus: "authenticated",
      account,
      session,
      directoryStatus: "ready",
      nodes: [node("node_aaaaaaaaaaaaaaaaaaaaaa")],
    });
    mounted = await render(<HostedHubRoot />);

    await expect.element(page.getByRole("heading", { name: /^Your nodes?$/ })).toBeVisible();
    await expect.element(page.getByRole("alert")).toHaveTextContent(/link is not valid/);
    expect(fakeWindow!.location.pathname).toBe("/");
  });

  it("selects a node by navigating into its node-scoped route", async () => {
    const target = node("node_aaaaaaaaaaaaaaaaaaaaaa");
    installRoute("/nodes");
    navigateHub({ kind: "nodes" }, { replace: true });
    const selectNode = vi
      .spyOn(hostedHubController, "selectNode")
      .mockImplementation(async (nodeId: string) => {
        const found = useHostedHubStore.getState().nodes.find((entry) => entry.id === nodeId);
        useHostedHubStore.setState({
          selectedNode: found ?? null,
          selectionStatus: "online",
          sessionStatus: "synchronizing",
          sessionEstablished: false,
        });
      });
    useHostedHubStore.setState({
      accountStatus: "authenticated",
      account,
      session,
      directoryStatus: "ready",
      nodes: [target],
    });
    mounted = await render(<HostedHubRoot />);

    await page.getByRole("button", { name: /^Studio online/ }).click();
    expect(selectNode).toHaveBeenCalledWith(target.id);
    await expect
      .element(page.getByRole("heading", { name: `Connecting to ${target.label}` }))
      .toBeVisible();
    expect(fakeWindow!.location.pathname).toBe(`/node/${target.id}`);
    expect(fakeWindow!.entries()).toHaveLength(2);
    // Selection is never persisted outside the URL.
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it("returns to the directory when history navigates back from a node route", async () => {
    const target = node("node_aaaaaaaaaaaaaaaaaaaaaa");
    installRoute("/nodes");
    navigateHub({ kind: "nodes" }, { replace: true });
    vi.spyOn(hostedHubController, "selectNode").mockImplementation(async (nodeId: string) => {
      const found = useHostedHubStore.getState().nodes.find((entry) => entry.id === nodeId);
      useHostedHubStore.setState({
        selectedNode: found ?? null,
        selectionStatus: "online",
        sessionStatus: "synchronizing",
        sessionEstablished: false,
      });
    });
    useHostedHubStore.setState({
      accountStatus: "authenticated",
      account,
      session,
      directoryStatus: "ready",
      nodes: [target],
    });
    mounted = await render(<HostedHubRoot />);
    await page.getByRole("button", { name: /^Studio online/ }).click();
    await expect
      .element(page.getByRole("heading", { name: `Connecting to ${target.label}` }))
      .toBeVisible();

    fakeWindow!.history.back();
    await expect.element(page.getByRole("heading", { name: /^Your nodes?$/ })).toBeVisible();
    expect(useHostedHubStore.getState().selectedNode?.id).toBe(target.id);
    expect(useHostedHubStore.getState().selectionStatus).toBe("online");
    expect(fakeWindow!.location.pathname).toBe("/nodes");
  });

  it("keeps session and account material out of the URL, history, and browser storage", async () => {
    const target = node("node_aaaaaaaaaaaaaaaaaaaaaa");
    installRoute("/nodes");
    navigateHub({ kind: "nodes" }, { replace: true });
    vi.spyOn(hostedHubController, "selectNode").mockImplementation(async (nodeId: string) => {
      const found = useHostedHubStore.getState().nodes.find((entry) => entry.id === nodeId);
      useHostedHubStore.setState({
        selectedNode: found ?? null,
        selectionStatus: "online",
        sessionStatus: "synchronizing",
        sessionEstablished: false,
      });
    });
    useHostedHubStore.setState({
      accountStatus: "authenticated",
      account,
      session,
      directoryStatus: "ready",
      nodes: [target],
    });
    mounted = await render(<HostedHubRoot />);
    await page.getByRole("button", { name: /^Studio online/ }).click();
    await expect
      .element(page.getByRole("heading", { name: `Connecting to ${target.label}` }))
      .toBeVisible();

    const serializedEntries = JSON.stringify(fakeWindow!.entries());
    for (const sensitive of ["sensitive-route-browser-canary", account.id, session.id]) {
      expect(fakeWindow!.location.href).not.toContain(sensitive);
      expect(serializedEntries).not.toContain(sensitive);
      expect(location.href).not.toContain(sensitive);
      expect(JSON.stringify(localStorage)).not.toContain(sensitive);
      expect(JSON.stringify(sessionStorage)).not.toContain(sensitive);
    }
  });
});

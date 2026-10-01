import { EnvironmentId, MessageId, ProjectId, ThreadId, WS_METHODS } from "@ryco/contracts";
import type { WorkspaceMetadataSnapshot } from "@ryco/client-runtime/state/workspace";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useEffect } from "react";
import { HostedHubRoot } from "../components/hostedHub/HostedHubRoot";
import { installHostedNodeHistory, resetHostedNodeRoutesForTests } from "../hostedHub/nodeRoutes";

const mountedShell = vi.hoisted(() => ({ count: 0 }));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));
vi.mock("../components/RootAppShell", () => ({
  RootAppShell: ({ authGateState }: { authGateState: { status: string } }) => {
    useEffect(() => {
      mountedShell.count++;
    }, []);
    return (
      <div data-testid="read-shell" data-mode={authGateState.status}>
        <input aria-label="Local draft" defaultValue="Local draft survives connection" />
      </div>
    );
  },
}));
import { getHostedReadVault } from "../persistence/hostedReadVault";
import {
  bootstrapWithHostedReadCache,
  canShowHostedReadPreview,
  readHostedReadCache,
  setHostedReadCacheEnabled,
} from "../hostedHub/readCache";
import { hostedHubController, hostedHubStore } from "../hostedHub/state";
import { useStore, selectThreadByRef } from "../store";
import { useComposerDraftStore } from "../composerDraftStore";
import { scopedThreadKey } from "@ryco/client-runtime/scoped";
import { readHostedThreadScroll } from "../persistence/hostedReadViewState";
import { resolveHostedRpcCapability } from "../hostedHub/capabilities";

describe("hosted conversation cold start", () => {
  it("purges the remembered account when fresh authentication wins the disk-read race", async () => {
    hostedHubController.resetForTests();
    await setHostedReadCacheEnabled(true);
    const vault = getHostedReadVault();
    const owner = (await vault.account("previous-account", true))!;
    await vault.write(owner, "catalog", { nodes: [] });
    await vault.write(owner, "old-environment", { text: "previous account content" });
    localStorage.setItem(
      "ryco:hosted-read-account:v1",
      JSON.stringify({ id: owner.id, epoch: owner.epoch }),
    );
    await bootstrapWithHostedReadCache(async () => {
      hostedHubStore.setState({
        accountStatus: "authenticated",
        account: {
          id: "new-account",
          displayName: "New account",
          role: "operator",
          createdAt: 1,
          disabledAt: null,
        },
      });
    });
    await vi.waitFor(async () => expect(await vault.account(owner.id, false)).toBeNull());
    await vi.waitFor(() => expect(readHostedReadCache().accountId).toBe("new-account"));
    expect(await vault.read(owner, "old-environment")).toBeNull();
    await setHostedReadCacheEnabled(false);
    hostedHubController.resetForTests();
  });
  it("renders saved text before auth, preserves offline reading, and purges on observed expiry", async () => {
    hostedHubController.resetForTests();
    const environmentId = EnvironmentId.make("env_aaaaaaaaaaaaaaaaaaaaaa");
    const threadId = ThreadId.make("remembered-thread");
    const ref = { environmentId, threadId };
    const key = scopedThreadKey(ref);
    const projectId = ProjectId.make("remembered-project");
    const metadata: WorkspaceMetadataSnapshot = {
      schemaVersion: 1,
      environmentId,
      capturedAt: 1,
      projects: [
        {
          environmentId,
          id: projectId,
          name: "Saved project",
          cwd: "/saved",
          repositoryIdentity: null,
          createdAt: null,
          updatedAt: null,
        },
      ],
      worktrees: [],
      threads: [
        {
          environmentId,
          id: threadId,
          projectId,
          worktreeId: null,
          title: "Saved thread",
          createdAt: "2026-10-01T00:00:00Z",
          updatedAt: "2026-10-01T00:00:00Z",
          archivedAt: null,
          snoozedAt: null,
          snoozedUntil: null,
          modelSelection: null,
          providerDriver: null,
          branch: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
          deliveryUnknown: false,
        },
      ],
    };
    await setHostedReadCacheEnabled(true);
    const vault = getHostedReadVault();
    const owner = (await vault.account("remembered-account", true))!;
    await vault.write(owner, "catalog", {
      nodes: [{ nodeId: "node_aaaaaaaaaaaaaaaaaaaaaa", environmentId, label: "Saved Mac" }],
    });
    await vault.write(owner, environmentId, {
      metadata,
      content: {
        [threadId]: {
          messages: [
            {
              id: MessageId.make("saved-message"),
              role: "assistant",
              text: "Available without a network response",
              createdAt: "2026-10-01T00:00:00Z",
              streaming: false,
            },
          ],
        },
      },
      drafts: { [key]: "Unsent text" },
      scroll: { [key]: 240 },
    });
    localStorage.setItem(
      "ryco:hosted-read-account:v1",
      JSON.stringify({ id: owner.id, epoch: owner.epoch }),
    );
    let finishAuth!: () => void;
    const auth = new Promise<void>((resolve) => {
      finishAuth = resolve;
    });
    const started = performance.now();
    await bootstrapWithHostedReadCache(() => auth);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(canShowHostedReadPreview()).toBe(true);
    window.history.replaceState(
      null,
      "",
      `/node/node_aaaaaaaaaaaaaaaaaaaaaa/${environmentId}/${threadId}`,
    );
    installHostedNodeHistory();
    const view = await render(<HostedHubRoot />);
    expect(document.querySelector('[data-testid="read-shell"]')?.getAttribute("data-mode")).toBe(
      "hosted-cached",
    );
    expect(mountedShell.count).toBe(1);
    const editor = document.querySelector("input[aria-label='Local draft']");
    expect(hostedHubStore.getState().accountStatus).toBe("signed-out");
    expect(selectThreadByRef(useStore.getState(), ref)?.messages[0]?.text).toBe(
      "Available without a network response",
    );
    expect(useStore.getState().environmentStateById[environmentId]?.bootstrapComplete).toBe(false);
    expect(useComposerDraftStore.getState().draftsByThreadKey[key]?.prompt).toBe("Unsent text");
    expect(readHostedThreadScroll(key)).toBe(240);
    expect(
      resolveHostedRpcCapability({
        hosted: true,
        role: null,
        fresh: false,
        browserCurrent: false,
        sessionReady: false,
        method: WS_METHODS.terminalWrite,
      }).allowed,
    ).toBe(false);
    hostedHubStore.setState({ accountStatus: "unavailable" });
    finishAuth();
    await vi.waitFor(() => expect(canShowHostedReadPreview()).toBe(true));
    expect(selectThreadByRef(useStore.getState(), ref)?.messages).toHaveLength(1);
    const node = {
      id: "node_aaaaaaaaaaaaaaaaaaaaaa",
      environmentId,
      label: "Saved Mac",
      platformOs: "darwin" as const,
      platformArch: "arm64" as const,
      clientVersion: "1",
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1,
      revokedAt: null,
      revocationReasonCode: null,
      grant: { id: "grant", role: "operator" as const },
      effectiveRole: "operator" as const,
      presence: { online: true, lastHeartbeatAt: 1 },
    };
    hostedHubStore.setState({
      accountStatus: "authenticated",
      account: {
        id: owner.id,
        displayName: "Saved account",
        role: "operator",
        createdAt: 1,
        disabledAt: null,
      },
      nodes: [node],
      selectedNode: node,
      directoryStatus: "ready",
      sessionEstablished: true,
      sessionStatus: "ready",
      transportStatus: "online",
    });
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="read-shell"]')?.getAttribute("data-mode")).toBe(
        "hosted-hub",
      ),
    );
    expect(document.querySelector("input[aria-label='Local draft']")).toBe(editor);
    expect(mountedShell.count).toBe(1);
    hostedHubStore.setState({
      accountStatus: "unavailable",
      account: null,
      nodes: [],
      directoryStatus: "idle",
      sessionEstablished: false,
    });
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="read-shell"]')?.getAttribute("data-mode")).toBe(
        "hosted-cached",
      ),
    );
    expect(selectThreadByRef(useStore.getState(), ref)?.messages).toHaveLength(1);
    expect(document.querySelector("input[aria-label='Local draft']")).toBe(editor);
    await view.unmount();
    hostedHubStore.setState({ accountStatus: "session-expired" });
    expect(canShowHostedReadPreview()).toBe(false);
    await vi.waitFor(() => expect(readHostedReadCache().accountId).toBeNull());
    await vi.waitFor(async () => expect(await vault.account(owner.id, false)).toBeNull());
    expect(selectThreadByRef(useStore.getState(), ref)).toBeUndefined();
    expect(useComposerDraftStore.getState().draftsByThreadKey[key]).toBeUndefined();
    await vault.write(owner, environmentId, { text: "late write" });
    expect(await vault.read(owner, environmentId)).toBeNull();
    await setHostedReadCacheEnabled(false);
    resetHostedNodeRoutesForTests();
    window.history.replaceState(null, "", "/");
    hostedHubController.resetForTests();
  });
});

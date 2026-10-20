import { EnvironmentId, MessageId, ProjectId, ThreadId, TurnId, WS_METHODS } from "@ryco/contracts";
import type { ChatMessage } from "@ryco/client-runtime/state/threads";
import type { WorkspaceMetadataSnapshot } from "@ryco/client-runtime/state/workspace";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useEffect } from "react";
import { HostedHubRoot } from "../components/hostedHub/HostedHubRoot";
import { preloadHostedRootAppShell } from "../components/hostedHub/hostedRootAppShell";
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
import {
  getHostedEnvironmentSessions,
  hostedHubController,
  hostedHubStore,
} from "../hostedHub/state";
import { useStore, selectThreadByRef } from "../store";
import { useComposerDraftStore } from "../composerDraftStore";
import { useUiStateStore } from "../uiStateStore";
import { scopedThreadKey } from "@ryco/client-runtime/scoped";
import { readHostedThreadScroll, saveHostedThreadScroll } from "../persistence/hostedReadViewState";
import { workspaceMetadataToCachedShellSnapshot } from "../workspaceMetadataProjection";
import { resolveHostedRpcCapability } from "../hostedHub/capabilities";

interface FixtureThread {
  readonly id: ThreadId;
  readonly messages: ReadonlyArray<ChatMessage>;
}

const fixtureMessage = (
  name: string,
  text: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage => ({
  id: MessageId.make(name),
  role: "assistant",
  text,
  createdAt: "2026-10-01T00:00:00Z",
  streaming: false,
  ...extra,
});

/** A live environment whose threads hold the given saved messages, on a node the account can see. */
function seedCachedWorkspace(letter: string, threads: ReadonlyArray<FixtureThread>) {
  const environmentId = EnvironmentId.make(`env_${letter.repeat(22)}`);
  const projectId = ProjectId.make(`project-${letter}`);
  const metadata: WorkspaceMetadataSnapshot = {
    schemaVersion: 1,
    environmentId,
    capturedAt: 1,
    projects: [
      {
        environmentId,
        id: projectId,
        name: `Project ${letter}`,
        cwd: `/${letter}`,
        repositoryIdentity: null,
        createdAt: null,
        updatedAt: null,
      },
    ],
    worktrees: [],
    threads: threads.map(({ id }) => ({
      environmentId,
      id,
      projectId,
      worktreeId: null,
      title: `Thread ${id}`,
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
    })),
  };
  const shell = workspaceMetadataToCachedShellSnapshot(metadata);
  useStore.getState().hydrateEnvironmentStateFromCache(
    {
      ...shell,
      threads: shell.threads.map((thread) => {
        const messages = threads.find(({ id }) => id === thread.shell.id)?.messages ?? [];
        return messages.length > 0 ? Object.assign(thread, { content: { messages } }) : thread;
      }),
    },
    environmentId,
  );
  // Live, as after the node's shell snapshot: the cache saves live state only.
  useStore.setState((state) => ({
    environmentStateById: {
      ...state.environmentStateById,
      [environmentId]: { ...state.environmentStateById[environmentId]!, bootstrapComplete: true },
    },
  }));
  return {
    environmentId,
    node: {
      id: `node_${letter.repeat(22)}`,
      environmentId,
      label: `Mac ${letter}`,
      platformOs: "darwin" as const,
      platformArch: "arm64" as const,
      clientVersion: "1",
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1,
      revokedAt: null,
      revocationReasonCode: null,
      grant: { id: `grant-${letter}`, role: "operator" as const },
      effectiveRole: "operator" as const,
      presence: { online: true, lastHeartbeatAt: 1 },
    },
  };
}

/** Boots the cache as an authenticated account that sees `node`. */
const bootstrapAuthenticatedFixture = (
  accountId: string,
  node: ReturnType<typeof seedCachedWorkspace>["node"],
) =>
  bootstrapWithHostedReadCache(async () => {
    hostedHubStore.setState({
      accountStatus: "authenticated",
      account: {
        id: accountId,
        displayName: "Fixture account",
        role: "operator",
        createdAt: 1,
        disabledAt: null,
      },
      nodes: [node],
      directoryStatus: "ready",
    });
  });

/** The capture time is the one field of a saved record that depends on the clock. */
const stableRecord = (record: unknown) => {
  const saved = record as { metadata: { capturedAt: number } };
  return { ...saved, metadata: { ...saved.metadata, capturedAt: 0 } };
};

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
  it("re-encrypts nothing when hosted store patches change nothing the cache holds", async () => {
    hostedHubController.resetForTests();
    await setHostedReadCacheEnabled(true);
    const vault = getHostedReadVault();
    const write = vi.spyOn(vault, "write");
    const node = {
      id: "node_bbbbbbbbbbbbbbbbbbbbbb",
      environmentId: EnvironmentId.make("env_bbbbbbbbbbbbbbbbbbbbbb"),
      label: "Quiet Mac",
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
    await bootstrapWithHostedReadCache(async () => {
      hostedHubStore.setState({
        accountStatus: "authenticated",
        account: {
          id: "quiet-account",
          displayName: "Quiet account",
          role: "operator",
          createdAt: 1,
          disabledAt: null,
        },
        nodes: [node],
        directoryStatus: "ready",
      });
    });
    await vi.waitFor(() =>
      expect(write.mock.calls.filter((call) => call[1] === "catalog")).toHaveLength(1),
    );
    const published = readHostedReadCache();
    // A connect's worth of lifecycle patches: nothing in the catalog changes.
    for (const transportStatus of ["requesting-ticket", "connecting", "online"] as const) {
      hostedHubStore.setState({ transportStatus });
    }
    hostedHubStore.setState({ nodes: [{ ...node }] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(write.mock.calls.filter((call) => call[1] === "catalog")).toHaveLength(1);
    expect(readHostedReadCache()).toBe(published);
    // A renamed node is a real change: published and written once.
    hostedHubStore.setState({ nodes: [{ ...node, label: "Renamed Mac" }] });
    await vi.waitFor(() =>
      expect(write.mock.calls.filter((call) => call[1] === "catalog")).toHaveLength(2),
    );
    expect(readHostedReadCache().nodes[0]?.label).toBe("Renamed Mac");
    write.mockRestore();
    hostedHubStore.setState({ accountStatus: "signing-out" });
    await vi.waitFor(() => expect(readHostedReadCache().accountId).toBeNull());
    await setHostedReadCacheEnabled(false);
    hostedHubController.resetForTests();
  });
  it("rewrites only the environment whose own inputs changed", async () => {
    hostedHubController.resetForTests();
    await setHostedReadCacheEnabled(true);
    const vault = getHostedReadVault();
    const write = vi.spyOn(vault, "write");
    const workspaces = (["a", "b"] as const).map((letter) => {
      const environmentId = EnvironmentId.make(`env_${letter.repeat(22)}`);
      const projectId = ProjectId.make(`project-${letter}`);
      const threadId = ThreadId.make(`thread-${letter}`);
      const metadata: WorkspaceMetadataSnapshot = {
        schemaVersion: 1,
        environmentId,
        capturedAt: 1,
        projects: [
          {
            environmentId,
            id: projectId,
            name: `Project ${letter}`,
            cwd: `/${letter}`,
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
            title: `Thread ${letter}`,
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
      useStore
        .getState()
        .hydrateEnvironmentStateFromCache(
          workspaceMetadataToCachedShellSnapshot(metadata),
          environmentId,
        );
      // Live, as after the node's shell snapshot: the cache saves live state only.
      useStore.setState((state) => ({
        environmentStateById: {
          ...state.environmentStateById,
          [environmentId]: {
            ...state.environmentStateById[environmentId]!,
            bootstrapComplete: true,
          },
        },
      }));
      return {
        environmentId,
        ref: { environmentId, threadId },
        node: {
          id: `node_${letter.repeat(22)}`,
          environmentId,
          label: `Mac ${letter}`,
          platformOs: "darwin" as const,
          platformArch: "arm64" as const,
          clientVersion: "1",
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1,
          revokedAt: null,
          revocationReasonCode: null,
          grant: { id: `grant-${letter}`, role: "operator" as const },
          effectiveRole: "operator" as const,
          presence: { online: true, lastHeartbeatAt: 1 },
        },
      };
    });
    const [first, second] = workspaces as [(typeof workspaces)[0], (typeof workspaces)[0]];
    const recordWrites = (environmentId: EnvironmentId) =>
      write.mock.calls.filter((call) => call[1] === environmentId).length;
    await bootstrapWithHostedReadCache(async () => {
      hostedHubStore.setState({
        accountStatus: "authenticated",
        account: {
          id: "two-node-account",
          displayName: "Two nodes",
          role: "operator",
          createdAt: 1,
          disabledAt: null,
        },
        nodes: workspaces.map((workspace) => workspace.node),
        directoryStatus: "ready",
      });
    });
    await vi.waitFor(
      () => {
        expect(recordWrites(first.environmentId)).toBe(1);
        expect(recordWrites(second.environmentId)).toBe(1);
      },
      { timeout: 5_000 },
    );
    const settle = () => new Promise((resolve) => setTimeout(resolve, 3_000));

    // A scroll in one environment's thread rewrites that record alone.
    saveHostedThreadScroll(scopedThreadKey(first.ref), 120);
    await vi.waitFor(() => expect(recordWrites(first.environmentId)).toBe(2), {
      timeout: 5_000,
    });
    await settle();
    expect(recordWrites(second.environmentId)).toBe(1);

    // The timeline re-reporting the same position (every streaming render)
    // writes nothing.
    saveHostedThreadScroll(scopedThreadKey(first.ref), 120);
    await settle();
    expect(recordWrites(first.environmentId)).toBe(2);

    // A draft typed in one environment leaves the other's record alone.
    useComposerDraftStore.getState().setPrompt(second.ref, "Typed on b");
    await vi.waitFor(() => expect(recordWrites(second.environmentId)).toBe(2), {
      timeout: 5_000,
    });
    await settle();
    expect(recordWrites(first.environmentId)).toBe(2);

    // Opening a thread (kept last when a record is trimmed) rewrites only the
    // record it belongs to, and leaving it again only that one too. Any store
    // change schedules the save.
    const testPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    try {
      window.history.replaceState(
        window.history.state,
        "",
        `/${first.environmentId}/${first.ref.threadId}`,
      );
      useStore.setState({});
      await vi.waitFor(() => expect(recordWrites(first.environmentId)).toBe(3), {
        timeout: 5_000,
      });
      await settle();
      expect(recordWrites(second.environmentId)).toBe(2);
    } finally {
      window.history.replaceState(window.history.state, "", testPath);
    }
    useStore.setState({});
    await vi.waitFor(() => expect(recordWrites(first.environmentId)).toBe(4), {
      timeout: 5_000,
    });
    await settle();
    expect(recordWrites(second.environmentId)).toBe(2);

    write.mockRestore();
    useComposerDraftStore.getState().setPrompt(second.ref, "");
    hostedHubStore.setState({ accountStatus: "signing-out" });
    await vi.waitFor(() => expect(readHostedReadCache().accountId).toBeNull());
    for (const workspace of workspaces) {
      useStore.getState().removeEnvironmentState(workspace.environmentId);
    }
    await setHostedReadCacheEnabled(false);
    hostedHubController.resetForTests();
  }, 30_000);
  it("writes the record it always has for a fixture workspace", async () => {
    hostedHubController.resetForTests();
    await setHostedReadCacheEnabled(true);
    const vault = getHostedReadVault();
    const write = vi.spyOn(vault, "write");
    const open = ThreadId.make("thread-open");
    const recent = ThreadId.make("thread-recent");
    const oldest = ThreadId.make("thread-oldest");
    const blank = ThreadId.make("thread-blank");
    const never = ThreadId.make("thread-never");
    const workspace = seedCachedWorkspace("c", [
      { id: open, messages: [fixtureMessage("open-1", "Open thread answer")] },
      {
        id: recent,
        messages: [
          { ...fixtureMessage("recent-1", "A question"), role: "user" },
          fixtureMessage("recent-2", "Longer answer: naïve 日本語 😀", {
            completedAt: "2026-10-01T00:01:00Z",
            turnId: TurnId.make("turn-recent"),
          }),
        ],
      },
      { id: oldest, messages: [fixtureMessage("oldest-1", "Seen long ago")] },
      { id: blank, messages: [] },
      { id: never, messages: [fixtureMessage("never-1", "Never opened")] },
    ]);
    const { environmentId } = workspace;
    const key = (threadId: ThreadId) => scopedThreadKey({ environmentId, threadId });
    const recordWrites = () => write.mock.calls.filter((call) => call[1] === environmentId);
    await bootstrapAuthenticatedFixture("fixture-account", workspace.node);
    await vi.waitFor(() => expect(recordWrites()).toHaveLength(1), { timeout: 5_000 });

    // Visits order the threads (never-visited first, the routed one last), and
    // a draft and a scroll position ride along in the record.
    useUiStateStore.setState({
      threadLastVisitedAtById: {
        [key(open)]: "2026-10-02T00:00:00Z",
        [key(recent)]: "2026-10-03T00:00:00Z",
        [key(oldest)]: "2026-10-01T00:00:00Z",
      },
    });
    useComposerDraftStore.getState().setPrompt({ environmentId, threadId: open }, "Typed draft");
    saveHostedThreadScroll(key(recent), 120);
    const testPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    try {
      window.history.replaceState(window.history.state, "", `/${environmentId}/${open}`);
      useStore.setState({});
      await vi.waitFor(
        () => {
          const record = stableRecord(recordWrites().at(-1)![2]);
          // The content, drafts and scroll positions are the pre-change output
          // byte for byte, key order included; the workspace metadata is not
          // something the content policy touches and passes through.
          expect(JSON.stringify(record)).toBe(
            JSON.stringify({
              metadata: record.metadata,
              content: {
                [never]: {
                  messages: [
                    {
                      id: "never-1",
                      role: "assistant",
                      text: "Never opened",
                      createdAt: "2026-10-01T00:00:00Z",
                      turnId: null,
                      streaming: false,
                    },
                  ],
                },
                [oldest]: {
                  messages: [
                    {
                      id: "oldest-1",
                      role: "assistant",
                      text: "Seen long ago",
                      createdAt: "2026-10-01T00:00:00Z",
                      turnId: null,
                      streaming: false,
                    },
                  ],
                },
                [recent]: {
                  messages: [
                    {
                      id: "recent-1",
                      role: "user",
                      text: "A question",
                      createdAt: "2026-10-01T00:00:00Z",
                      turnId: null,
                      streaming: false,
                    },
                    {
                      id: "recent-2",
                      role: "assistant",
                      text: "Longer answer: naïve 日本語 😀",
                      createdAt: "2026-10-01T00:00:00Z",
                      completedAt: "2026-10-01T00:01:00Z",
                      turnId: "turn-recent",
                      streaming: false,
                    },
                  ],
                },
                [open]: {
                  messages: [
                    {
                      id: "open-1",
                      role: "assistant",
                      text: "Open thread answer",
                      createdAt: "2026-10-01T00:00:00Z",
                      turnId: null,
                      streaming: false,
                    },
                  ],
                },
              },
              drafts: { [key(open)]: "Typed draft" },
              draftSessions: {},
              scroll: { [key(recent)]: 120 },
            }),
          );
        },
        { timeout: 8_000 },
      );
    } finally {
      window.history.replaceState(window.history.state, "", testPath);
    }

    write.mockRestore();
    useComposerDraftStore.getState().setPrompt({ environmentId, threadId: open }, "");
    useUiStateStore.setState({ threadLastVisitedAtById: {} });
    hostedHubStore.setState({ accountStatus: "signing-out" });
    await vi.waitFor(() => expect(readHostedReadCache().accountId).toBeNull());
    useStore.getState().removeEnvironmentState(environmentId);
    await setHostedReadCacheEnabled(false);
    hostedHubController.resetForTests();
  }, 30_000);
  it("trims to the record budget by bytes, least recently visited first and the open thread last", async () => {
    hostedHubController.resetForTests();
    await setHostedReadCacheEnabled(true);
    const vault = getHostedReadVault();
    const write = vi.spyOn(vault, "write");
    const open = ThreadId.make("thread-a");
    const middle = ThreadId.make("thread-b");
    const recent = ThreadId.make("thread-c");
    // Each answer is 400,000 characters but about 800,000 bytes, so only two
    // fit the budget; by character count all three would.
    const workspace = seedCachedWorkspace(
      "d",
      [open, middle, recent].map((id) => ({
        id,
        messages: [fixtureMessage(`${id}-1`, "é".repeat(400_000))],
      })),
    );
    const { environmentId } = workspace;
    const key = (threadId: ThreadId) => scopedThreadKey({ environmentId, threadId });
    const recordWrites = () => write.mock.calls.filter((call) => call[1] === environmentId);
    await bootstrapAuthenticatedFixture("budget-account", workspace.node);
    await vi.waitFor(() => expect(recordWrites().length).toBeGreaterThan(0), { timeout: 8_000 });

    useUiStateStore.setState({
      threadLastVisitedAtById: {
        [key(open)]: "2026-10-01T00:00:00Z",
        [key(middle)]: "2026-10-02T00:00:00Z",
        [key(recent)]: "2026-10-03T00:00:00Z",
      },
    });
    const testPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    try {
      window.history.replaceState(window.history.state, "", `/${environmentId}/${open}`);
      useStore.setState({});
      await vi.waitFor(
        () =>
          expect(Object.keys((recordWrites().at(-1)![2] as { content: object }).content)).toEqual([
            recent,
            open,
          ]),
        { timeout: 10_000 },
      );
    } finally {
      window.history.replaceState(window.history.state, "", testPath);
    }
    const saved = recordWrites().at(-1)![2] as { content: Record<string, unknown> };
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
    // As full as the budget allows: it fits, and the dropped thread would not.
    const droppedEntry = bytes({ [middle]: saved.content[recent] }) - 2;
    expect(bytes(saved)).toBeLessThanOrEqual(1_900_000);
    expect(bytes(saved) + droppedEntry + 1).toBeGreaterThan(1_900_000);

    write.mockRestore();
    useUiStateStore.setState({ threadLastVisitedAtById: {} });
    hostedHubStore.setState({ accountStatus: "signing-out" });
    await vi.waitFor(() => expect(readHostedReadCache().accountId).toBeNull());
    useStore.getState().removeEnvironmentState(environmentId);
    await setHostedReadCacheEnabled(false);
    hostedHubController.resetForTests();
  }, 40_000);
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
    // The boot gate preloads the workspace shell whenever a preview can show,
    // so the cached route renders on the root's first pass.
    await preloadHostedRootAppShell();
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
    // The node's own session completed its relay attempt and accepted a
    // current shell snapshot; the shared session fields show it once selected.
    const sessions = getHostedEnvironmentSessions();
    const { generation } = sessions.ensureRecord(node);
    sessions.markConnectRequested(environmentId, generation);
    sessions.transportStatus(environmentId, generation, "online");
    sessions.markSessionReady(environmentId, generation);
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
      browserStatus: "current",
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
    getHostedEnvironmentSessions().clear();
  });
});

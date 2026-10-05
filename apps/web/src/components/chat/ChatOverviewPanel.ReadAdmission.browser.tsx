import { EnvironmentId } from "@ryco/contracts";
import { hostedHubStore } from "@ryco/client-runtime/authorization";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";

vi.mock("~/localApi", () => ({
  readLocalApi: () => undefined,
  ensureLocalApi: () => undefined,
  requireLocalApi: () => {
    throw new Error("Local API unavailable");
  },
}));

const { getDetail, mode, addToast } = vi.hoisted(() => ({
  getDetail: vi.fn(),
  mode: { hosted: false },
  addToast: vi.fn(),
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: addToast },
  stackedThreadToast: (input: unknown) => input,
}));
vi.mock("~/env", () => ({
  isElectron: false,
  readRycoClientMode: () => (mode.hosted ? "hosted-hub" : "standard"),
  readMobileAppUrl: () => null,
  isPhoneAppInterstitialEnabled: () => false,
  isHostedHubMode: () => mode.hosted,
}));
vi.mock("~/environments/runtime", () => ({
  readEnvironmentConnection: () => null,
  resolveEnvironmentHttpUrl: (_environmentId: unknown, path: string) => path,
  getEnvironmentHttpBaseUrl: () => "http://localhost",
  getSavedEnvironmentRecord: () => null,
  getSavedEnvironmentRuntimeState: () => null,
  hasSavedEnvironmentRegistryHydrated: () => true,
  listEnvironmentConnections: () => [],
  listSavedEnvironmentRecords: () => [],
  resetEnvironmentServiceForTests: () => {},
  resetSavedEnvironmentRegistryStoreForTests: () => {},
  resetSavedEnvironmentRuntimeStoreForTests: () => {},
  subscribeEnvironmentConnections: () => () => {},
  useSavedEnvironmentRegistryStore: (select: (state: unknown) => unknown) => select({ byId: {} }),
  useSavedEnvironmentRuntimeStore: (select: (state: unknown) => unknown) => select({ byId: {} }),
  getPrimaryEnvironmentConnection: () => null,
  requireEnvironmentConnection: () => ({
    client: { sourceControl: { getChangeRequestDetail: getDetail } },
  }),
}));
vi.mock("~/hooks/useSettings", () => ({
  useSettings: (select: (settings: unknown) => unknown) =>
    select({ sourceControlRefreshMode: "manual" }),
}));
vi.mock("~/lib/gitStatusState", () => ({ useGitStatus: () => ({ data: null }) }));
vi.mock("../GitActionsControl", () => ({ default: () => null }));
vi.mock("../BranchToolbarBranchSelector", () => ({ BranchToolbarBranchSelector: () => null }));
vi.mock("../PlanSidebar", () => ({
  default: ({ pullRequest }: { pullRequest: { title: string } | null }) => (
    <div>{pullRequest?.title}</div>
  ),
}));

import { ChatOverviewPanel } from "./ChatOverviewPanel";
import {
  changeRequestDetailBinding,
  resetSourceControlAtomsForTests,
} from "~/rpc/sourceControlAtoms";

const environmentId = EnvironmentId.make("overview-read-admission");
let mounted: Awaited<ReturnType<typeof render>> | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  resetSourceControlAtomsForTests();
  hostedHubStore.setState(hostedHubStore.getInitialState(), true);
  vi.restoreAllMocks();
});

function makeLive(generation: number) {
  hostedHubStore.setState({
    account: { id: "account-a" } as never,
    session: { id: "session-a" } as never,
    nodes: [
      {
        id: String(environmentId),
        environmentId,
        effectiveRole: "operator",
        revokedAt: null,
        presence: { online: true, lastHeartbeatAt: 1 },
      },
    ] as never,
    accountStatus: "authenticated",
    directoryStatus: "ready",
    browserStatus: "current",
    transportStatus: "online",
    sessionStatus: "ready",
    effectiveRole: "operator",
    generation,
    selectedNode: {
      id: "node-a",
      environmentId,
      presence: { online: true, lastHeartbeatAt: 1 },
    } as never,
  });
}
function overview() {
  return (
    <ChatOverviewPanel
      environmentId={environmentId}
      gitCwd="/workspace"
      activeWorktreeBranch="pr-1"
      activeThreadBranch="pr-1"
      activeWorktreePrNumber={1}
      activeWorktreePrState="merged"
      activeWorktreePrIsDraft={false}
      activeWorktreeTitle="Cached pull request"
      activeThreadKey="thread-1"
      activeEnvironmentUnavailableState={null}
      activePlan={null}
      sidebarProposedPlan={null}
      threadSubagents={[]}
      sourceControlActions={() => null}
      branchControl={null}
      markdownCwd={undefined}
      workspaceRoot={undefined}
      mode="sidebar"
      onOpenFiles={() => {}}
      onOpenReview={() => {}}
      onOpenSubagent={() => {}}
      postPushWorkflowWatch={null}
      onPostPushDiscoveryComplete={() => {}}
    />
  );
}

describe("PR overview in a hosted cached preview", () => {
  it("does not query or toast while cached, suppresses the old connection failure, and resumes the mounted overview", async () => {
    resetSourceControlAtomsForTests();
    mode.hosted = true;
    makeLive(1);
    hostedHubStore.setState({ transportStatus: "idle", sessionStatus: "stale" });
    addToast.mockReset();
    let rejectOld = (_error: Error) => {};
    getDetail.mockReset().mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectOld = reject;
        }),
    );
    mounted = await render(<AppAtomRegistryProvider>{overview()}</AppAtomRegistryProvider>);
    expect(getDetail).not.toHaveBeenCalled();
    expect(addToast).not.toHaveBeenCalled();
    makeLive(2);
    await expect.poll(() => getDetail.mock.calls.length).toBe(1);
    hostedHubStore.setState({ transportStatus: "reconnecting", sessionStatus: "stale" });
    rejectOld(new Error("Connection closed"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(addToast).not.toHaveBeenCalled();
    getDetail.mockResolvedValue({
      number: 1,
      title: "Fresh pull request",
      provider: "bitbucket",
      state: "merged",
      comments: [],
      checkRollup: [],
      headSha: null,
    });
    makeLive(3);
    await expect.poll(() => getDetail.mock.calls.length).toBe(2);
    await expect
      .poll(
        () =>
          changeRequestDetailBinding.snapshotFor({
            environmentId,
            cwd: "/workspace",
            reference: "1",
          }).data?.title,
      )
      .toBe("Fresh pull request");
    await expect.element(mounted.getByText("Fresh pull request")).toBeVisible();
    expect(getDetail).toHaveBeenCalledTimes(2);
    expect(addToast).not.toHaveBeenCalled();
  });
});

import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type EffectiveProjectPreferences,
  type EnvironmentApi,
  type ServerConfig,
} from "@ryco/contracts";
import { scopedProjectKey } from "@ryco/client-runtime/scoped";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

const navigate = vi.fn(async () => undefined);
const router = { state: { matches: [] }, navigate };
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useRouter: () => router,
}));
vi.mock("../hooks/useSettings", () => ({
  getClientSettings: () => DEFAULT_CLIENT_SETTINGS,
  useClientSettingsHydrated: () => true,
  useSettings: (selector: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    selector(DEFAULT_CLIENT_SETTINGS),
  useUpdateSettings: () => vi.fn(),
  updateClientModelFavorites: vi.fn(),
  __resetClientSettingsPersistenceForTests: vi.fn(),
}));

import { useComposerDraftStore } from "../composerDraftStore";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../environmentApi";
import {
  resetPrimaryEnvironmentDescriptorForTests,
  writePrimaryEnvironmentDescriptor,
} from "../environments/primary/context";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { resetServerStateForTests, setServerConfigSnapshot } from "../rpc/serverState";
import { useStore } from "../store";

const canonicalId = EnvironmentId.make("environment-canonical");
const localId = EnvironmentId.make("environment-node-local");
const savedId = EnvironmentId.make("environment-saved");
const projectId = ProjectId.make("project-draft-defaults");

function config(environmentId: EnvironmentId): ServerConfig {
  return {
    environment: {
      environmentId,
      label: "Studio Mac",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.0-test",
      capabilities: {
        repositoryIdentity: true,
        threadSettlement: false,
        threadPriorityRanking: false,
        projectPreferences: true,
      },
    },
    auth: {
      policy: "loopback-browser",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["browser-session-cookie"],
      sessionCookieName: "ryco_session",
    },
    cwd: "/repo/project",
    keybindingsConfigPath: "/repo/keybindings.json",
    keybindings: [],
    issues: [],
    providers: [],
    availableEditors: [],
    observability: {
      logsDirectoryPath: "/repo/logs",
      localTracingEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: { ...DEFAULT_SERVER_SETTINGS, defaultAgentTokenMode: "balanced" },
  };
}

const effective: EffectiveProjectPreferences = {
  initialModelSelection: {
    value: { instanceId: ProviderInstanceId.make("codex"), model: "project-model" },
    source: "project",
  },
  defaultThreadEnvMode: { value: "worktree", source: "project" },
  worktreeBranchPrefix: { value: "tasks", source: "node" },
  runSetupScript: { value: false, source: "project" },
  worktreeRoot: { value: ".worktrees", source: "node" },
  overrides: {},
};

function NewDraft({ environmentId }: { environmentId: EnvironmentId }) {
  const { handleNewThread } = useNewThreadHandler();
  return (
    <button onClick={() => void handleNewThread({ environmentId, projectId })}>New draft</button>
  );
}

let mounted: Awaited<ReturnType<typeof render>> | null = null;
beforeEach(() => {
  localStorage.clear();
  navigate.mockClear();
  useStore.setState({ activeEnvironmentId: null, environmentStateById: {} });
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  resetPrimaryEnvironmentDescriptorForTests();
  resetServerStateForTests();
  __resetEnvironmentApiOverridesForTests();
});

describe("draft settings for canonical environment identities", () => {
  it.each([localId, canonicalId])(
    "creates a primary draft with project defaults when the config advertises %s",
    async (advertisedId) => {
      const primaryConfig = config(advertisedId);
      writePrimaryEnvironmentDescriptor({
        ...primaryConfig.environment,
        environmentId: canonicalId,
      });
      setServerConfigSnapshot(primaryConfig);
      const readPreferences = vi.fn(async () => effective);
      const readConfig = vi.fn(async () => primaryConfig);
      __setEnvironmentApiOverrideForTests(canonicalId, {
        server: { getConfig: readConfig, getProjectPreferences: readPreferences },
      } as unknown as EnvironmentApi);
      mounted = await render(<NewDraft environmentId={canonicalId} />);

      await page.getByRole("button", { name: "New draft" }).click();
      await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
      expect(readPreferences).toHaveBeenCalledWith({ projectId });
      expect(readConfig).toHaveBeenCalledOnce();
      const draft = useComposerDraftStore
        .getState()
        .getDraftSessionByLogicalProjectKey(
          scopedProjectKey({ environmentId: canonicalId, projectId }),
        );
      expect(draft).toMatchObject({
        environmentId: canonicalId,
        envMode: "worktree",
        tokenMode: "balanced",
      });
      expect(
        useComposerDraftStore.getState().getComposerDraft(draft!.draftId)?.modelSelectionByProvider[
          ProviderInstanceId.make("codex")
        ],
      ).toMatchObject({
        model: "project-model",
      });
    },
  );

  it("uses the target connection's settings while another node's configuration is cached", async () => {
    const primaryConfig = config(localId);
    const savedConfig = config(savedId);
    writePrimaryEnvironmentDescriptor({ ...primaryConfig.environment, environmentId: canonicalId });
    setServerConfigSnapshot(primaryConfig);
    const readPrimaryConfig = vi.fn(async () => primaryConfig);
    const readSavedConfig = vi.fn(async () => ({
      ...savedConfig,
      settings: { ...savedConfig.settings, defaultAgentTokenMode: "aggressive" as const },
    }));
    __setEnvironmentApiOverrideForTests(canonicalId, {
      server: { getConfig: readPrimaryConfig },
    } as unknown as EnvironmentApi);
    __setEnvironmentApiOverrideForTests(savedId, {
      server: { getConfig: readSavedConfig, getProjectPreferences: async () => effective },
    } as unknown as EnvironmentApi);
    mounted = await render(<NewDraft environmentId={savedId} />);

    await page.getByRole("button", { name: "New draft" }).click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    expect(readPrimaryConfig).not.toHaveBeenCalled();
    expect(readSavedConfig).toHaveBeenCalledOnce();
    expect(
      useComposerDraftStore
        .getState()
        .getDraftSessionByLogicalProjectKey(
          scopedProjectKey({ environmentId: savedId, projectId }),
        ),
    ).toMatchObject({ environmentId: savedId, tokenMode: "aggressive" });
  });

  it("waits for target settings before creating a draft", async () => {
    const targetConfig = config(localId);
    writePrimaryEnvironmentDescriptor({ ...targetConfig.environment, environmentId: canonicalId });
    let resolveConfig!: (config: ServerConfig) => void;
    const pendingConfig = new Promise<ServerConfig>((resolve) => {
      resolveConfig = resolve;
    });
    const readConfig = vi.fn(() => pendingConfig);
    __setEnvironmentApiOverrideForTests(canonicalId, {
      server: { getConfig: readConfig, getProjectPreferences: async () => effective },
    } as unknown as EnvironmentApi);
    mounted = await render(<NewDraft environmentId={canonicalId} />);
    await page.getByRole("button", { name: "New draft" }).click();
    await vi.waitFor(() => expect(readConfig).toHaveBeenCalledOnce());
    expect(navigate).not.toHaveBeenCalled();
    expect(useComposerDraftStore.getState().draftThreadsByThreadKey).toEqual({});
    resolveConfig(targetConfig);
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
  });
});
